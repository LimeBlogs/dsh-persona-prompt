#!/usr/bin/env node
/**
 * Persona-prompt smoke-test helper.
 *
 * The Host API and session logs are the two observable surfaces, so this script
 * only talks to those: it saves/resets state through `/dsh-persona-prompt/api`
 * and reads real Session logs (zstd frames) to prove what each Agent actually
 * received. Spawning the agents themselves stays with the caller (the model's
 * `subagent` / `subagent_fork` tools), so the test exercises the real loop.
 *
 * Usage:
 *   node test/smoke.mjs state
 *   node test/smoke.mjs save <identity> <persona> <on|off>
 *   node test/smoke.mjs reset
 *   node test/smoke.mjs scan <since-ms> [marker]
 *   node test/smoke.mjs check <session.v4.jsonl.zstd> [marker]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const BASE = process.env.DSH_PERSONA_PROMPT_URL ?? 'http://127.0.0.1:59975'
const API = `${BASE}/dsh-persona-prompt/api`
const HEADERS = { 'x-dsh-plugin': 'dsh-persona-prompt' }
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function frameOffsets(buf) {
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offsets.push(i)
  }
  return offsets
}

function readEntries(file) {
  const buf = readFileSync(file)
  const seen = new Set()
  const entries = []
  for (const offset of frameOffsets(buf)) {
    let text
    try {
      text = zstdDecompressSync(buf.subarray(offset)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('{')) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const key = `${entry.type}:${entry.seq}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }
  entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return entries
}

function systemText(entry) {
  const content = entry.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (typeof block === 'string' ? block : block?.text ?? '')).join('')
}

function inspectSession(file) {
  const entries = readEntries(file)
  const header = entries.find((entry) => entry.type === 'session') ?? {}
  const systems = entries
    .filter((entry) => entry.type === 'system/message')
    .map((entry) => systemText(entry))
  return {
    file,
    header: {
      id: header.id,
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? 0,
      parentSession: header.parentSession ?? null,
      isSeeded: header.isSeeded ?? null,
      agentPreset: header.agentPreset ?? null,
    },
    systemCount: systems.length,
    firstSystem: systems[0] ?? '',
    systems,
  }
}

function findSessionFiles(dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name)
    if (name.isDirectory()) findSessionFiles(path, out)
    else if (name.name === 'session.v4.jsonl.zstd') out.push(path)
  }
  return out
}

async function api(method, body) {
  const response = await fetch(API, {
    method,
    headers: body === undefined ? HEADERS : { ...HEADERS, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  if (!response.ok || payload.ok !== true) throw new Error(payload.message ?? `HTTP ${response.status}`)
  return payload.value
}

function markerReport(report, marker) {
  const first = report.systems[0] ?? ''
  const last = report.systems.at(-1) ?? ''
  return {
    marker,
    found: marker === undefined ? null : report.systems.some((system) => system.includes(marker)),
    foundLast: marker === undefined ? null : last.includes(marker),
    head: first.slice(0, 160).replace(/\n/g, '\\n'),
    lastHead: last.slice(0, 160).replace(/\n/g, '\\n'),
  }
}

const [command, ...args] = process.argv.slice(2)
if (command === 'state') {
  console.log(JSON.stringify(await api('GET'), null, 2))
} else if (command === 'save') {
  const [identity, personaPrefix, flag] = args
  const view = await api('POST', {
    action: 'save',
    identity: identity ?? '',
    personaPrefix: personaPrefix ?? '',
    applyToSubagents: flag === 'on',
  })
  console.log(JSON.stringify({
    applyToSubagents: view.applyToSubagents,
    identityLength: view.identity.length,
    personaLength: view.personaPrefix.length,
    updatedAt: view.updatedAt,
  }, null, 2))
} else if (command === 'reset') {
  const view = await api('POST', { action: 'reset' })
  console.log(JSON.stringify({
    applyToSubagents: view.applyToSubagents,
    identityLength: view.identity.length,
    personaLength: view.personaPrefix.length,
  }, null, 2))
} else if (command === 'check') {
  const [file, marker] = args
  const report = inspectSession(file)
  console.log(JSON.stringify({ header: report.header, systemCount: report.systemCount, ...markerReport(report, marker) }, null, 2))
} else if (command === 'scan') {
  const since = Number(args[0] ?? 0)
  const marker = args[1]
  const files = findSessionFiles(join(DSH_HOME, 'sessions'))
    .filter((file) => statSync(file).mtimeMs >= since)
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  const results = files.map((file) => {
    const report = inspectSession(file)
    return { mtime: statSync(file).mtimeMs, ...report.header, systemCount: report.systemCount, ...markerReport(report, marker) }
  })
  console.log(JSON.stringify({ since, count: results.length, sessions: results }, null, 2))
} else {
  console.error('commands: state | save <identity> <persona> <on|off> | reset | scan <since-ms> [marker] | check <session-file> [marker]')
  process.exitCode = 1
}

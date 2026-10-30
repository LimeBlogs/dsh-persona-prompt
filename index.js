/**
 * Host half of `dsh-persona-prompt`.
 *
 * Owns two system-prompt slots globally: `harness:identity` (order -1000) and
 * `deployment:persona-prefix` (order 0). The web page writes the override texts
 * through one same-origin route; every prompt assembly (global scope and every
 * agent scope, including subagents) is rewritten before it reaches the model.
 *
 * Why a waterfall instead of `ctx.systemPrompt.section()`: both names are
 * already registered by `@deepseek-ai/dsh-system-prompt` (and the persona name
 * is shadowed per agent by `@deepseek-ai/dsh-persona`). Registering the same
 * global name throws, and an agent-scoped registration would not be global.
 * The assembly waterfall is the only global place that sees the merged result.
 */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ROUTE = '/dsh-persona-prompt/api'
const PLUGIN_HEADER = 'x-dsh-plugin'
const PLUGIN_HEADER_VALUE = 'dsh-persona-prompt'

const IDENTITY_SECTION = 'harness:identity'
const PERSONA_SECTION = 'deployment:persona-prefix'
const DEFAULT_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

const STATE_VERSION = 1
const MAX_FIELD_CHARS = 100_000
const MAX_BODY_BYTES = 400_000
const VARIABLE_REF = /\{\{([a-z][a-z0-9_]*)\}\}/g

export const inject = ['systemPrompt', 'webServer']

/** Resolve the durable state file: one per DSH home, shared by every profile. */
function resolveStateFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'persona-prompt.json')
}

/** Best-effort logger; a plugin must never fail its host because logging failed. */
function makeLog(ctx) {
  return (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('persona-prompt') : undefined
      const sink = logger && typeof logger[level] === 'function' ? logger[level] : undefined
      if (sink) sink.call(logger, message)
    } catch {
      // logging is optional
    }
  }
}

/** Replace known `{{variable}}` references; unknown references stay literal. */
function resolveVariables(text, variables) {
  if (text.indexOf('{{') < 0) return text
  return text.replace(VARIABLE_REF, (match, name) => {
    if (!Object.hasOwn(variables, name)) return match
    const value = variables[name]
    return typeof value === 'string' ? value : match
  })
}

/**
 * Whether one assembly belongs to a subagent.
 *
 * The loop passes `{ agent, scope }` to `assemble()` (`assembleContextFor`), so
 * the live Agent's immutable SessionHeader is available even though the public
 * `AssembleContext` type does not mention it. DSH marks delegated children with
 * `origin: 'subagent'` (and a delegation depth); a forked session also carries
 * `parentSession` but is a top-level conversation, not a subagent, so lineage
 * alone must not exclude it.
 */
function isSubagentAssembly(context) {
  const header = context?.agent?.session?.header
  if (header === null || typeof header !== 'object') return false
  return header.origin === 'subagent'
    || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

/** Normalize one user-editable field, or throw a statusError-shaped 400. */
function normalizeField(value, field) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw Object.assign(new Error(`${field} must be a string`), { statusCode: 400 })
  }
  if (value.includes('\u0000')) {
    throw Object.assign(new Error(`${field} must not contain NUL characters`), { statusCode: 400 })
  }
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (text.length > MAX_FIELD_CHARS) {
    throw Object.assign(new Error(`${field} exceeds ${MAX_FIELD_CHARS} characters`), { statusCode: 400 })
  }
  return text
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readBoundedBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

export function apply(ctx) {
  const file = resolveStateFile()
  const log = makeLog(ctx)

  /** Raw texts seen in the last root-agent assembly, used by the settings page as defaults. */
  const samples = { identity: '', personaPrefix: '' }
  let loadWarning = null
  let state = { identity: '', personaPrefix: '', applyToSubagents: false, updatedAt: null }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      state = {
        identity: typeof parsed.identity === 'string' ? parsed.identity : '',
        personaPrefix: typeof parsed.personaPrefix === 'string' ? parsed.personaPrefix : '',
        applyToSubagents: parsed.applyToSubagents === true,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      loadWarning = String(error?.message ?? error)
      log('warn', `could not read ${file}: ${loadWarning}`)
    }
  }

  const view = () => {
    const sampleIdentity = samples.identity || DEFAULT_IDENTITY
    const samplePersona = samples.personaPrefix
    return {
      identity: state.identity,
      personaPrefix: state.personaPrefix,
      applyToSubagents: state.applyToSubagents,
      sample: { identity: sampleIdentity, personaPrefix: samplePersona },
      effective: {
        identity: state.identity !== '' ? state.identity : sampleIdentity,
        personaPrefix: state.personaPrefix !== '' ? state.personaPrefix : samplePersona,
      },
      path: file,
      updatedAt: state.updatedAt,
      loadWarning,
    }
  }

  const persist = async (next) => {
    const payload = {
      version: STATE_VERSION,
      identity: next.identity,
      personaPrefix: next.personaPrefix,
      applyToSubagents: next.applyToSubagents === true,
      updatedAt: Date.now(),
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    state = {
      identity: payload.identity,
      personaPrefix: payload.personaPrefix,
      applyToSubagents: payload.applyToSubagents,
      updatedAt: payload.updatedAt,
    }
    loadWarning = null
    return view()
  }

  // ---------------------------------------------------------------- prompt
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    try {
      const sections = Array.isArray(result?.sections) ? result.sections : []
      const variables = result?.variables !== null && typeof result?.variables === 'object' ? result.variables : {}
      const subagent = isSubagentAssembly(context)

      const identitySection = sections.find((section) => section?.name === IDENTITY_SECTION)
      const personaSection = sections.find((section) => section?.name === PERSONA_SECTION)
      if (!subagent) {
        // The settings page's "original text" belongs to top-level conversations;
        // a child preset must not replace it in the UI.
        if (identitySection !== undefined && typeof identitySection.text === 'string') {
          samples.identity = identitySection.text
        }
        if (personaSection !== undefined && typeof personaSection.text === 'string') {
          samples.personaPrefix = personaSection.text
        }
      }

      if (subagent && !state.applyToSubagents) return result

      if (state.identity !== '') {
        const text = resolveVariables(state.identity, variables)
        if (identitySection !== undefined) {
          identitySection.text = text
          identitySection.interpolate = false
        } else {
          sections.unshift({ name: IDENTITY_SECTION, text, interpolate: false })
        }
      }

      if (state.personaPrefix !== '') {
        const text = resolveVariables(state.personaPrefix, variables)
        if (personaSection !== undefined) {
          personaSection.text = text
          personaSection.interpolate = false
        } else {
          // Order 0 follows the identity slot and precedes every first-party
          // guidance section; the assembled section list carries no order, so
          // insert right after the identity section.
          const index = sections.findIndex((section) => section?.name === IDENTITY_SECTION)
          sections.splice(index < 0 ? 0 : index + 1, 0, { name: PERSONA_SECTION, text, interpolate: false })
        }
      }
    } catch (error) {
      log('warn', `prompt override failed: ${String(error?.message ?? error)}`)
    }
    return result
  })

  // ----------------------------------------------------------------- route
  const handle = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST')
      res.end()
      return
    }
    // A custom header is the CSRF boundary: a cross-origin page cannot send it
    // without a preflight this server does not answer.
    if (req.headers[PLUGIN_HEADER] !== PLUGIN_HEADER_VALUE) {
      res.statusCode = 403
      res.end('missing plugin header')
      return
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, value: view() })
      return
    }

    const type = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!type.includes('application/json')) {
      res.statusCode = 415
      res.end('expected application/json')
      return
    }

    let body
    try {
      const raw = await readBoundedBody(req)
      body = raw.trim() === '' ? {} : JSON.parse(raw)
    } catch (error) {
      sendJson(res, Number(error?.statusCode) === 413 ? 413 : 400, {
        ok: false,
        message: Number(error?.statusCode) === 413 ? 'request body too large' : 'request body is not valid JSON',
      })
      return
    }

    const action = typeof body?.action === 'string' ? body.action : 'state'
    if (action === 'state') {
      sendJson(res, 200, { ok: true, value: view() })
      return
    }
    if (action === 'reset') {
      sendJson(res, 200, {
        ok: true,
        value: await persist({
          identity: '',
          personaPrefix: '',
          applyToSubagents: state.applyToSubagents,
        }),
      })
      return
    }
    if (action === 'reset-field') {
      const field = body?.field
      if (field !== 'identity' && field !== 'personaPrefix') {
        sendJson(res, 400, { ok: false, message: 'field must be "identity" or "personaPrefix"' })
        return
      }
      const next = {
        identity: state.identity,
        personaPrefix: state.personaPrefix,
        applyToSubagents: state.applyToSubagents,
      }
      next[field] = ''
      sendJson(res, 200, { ok: true, value: await persist(next) })
      return
    }
    if (action === 'save') {
      try {
        const identity = normalizeField(body?.identity, 'identity')
        const personaPrefix = normalizeField(body?.personaPrefix, 'personaPrefix')
        if (body?.applyToSubagents !== undefined && typeof body.applyToSubagents !== 'boolean') {
          sendJson(res, 400, { ok: false, message: 'applyToSubagents must be a boolean' })
          return
        }
        const applyToSubagents = typeof body?.applyToSubagents === 'boolean'
          ? body.applyToSubagents
          : state.applyToSubagents
        sendJson(res, 200, { ok: true, value: await persist({ identity, personaPrefix, applyToSubagents }) })
      } catch (error) {
        sendJson(res, Number(error?.statusCode) === 400 ? 400 : 500, {
          ok: false,
          message: String(error?.message ?? error),
        })
      }
      return
    }
    sendJson(res, 400, { ok: false, message: `unknown action: ${action}` })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (req, res) => {
      handle(req, res).catch((error) => {
        log('warn', `settings route failed: ${String(error?.message ?? error)}`)
        if (!res.headersSent) sendJson(res, 500, { ok: false, message: 'internal error' })
        else res.end()
      })
    },
  }), 'persona-prompt: settings route')

  log('info', `settings route ready at ${ROUTE}; state file ${file}`)
}

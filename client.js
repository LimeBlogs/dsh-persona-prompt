/**
 * Client half of `dsh-persona-prompt`.
 *
 * Adds one page under Settings ("人设") that edits the two system-prompt slots
 * the Host plugin owns. All state lives on the Host; this module only renders a
 * form and talks to `/dsh-persona-prompt/api` with a same-origin fetch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-prompt',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'personaPrompt'
    const ROUTE = '/dsh-persona-prompt/api'
    const PLUGIN_HEADER = 'x-dsh-plugin'
    const PLUGIN_HEADER_VALUE = 'dsh-persona-prompt'

    // ------------------------------------------------------------- dictionaries
    const ZH = {
      'nav.label': '人设',
      'title': '人设提示词',
      'intro': '编辑注入到每次模型请求最前面的两段系统提示词。默认只改写主会话；打开下方开关后，子代理也会使用同一份文本。',
      'banner': '全局生效 · 下一次模型请求开始使用新文本',
      'subagent.toggle': '同时注入子代理',
      'subagent.desc': '关闭时只改写主会话；子代理保留自己预设的人设与身份。',
      'identity.name': 'HARNESS_IDENTITY',
      'identity.sub': '系统身份行 · system prompt 最前（order -1000）',
      'identity.label': '身份注入文本',
      'persona.name': 'DEPLOYMENT_PERSONA_PREFIX',
      'persona.sub': '人设前缀 · 身份行之后（order 0），会覆盖预设里的人设',
      'persona.label': '人设前缀文本',
      'placeholder': '留空则不覆盖，继续使用原始文本',
      'chip.on': '已覆盖',
      'chip.off': '跟随原始',
      'loadCurrent': '载入原始文本',
      'clearOverride': '取消覆盖',
      'chars': '{n} 字符',
      'save': '保存并全局生效',
      'saving': '保存中…',
      'reload': '重新载入',
      'saved': '已保存，全局生效',
      'savedDetail': '已保存，全局生效：身份 {identity} 字 · 人设 {persona} 字 · {scope}',
      'scope.root': '仅主会话',
      'scope.all': '含子代理',
      'resetDone': '已取消该字段的覆盖',
      'dirty': '有未保存的修改',
      'hint': '留空 = 不覆盖。文本按字面注入；{{model}} 等已注册变量会在组装时解析，未知变量原样保留。',
      'preview': '预览保存后的 system prompt 头部（完整）',
      'preview.empty': '（暂无内容）',
      'path': '配置文件',
      'updated': '上次保存：{time}',
      'loading': '载入中…',
      'loadError': '无法读取人设设置',
      'retry': '重试',
      'loadWarning': '读取配置文件失败，当前使用原始文本。',
      'emptySample': '当前会话还没有生成过系统提示词，先发一条消息再回来即可载入。',
    }
    const EN = {
      'nav.label': 'Persona',
      'title': 'Persona prompt',
      'intro': 'Edit the two system-prompt sections injected at the front of every model request. By default only top-level conversations are rewritten; enable the switch below to apply the same text to subagents.',
      'banner': 'Global · takes effect on the next model request',
      'subagent.toggle': 'Also inject into subagents',
      'subagent.desc': 'Off: only top-level conversations are rewritten; subagents keep their own preset persona and identity.',
      'identity.name': 'HARNESS_IDENTITY',
      'identity.sub': 'Harness identity line · first in the system prompt (order -1000)',
      'identity.label': 'Identity text',
      'persona.name': 'DEPLOYMENT_PERSONA_PREFIX',
      'persona.sub': 'Persona prefix · follows the identity line (order 0), overriding the preset persona',
      'persona.label': 'Persona prefix text',
      'placeholder': 'Leave empty to keep the original text',
      'chip.on': 'Overridden',
      'chip.off': 'Original',
      'loadCurrent': 'Load original text',
      'clearOverride': 'Clear override',
      'chars': '{n} characters',
      'save': 'Save globally',
      'saving': 'Saving…',
      'reload': 'Reload',
      'saved': 'Saved and applied globally',
      'savedDetail': 'Saved globally: identity {identity} chars · persona {persona} chars · {scope}',
      'scope.root': 'main sessions only',
      'scope.all': 'including subagents',
      'resetDone': 'Override cleared for this field',
      'dirty': 'Unsaved changes',
      'hint': 'Empty means "no override". Text is injected literally; registered variables such as {{model}} resolve at assembly time, unknown ones stay as written.',
      'preview': 'Preview the complete system prompt head after saving',
      'preview.empty': '(empty)',
      'path': 'State file',
      'updated': 'Last saved: {time}',
      'loading': 'Loading…',
      'loadError': 'Could not load persona settings',
      'retry': 'Retry',
      'loadWarning': 'The state file could not be read; the original text is in use.',
      'emptySample': 'No system prompt has been assembled in this process yet. Send one message, then come back.',
    }

    function activeLocaleId(locale) {
      try {
        const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null
        const id = snapshot && (snapshot.active ?? snapshot.id ?? snapshot.locale)
        return typeof id === 'string' ? id : ''
      } catch {
        return ''
      }
    }

    function interpolate(text, vars) {
      if (typeof text !== 'string' || vars === undefined || vars === null) return text
      return text.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key])))
    }

    function makeTranslate(locale) {
      let bound = null
      try {
        if (locale && typeof locale.bind === 'function') bound = locale.bind(NS)
      } catch {
        bound = null
      }
      return (key, vars) => {
        let text = null
        if (typeof bound === 'function') {
          try {
            text = bound(key, vars)
          } catch {
            text = null
          }
        }
        if (typeof text !== 'string' || text === '' || text === key) {
          const english = activeLocaleId(locale).toLowerCase().startsWith('en')
          const dict = english ? EN : ZH
          text = dict[key] ?? ZH[key] ?? key
        }
        return interpolate(text, vars)
      }
    }

    // ------------------------------------------------------------------- styles
    const CSS = `
.pph-root{--pph-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;box-sizing:border-box;display:flex;flex-direction:column;gap:16px;padding:4px 0 28px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.pph-head{display:flex;flex-direction:column;gap:6px}
.pph-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.pph-intro{margin:0;max-width:64ch;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.pph-banner{box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);border-radius:8px;font-size:13px}
.pph-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}
.pph-switchRow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.pph-switchText{display:flex;flex-direction:column;gap:2px;min-width:0}
.pph-switchLabel{font-size:13px;font-weight:600}
.pph-switchDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.pph-switch{appearance:none;flex:none;box-sizing:border-box;width:38px;height:22px;padding:2px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease,border-color .15s ease}
.pph-knob{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}
.pph-switch.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);background:var(--dsw-alias-brand-primary)}
.pph-switch.on .pph-knob{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
.pph-switch:disabled{opacity:.5;cursor:default}
.pph-switch:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);outline-offset:2px}
.pph-card{box-sizing:border-box;display:flex;flex-direction:column;gap:9px;padding:14px 16px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.pph-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.pph-name{font-family:var(--pph-mono);font-size:13px;font-weight:600;letter-spacing:.01em}
.pph-sub{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.pph-chip{flex:none;box-sizing:border-box;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.pph-chip.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary)}
.pph-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.pph-textarea{box-sizing:border-box;width:100%;min-height:78px;resize:vertical;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--pph-mono);font-size:12.5px;line-height:20px;outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.pph-textarea::placeholder{color:var(--dsw-alias-state-idle-primary)}
.pph-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.pph-textarea:disabled{opacity:.6}
.pph-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:24px}
.pph-count{color:var(--dsw-alias-state-idle-primary);font-size:12px;font-variant-numeric:tabular-nums}
.pph-links{display:flex;align-items:center;gap:2px}
.pph-link{appearance:none;border:none;background:none;padding:2px 6px;border-radius:6px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.pph-link:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.pph-link:disabled{opacity:.45;cursor:default}
.pph-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.pph-preview{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.pph-summary{cursor:pointer;padding:10px 14px;color:var(--dsw-alias-label-secondary);font-size:12.5px;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px}
.pph-summary::-webkit-details-marker{display:none}
.pph-caret{display:inline-block;transition:transform .12s ease;font-size:10px}
.pph-preview[open] .pph-caret{transform:rotate(90deg)}
.pph-pre{margin:0;padding:0 14px 12px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--pph-mono);font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.pph-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pph-btn{appearance:none;box-sizing:border-box;height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:30px;cursor:pointer;white-space:nowrap}
.pph-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.pph-btn:disabled{opacity:.45;cursor:default}
.pph-btn.primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}
.pph-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.pph-status{font-size:12.5px;line-height:18px}
.pph-status.ok{color:var(--dsw-alias-state-success-primary)}
.pph-status.err{color:var(--dsw-alias-state-error-primary)}
.pph-status.warn{color:var(--dsw-alias-state-warn-primary)}
.pph-error{box-sizing:border-box;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pph-path{margin:0;color:var(--dsw-alias-state-idle-primary);font-size:11.5px;line-height:17px;word-break:break-all}
`

    // -------------------------------------------------------------------- data
    async function request(options) {
      const response = await fetch(ROUTE, {
        cache: 'no-store',
        ...options,
        headers: {
          [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE,
          ...(options && options.headers ? options.headers : {}),
        },
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const message = payload && typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload.value
    }

    function post(action, extra) {
      return request({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(extra || {}) }),
      })
    }

    // --------------------------------------------------------------- component
    function PersonaSection(props) {
      const tr = (key, vars) => {
        if (props && typeof props.t === 'function') {
          try {
            const value = props.t(key, vars)
            if (typeof value === 'string' && value !== '') return interpolate(value, vars)
          } catch {
            // fall through to the plugin dictionary
          }
        }
        return translate(key, vars)
      }

      const [data, setData] = React.useState(null)
      const [identity, setIdentity] = React.useState('')
      const [personaPrefix, setPersonaPrefix] = React.useState('')
      const [applyToSubagents, setApplyToSubagents] = React.useState(false)
      const [baseline, setBaseline] = React.useState({ identity: '', personaPrefix: '', applyToSubagents: false })
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [reloadKey, setReloadKey] = React.useState(0)

      const applyView = React.useCallback((view) => {
        const next = {
          identity: view.identity || view.sample.identity || '',
          personaPrefix: view.personaPrefix || view.sample.personaPrefix || '',
          applyToSubagents: view.applyToSubagents === true,
        }
        setData(view)
        setIdentity(next.identity)
        setPersonaPrefix(next.personaPrefix)
        setApplyToSubagents(next.applyToSubagents)
        setBaseline(next)
      }, [])

      React.useEffect(() => {
        let alive = true
        setLoading(true)
        setError(null)
        request({ method: 'GET' })
          .then((view) => {
            if (alive) applyView(view)
          })
          .catch((reason) => {
            if (alive) setError(String(reason && reason.message ? reason.message : reason))
          })
          .finally(() => {
            if (alive) setLoading(false)
          })
        return () => {
          alive = false
        }
      }, [reloadKey, applyView])

      const dirty = identity !== baseline.identity
        || personaPrefix !== baseline.personaPrefix
        || applyToSubagents !== baseline.applyToSubagents
      const identityOverridden = data !== null && data.identity !== ''
      const personaOverridden = data !== null && data.personaPrefix !== ''

      const run = async (operation, successText) => {
        setBusy(true)
        setStatus(null)
        try {
          const view = await operation()
          applyView(view)
          setStatus({ kind: 'ok', text: typeof successText === 'function' ? successText(view) : successText })
        } catch (reason) {
          setStatus({ kind: 'err', text: String(reason && reason.message ? reason.message : reason) })
        } finally {
          setBusy(false)
        }
      }

      const save = () => run(
        () => post('save', { identity, personaPrefix, applyToSubagents }),
        (view) => tr('savedDetail', {
          identity: view.effective.identity.length,
          persona: view.effective.personaPrefix.length,
          scope: tr(view.applyToSubagents ? 'scope.all' : 'scope.root'),
        }),
      )
      const clearField = (field) => run(() => post('reset-field', { field }), tr('resetDone'))

      const loadSample = (field) => {
        if (data === null) return
        if (field === 'identity') setIdentity(data.sample.identity || '')
        else setPersonaPrefix(data.sample.personaPrefix || '')
      }

      const effectiveIdentity = identity.trim() !== '' ? identity : data ? data.sample.identity || '' : ''
      const effectivePersona = personaPrefix.trim() !== '' ? personaPrefix : data ? data.sample.personaPrefix || '' : ''
      const previewBody = [effectiveIdentity.trim(), effectivePersona.trim()].filter((part) => part !== '').join('\n\n')
      const previewText = previewBody === '' ? tr('preview.empty') : previewBody

      const card = (field) => {
        const isIdentity = field === 'identity'
        const value = isIdentity ? identity : personaPrefix
        const setValue = isIdentity ? setIdentity : setPersonaPrefix
        const overridden = isIdentity ? identityOverridden : personaOverridden
        const sample = data ? (isIdentity ? data.sample.identity : data.sample.personaPrefix) : ''
        return h('section', { className: 'pph-card' },
          h('div', { className: 'pph-card-head' },
            h('div', null,
              h('div', { className: 'pph-name' }, tr(isIdentity ? 'identity.name' : 'persona.name')),
              h('div', { className: 'pph-sub' }, tr(isIdentity ? 'identity.sub' : 'persona.sub'))),
            h('span', { className: overridden ? 'pph-chip on' : 'pph-chip' }, tr(overridden ? 'chip.on' : 'chip.off'))),
          h('label', { className: 'pph-label', htmlFor: `pph-${field}` }, tr(isIdentity ? 'identity.label' : 'persona.label')),
          h('textarea', {
            id: `pph-${field}`,
            className: 'pph-textarea',
            value,
            spellCheck: false,
            rows: isIdentity ? 4 : 16,
            placeholder: tr('placeholder'),
            disabled: loading || busy,
            onChange: (event) => setValue(event.target.value),
          }),
          h('div', { className: 'pph-foot' },
            h('span', { className: 'pph-count' }, tr('chars', { n: value.length })),
            h('div', { className: 'pph-links' },
              h('button', {
                type: 'button',
                className: 'pph-link',
                disabled: busy || sample === '',
                onClick: () => loadSample(field),
              }, tr('loadCurrent')),
              overridden
                ? h('button', {
                  type: 'button',
                  className: 'pph-link',
                  disabled: busy,
                  onClick: () => clearField(field),
                }, tr('clearOverride'))
                : null)))
      }

      return h('div', { className: 'pph-root' },
        h('style', null, CSS),
        h('header', { className: 'pph-head' },
          h('h2', { className: 'pph-title' }, tr('title')),
          h('p', { className: 'pph-intro' }, tr('intro'))),
        h('div', { className: 'pph-banner' },
          h('span', { className: 'pph-dot' }),
          h('span', null, tr('banner'))),

        loading && data === null
          ? h('div', { className: 'pph-hint' }, tr('loading'))
          : error !== null
            ? h('div', { className: 'pph-error' },
              h('span', null, `${tr('loadError')}: ${error}`),
              h('button', {
                type: 'button',
                className: 'pph-btn',
                disabled: busy,
                onClick: () => setReloadKey((key) => key + 1),
              }, tr('retry')))
            : [
              data && data.loadWarning
                ? h('div', { key: 'warn', className: 'pph-hint', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, tr('loadWarning'))
                : null,
              h('div', { key: 'scope', className: 'pph-switchRow' },
                h('div', { className: 'pph-switchText' },
                  h('div', { className: 'pph-switchLabel' }, tr('subagent.toggle')),
                  h('div', { className: 'pph-switchDesc' }, tr('subagent.desc'))),
                h('button', {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': applyToSubagents,
                  'aria-label': tr('subagent.toggle'),
                  className: applyToSubagents ? 'pph-switch on' : 'pph-switch',
                  disabled: busy,
                  onClick: () => setApplyToSubagents((value) => !value),
                }, h('span', { className: 'pph-knob' }))),
              h('div', { key: 'identity' }, card('identity')),
              h('div', { key: 'persona' }, card('persona')),
              data && data.sample.personaPrefix === ''
                ? h('div', { key: 'empty', className: 'pph-hint' }, tr('emptySample'))
                : null,
              h('p', { key: 'hint', className: 'pph-hint' }, tr('hint')),
              h('details', { key: 'preview', className: 'pph-preview' },
                h('summary', { className: 'pph-summary' },
                  h('span', null, tr('preview')),
                  h('span', { className: 'pph-caret' }, '▶')),
                h('pre', { className: 'pph-pre' }, previewText)),
              h('div', { key: 'actions', className: 'pph-actions' },
                h('button', {
                  type: 'button',
                  className: 'pph-btn primary',
                  disabled: !dirty || busy,
                  onClick: save,
                }, busy ? tr('saving') : tr('save')),
                h('button', {
                  type: 'button',
                  className: 'pph-btn',
                  disabled: busy,
                  onClick: () => setReloadKey((key) => key + 1),
                }, tr('reload')),
                status !== null
                  ? h('span', { className: `pph-status ${status.kind}`, role: 'status' }, status.text)
                  : dirty
                    ? h('span', { className: 'pph-status warn' }, tr('dirty'))
                    : null),
              data !== null && data.updatedAt !== null
                ? h('p', { key: 'updated', className: 'pph-path' }, tr('updated', { time: new Date(data.updatedAt).toLocaleString() }))
                : null,
              data !== null
                ? h('p', { key: 'path', className: 'pph-path' }, `${tr('path')}: ${data.path}`)
                : null,
            ])
    }

    // -------------------------------------------------------------------- apply
    let translate = makeTranslate(undefined)

    function apply(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      translate = makeTranslate(locale)

      if (locale && typeof locale.register === 'function') {
        ctx.effect(() => {
          try {
            return locale.register(NS, { zh: ZH, en: EN })
          } catch (error) {
            console.warn('[persona-prompt] dictionary registration failed:', error)
            return undefined
          }
        }, 'persona-prompt: dictionaries')
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'persona-prompt',
        order: 25,
        label: () => translate('nav.label'),
        locale: NS,
      }, PersonaSection))
    }

    return { inject: ['slots'], apply }
  },
})

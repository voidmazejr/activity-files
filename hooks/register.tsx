import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, RenderChildren, SvgProps, Timer } from "claude-code"

import type { GitFile, GitInfo, Now, PaneSettings, Touched, TouchStatus, View } from '../types'

const PANE = 'activity-files'

const nowAtom = atom({ plugin: 'activity-files', key: 'now' } as const, { kind: 'idle', title: 'Waiting for a task', sub: 'no files touched yet' } as Now, { shape: 'now-1' })
const touchedAtom = atom({ plugin: 'activity-files', key: 'touched' } as const, [] as Touched[], { shape: 'touched-1' })
const gitAtom = atom({ plugin: 'activity-files', key: 'git' } as const, { repo: '', branch: '', ahead: 0, behind: 0, files: {} } as GitInfo, { shape: 'git-1' })
const viewAtom = atom(
  { plugin: 'activity-files', key: 'view' } as const,
  { root: '', expanded: [], query: '', showSettings: false } as View,
  { shape: 'view-2' },
)

// PaneSettings live in $.store too, so they carry over to every new session.
const DEFAULT_SETTINGS: PaneSettings = {
  autoOpen: true,
  closeAfter: 4,
  animations: true,
  showHidden: true,
  column: 'time',
  resetEachTask: true,
}
const STORE_KEY = 'settings'
const settingsAtom = atom({ plugin: 'activity-files', key: 'settings' } as const, { ...DEFAULT_SETTINGS } as PaneSettings, { shape: 'settings-1' })
const CLOSE_STEPS = [2, 4, 8, 15, 0]

// ---------- colours (picked to match the video) ----------
const C = {
  fg: '#ececec',
  muted: '#8e8e8e',
  faint: '#5f5f5f',
  // translucent, so a theme's backdrop shows through the cards
  card: 'rgba(255,255,255,0.05)',
  border: 'rgba(255,255,255,0.12)',
  borderHot: 'rgba(255,255,255,0.75)',
  purple: '#b794f6',
  orange: '#f0883e',
  yellow: '#e2c08d',
  green: '#4ade80',
  red: '#f87171',
  blue: '#6cb6ff',
}

const STATUS: Record<TouchStatus, { label: string; color: string }> = {
  reading: { label: 'Reading', color: C.purple },
  opened: { label: 'Opened', color: C.purple },
  editing: { label: 'Editing', color: C.orange },
  edited: { label: 'Edited', color: C.orange },
  committed: { label: 'Committed', color: C.green },
}

// ---------- icons (24x24 stroke paths) ----------
const FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
const PATHS = {
  thinking: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9',
  reading: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6',
  editing: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  running: 'm4 17 6-6-6-6M12 19h8',
  done: 'M20 6 9 17l-5-5',
  committed: 'M20 6 9 17l-5-5',
  idle: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 1 0 0-14M20 20l-4-4',
  folder: FOLDER,
}

const NOW_STYLE: Record<Now['kind'], { label: string; color: string }> = {
  idle: { label: 'RIGHT NOW', color: C.muted },
  thinking: { label: 'RIGHT NOW', color: C.muted },
  reading: { label: 'RIGHT NOW', color: C.purple },
  editing: { label: 'RIGHT NOW', color: C.orange },
  running: { label: 'RIGHT NOW', color: C.blue },
  done: { label: 'DONE', color: C.green },
  committed: { label: 'DONE', color: C.green },
}

const svg = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`

const lineIcon = (d: string, color: string, size: number) =>
  svg(size, `<g transform="scale(${size / 24})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>`)

// The status icon. While Claude works, a soft ring breathes around it.
const circleIcon = (d: string, color: string, isLive: boolean) =>
  svg(
    48,
    (isLive
      ? `<circle cx="24" cy="24" r="20" fill="none" stroke="${color}" stroke-width="1.5" opacity="0"><animate attributeName="r" values="18;24" dur="1.8s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.55;0" dur="1.8s" repeatCount="indefinite"/></circle>`
      : '') +
      `<circle cx="24" cy="24" r="20" fill="${color}" fill-opacity="0.16"/><g transform="translate(12 12)" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>`,
  )

// A small label with rounded corners, the same height as a line of text: a
// soft fill and the word in the label's colour. Badges (JS, MD) are a little
// squarer, status pills (Editing) fully round.
const PILL_H = 18
const pillWidth = (text: string, mono: boolean) => Math.round(text.length * (mono ? 6.6 : 6.4) + (mono ? 10 : 16))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// isLive: a soft band of light sweeps across the pill, left to right, while
// Claude is on that file. Same size as the still pill.
const pillSvg = (text: string, color: string, mono: boolean, isLive = false) => {
  const w = pillWidth(text, mono)
  const font = mono ? 'ui-monospace,SFMono-Regular,Menlo,monospace' : '-apple-system,system-ui,sans-serif'
  const r = mono ? 4 : 8
  const band = w * 0.6
  const shine = isLive
    ? `<defs><clipPath id="pl-clip"><rect x="0" y="1" width="${w}" height="${PILL_H - 2}" rx="${r}"/></clipPath><linearGradient id="pl-band" x1="0" x2="1"><stop offset="0" stop-color="${color}" stop-opacity="0"/><stop offset="0.5" stop-color="${color}" stop-opacity="0.45"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><g clip-path="url(#pl-clip)"><rect x="${-band}" y="0" width="${band}" height="${PILL_H}" fill="url(#pl-band)"><animate attributeName="x" values="${-band};${w}" dur="1.6s" repeatCount="indefinite"/></rect></g>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${PILL_H}" viewBox="0 0 ${w} ${PILL_H}"><rect x="0" y="1" width="${w}" height="${PILL_H - 2}" rx="${r}" fill="${color}" fill-opacity="0.16"/>${shine}<text x="${w / 2}" y="${PILL_H / 2 + 0.5}" text-anchor="middle" dominant-baseline="middle" font-family="${font}" font-size="${mono ? 10 : 11}" font-weight="700" fill="${color}">${esc(text)}</text></svg>`
}

// The live row's shine: drawn 400 wide and stretched to the row's width, a
// faint rounded wash with a soft band of light sliding across it.
const rowSweep = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="22" viewBox="0 0 400 22" preserveAspectRatio="none"><defs><linearGradient id="rw-band" x1="0" x2="1"><stop offset="0" stop-color="${color}" stop-opacity="0"/><stop offset="0.5" stop-color="${color}" stop-opacity="0.22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient><clipPath id="rw-clip"><rect x="0" y="0" width="400" height="22" rx="6"/></clipPath></defs><g clip-path="url(#rw-clip)"><rect x="0" y="0" width="400" height="22" fill="${color}" fill-opacity="0.05"/><rect x="-160" y="0" width="160" height="22" fill="url(#rw-band)"><animate attributeName="x" values="-160;400" dur="1.8s" repeatCount="indefinite"/></rect></g></svg>`

// Beside the file Claude is on: a small dot with a ripple. It only runs while
// that file is live.
const liveDot = (color: string) =>
  svg(
    14,
    `<circle cx="7" cy="7" r="3" fill="${color}" opacity="0"><animate attributeName="r" values="3;7" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.6;0" dur="1.4s" repeatCount="indefinite"/></circle><circle cx="7" cy="7" r="3" fill="${color}"><animate attributeName="opacity" values="1;0.55;1" dur="1.4s" repeatCount="indefinite"/></circle>`,
  )


// ---------- paths ----------
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p
const dirOf = (p: string) => {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
const join = (a: string, b: string) => (a.endsWith('/') ? a + b : `${a}/${b}`)
const rel = (root: string, p: string) => (p === root ? '' : p.startsWith(root + '/') ? p.slice(root.length + 1) : p)
const ancestors = (root: string, p: string) => {
  const out: string[] = []
  let d = dirOf(p)
  while (d.startsWith(root) && d !== root && d.length > root.length) {
    out.push(d)
    d = dirOf(d)
  }
  return out
}

// ---------- file badges ----------
const BADGES: Record<string, [string, string]> = {
  js: ['JS', '#e5c07b'], mjs: ['JS', '#e5c07b'], cjs: ['JS', '#e5c07b'], jsx: ['JSX', '#e5c07b'],
  ts: ['TS', '#6cb6ff'], tsx: ['TSX', '#6cb6ff'], json: ['{ }', '#7ee787'], md: ['MD', '#79c0ff'],
  py: ['PY', '#79c0ff'], go: ['GO', '#76e3ea'], rs: ['RS', '#f0883e'], c: ['C', '#a5d6ff'], h: ['H', '#a5d6ff'],
  cpp: ['C++', '#a5d6ff'], css: ['CSS', '#d2a8ff'], html: ['HTML', '#f0883e'], csv: ['CSV', '#7ee787'],
  pdf: ['PDF', '#f87171'], sh: ['SH', '#7ee787'], zsh: ['SH', '#7ee787'], yml: ['YML', '#f87171'],
  yaml: ['YML', '#f87171'], toml: ['TOML', '#a8a8a8'], lua: ['LUA', '#79c0ff'], swift: ['SW', '#f0883e'],
  java: ['JAVA', '#f0883e'], kt: ['KT', '#d2a8ff'], rb: ['RB', '#f87171'], php: ['PHP', '#d2a8ff'],
  png: ['IMG', '#d2a8ff'], jpg: ['IMG', '#d2a8ff'], jpeg: ['IMG', '#d2a8ff'], svg: ['SVG', '#e5c07b'],
  docx: ['DOC', '#79c0ff'], txt: ['TXT', '#a8a8a8'], lock: ['LOCK', '#8e8e8e'],
}
const badgeOf = (name: string): [string, string] => {
  if (name === '.gitignore' || name === '.gitattributes') return ['GIT', '#8e8e8e']
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return BADGES[ext] ?? [ext ? ext.slice(0, 3).toUpperCase() : '•', '#8e8e8e']
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtTime = (ms: number) => {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

// ---------- git ----------
type Dollar = EngineInterface

async function git($: Dollar, cwd: string, args: string[]) {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 10000 })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

async function refreshGit($: Dollar) {
  const view = await read($, viewAtom)
  const root = view.root || (await $.session.cwd())
  const top = (await git($, root, ['rev-parse', '--show-toplevel']))?.trim()
  if (!top) {
    await update($, gitAtom, () => ({ repo: '', branch: '', ahead: 0, behind: 0, files: {} }))
    return
  }
  const status = (await git($, top, ['status', '--porcelain=v1', '-b', '-uall'])) ?? ''
  const num = (await git($, top, ['diff', '--numstat', 'HEAD'])) ?? (await git($, top, ['diff', '--numstat'])) ?? ''
  const files: Record<string, GitFile> = {}
  let branch = ''
  let ahead = 0
  let behind = 0
  for (const line of status.split('\n')) {
    if (!line) continue
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      branch = (head.split('...')[0] ?? '').replace(/^No commits yet on /, '')
      ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
      behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
      continue
    }
    const code = line.slice(0, 2)
    let p = line.slice(3)
    if (p.includes(' -> ')) p = p.split(' -> ')[1] ?? p
    p = p.replace(/^"|"$/g, '')
    files[join(top, p)] = { code: code.trim() || 'M', add: 0, del: 0 }
  }
  for (const line of num.split('\n')) {
    const [a, d, p] = line.split('\t')
    if (!p) continue
    const f = files[join(top, p)]
    if (f) {
      f.add = Number(a) || 0
      f.del = Number(d) || 0
    }
  }
  await update($, gitAtom, () => ({ repo: top, branch, ahead, behind, files }))
}

// ---------- activity ----------
const READERS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function pathOf(e: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = e[k]
    if (typeof v === 'string' && v.startsWith('/')) return v
  }
  return undefined
}

async function setTouched($: Dollar, path: string, status: TouchStatus) {
  await update($, touchedAtom, list => {
    const i = list.findIndex(t => t.path === path)
    if (i < 0) return [...list, { path, status }].slice(-40)
    const prev = list[i]?.status
    // an edit outranks a read: don't downgrade "Edited" back to "Opened"
    if ((status === 'reading' || status === 'opened') && (prev === 'edited' || prev === 'editing' || prev === 'committed'))
      return list
    return list.map((t, j) => (j === i ? { ...t, status } : t))
  })
}

async function reveal($: Dollar, path: string) {
  const view = await read($, viewAtom)
  const root = view.root
  if (!root || !path.startsWith(root + '/')) return
  const add = ancestors(root, path).filter(d => !view.expanded.includes(d))
  if (add.length) await update($, viewAtom, v => ({ ...v, expanded: [...v.expanded, ...add] }))
}

// A folder for display: inside the project, relative to it; outside, the last
// two folders, so a long absolute path never pushes the row out of its card.
const shortDir = (root: string, dir: string) => {
  if (dir === root) return ''
  if (dir.startsWith(root + '/')) return dir.slice(root.length + 1)
  const parts = dir.replace(/^\/(Users|home)\/[^/]+/, '~').split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/')
}

async function saveSettings($: Dollar, change: (s: PaneSettings) => PaneSettings) {
  const next = await update($, settingsAtom, change)
  await $.store.set(STORE_KEY, next)
}

// Which repository a shell command commits in: a leading `cd <dir>` or
// `git -C <dir>`, else the folder the pane shows.
function commitDir(cmd: string, root: string) {
  const m = /(?:^|&&|;)\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd) ?? /\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd)
  const dir = m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
  if (!dir) return root
  const home = /^\/(?:Users|home)\/[^/]+/.exec(root)?.[0] ?? ''
  const abs = dir.startsWith('~') ? home + dir.slice(1) : dir.startsWith('/') ? dir : join(root, dir)
  return abs
}

// The pane opens when Claude starts working and closes on its own a few
// seconds after Claude finishes (both in the settings). /files opens it by
// hand, and then it stays.
let closeTimer: Timer | undefined

async function openPane($: Dollar) {
  const v = await read($, viewAtom)
  const root = v.root || (await $.session.cwd())
  await $.ui.open({ id: PANE, title: `Files: ${base(root)}`, backgroundColor: "transparent" })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files',
      description: 'Open the activity file pane; /files settings opens its settings',
      argumentHint: '[settings]',
    })
    const cwd = await $.session.cwd()
    await update($, viewAtom, v => ({ ...v, root: v.root || cwd }))
    const saved = (await $.store.get(STORE_KEY)) as Partial<PaneSettings> | undefined
    await update($, settingsAtom, () => ({ ...DEFAULT_SETTINGS, ...(saved ?? {}) }))
    void refreshGit($)
    return next(e)
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    closeTimer?.cancel()
    closeTimer = undefined
    const wantsSettings = /\bsettings?\b|\bconfig\b/i.test(String((e as { args?: unknown }).args ?? ''))
    await update($, viewAtom, v => ({ ...v, showSettings: wantsSettings }))
    await openPane($)
    return { text: wantsSettings ? 'Files settings opened.' : 'Files pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    closeTimer?.cancel()
    closeTimer = undefined
    const s = await read($, settingsAtom)
    if (s.autoOpen) void openPane($)
    if (s.resetEachTask) await update($, touchedAtom, () => [])
    await update($, nowAtom, () => ({ kind: 'thinking', title: 'Claude is thinking', sub: 'no files touched yet' }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const path = pathOf(input)
    const view = await read($, viewAtom)
    const root = view.root
    const where = (p: string) => {
      const d = shortDir(root, dirOf(p))
      return d ? `in ${d}` : `in ${base(root)}`
    }

    if (path && READERS.has(tool)) {
      const isDir = tool !== 'Read' && tool !== 'NotebookRead'
      if (!isDir) {
        await setTouched($, path, 'reading')
        await reveal($, path)
      }
      await update($, nowAtom, () => ({
        kind: 'reading',
        title: isDir ? `Claude is searching ${base(path)}` : `Claude is reading ${base(path)}`,
        sub: isDir ? `in ${shortDir(root, path) || base(root)}` : where(path),
      }))
      const ran = await next(e)
      if (!isDir) await setTouched($, path, 'opened')
      return ran
    }

    if (path && WRITERS.has(tool)) {
      await setTouched($, path, 'editing')
      await reveal($, path)
      await update($, nowAtom, () => ({ kind: 'editing', title: `Claude is editing ${base(path)}`, sub: where(path) }))
      const ran = await next(e)
      await setTouched($, path, 'edited')
      void refreshGit($)
      return ran
    }

    if (tool === 'Bash') {
      const cmd = String(input.command ?? '')
      const isCommit = /\bgit\b[^|;&]*\bcommit\b/.test(cmd)
      await update($, nowAtom, () => ({
        kind: 'running',
        title: isCommit ? 'Claude is committing' : 'Claude is running a command',
        sub: cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd,
      }))
      // Only a commit that really happened, in the repository the command ran
      // in: compare that repository's HEAD before and after.
      const dir = isCommit ? commitDir(cmd, root) : root
      const before = isCommit ? (await git($, dir, ['rev-parse', 'HEAD']))?.trim() : undefined
      const ran = await next(e)
      await refreshGit($)
      if (isCommit) {
        const after = (await git($, dir, ['rev-parse', 'HEAD']))?.trim()
        const top = (await git($, dir, ['rev-parse', '--show-toplevel']))?.trim() ?? dir
        const isNew = !!after && after !== before
        const sha = isNew ? after.slice(0, 7) : ''
        const names = isNew
          ? ((await git($, dir, ['show', '--name-only', '--format=', 'HEAD'])) ?? '')
              .split('\n')
              .filter(Boolean)
              .map(n => join(top, n))
          : []
        if (sha && names.length) {
          await update($, touchedAtom, list => {
            const seen = new Set(list.map(t => t.path))
            const marked = list.map(t => (names.includes(t.path) ? { ...t, status: 'committed' as const } : t))
            return [...marked, ...names.filter(n => !seen.has(n)).map(path => ({ path, status: 'committed' as const }))]
          })
          await update($, nowAtom, () => ({
            kind: 'committed',
            title: `Claude committed ${names.length} file${names.length === 1 ? '' : 's'}`,
            sub: sha,
          }))
        }
      }
      return ran
    }

    await update($, nowAtom, n =>
      n.kind === 'committed' ? n : { kind: 'thinking' as const, title: 'Claude is thinking', sub: `using ${tool}` },
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const touched = await read($, touchedAtom)
    const edited = touched.filter(t => t.status === 'edited').length
    const opened = touched.filter(t => t.status === 'opened').length
    await update($, nowAtom, n => {
      if (n.kind === 'committed') return n
      const parts = [edited && `edited ${edited}`, opened && `read ${opened}`].filter(Boolean)
      return {
        kind: 'done' as const,
        title: edited ? `Claude edited ${edited} file${edited === 1 ? '' : 's'}` : 'Claude is done',
        sub: parts.length ? parts.join(', ') + ` file${edited + opened === 1 ? '' : 's'}` : 'no files touched',
      }
    })
    void refreshGit($)
    closeTimer?.cancel()
    closeTimer = undefined
    const s = await read($, settingsAtom)
    const view = await read($, viewAtom)
    // Never close the pane under someone changing the settings.
    if (s.closeAfter > 0 && !view.showSettings) {
      closeTimer = $.clock.after(s.closeAfter * 1000, () => {
        closeTimer = undefined
        void $.ui.close({ id: PANE }).catch(() => {})
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input } = els
    const Svg = 'Svg' in els ? (els as { Svg: ElementConstructor<SvgProps> }).Svg : null

    const [now, touched, g, view, settings] = await Promise.all([
      read($, nowAtom),
      read($, touchedAtom),
      read($, gitAtom),
      read($, viewAtom),
      read($, settingsAtom),
    ])
    const animate = settings.animations
    const root = view.root || (await $.session.cwd())
    const icon = (d: string, color: string, size: number, glyph: string) =>
      Svg ? <Svg source={lineIcon(d, color, size)} alt={glyph} width={size} height={size} /> : <Text color={color}>{glyph}</Text>

    // Rounded chips, drawn like the cards: a round border and a soft fill.
    const isGui = e.surface !== "terminal"
    const chip = (key: string, text: string, color: string, mono = false, isLive = false) =>
      isGui && Svg ? (
        <Box key={key}>
          {isLive ? (
            <Svg source={pillSvg(text, color, mono, true)} alt={text} width={pillWidth(text, mono)} height={PILL_H} isInteractive />
          ) : (
            <Svg source={pillSvg(text, color, mono)} alt={text} width={pillWidth(text, mono)} height={PILL_H} />
          )}
        </Box>
      ) : isGui ? (
        <Text size="caption" mono={mono} weight="bold" color={color} backgroundColor={`${color}22`}>{` ${text} `}</Text>
      ) : (
        <Text weight="bold" color={color}>{text}</Text>
      )
    const anim = (key: string, source: string, width: number, height: number, alt: string) =>
      Svg ? <Svg key={key} source={source} alt={alt} width={width} height={height} isInteractive /> : null

    const setView = (fn: (v: View) => View) => () => void update($, viewAtom, fn)
    const changedPaths = Object.keys(g.files)
    const changedCount = changedPaths.length
    const isWorking = now.kind === 'reading' || now.kind === 'editing' || now.kind === 'running'
    const ns = NOW_STYLE[now.kind]

    // ----- Right now card -----
    const nowCard = (
      <Box
        key="now"
        flexDirection="column"
        borderStyle="round"
        borderColor={isWorking ? C.borderHot : C.border}
        backgroundColor={C.card}
        paddingX={2}
        paddingY={1}
        gap={1}
      >
        <Box flexDirection="row" gap={2} alignItems="center">
          {Svg ? (
            <Svg source={circleIcon(PATHS[now.kind], ns.color === C.muted ? '#cfcfcf' : ns.color, animate && (isWorking || now.kind === "thinking"))} alt={now.kind} width={44} height={44} isInteractive />
          ) : (
            <Text color={ns.color}>●</Text>
          )}
          <Box flexDirection="column">
            <Text size="caption" weight="bold" color={ns.color === C.muted ? C.muted : ns.color}>
              {ns.label}
            </Text>
            <Text size="heading" weight="bold" color={C.fg} wrap="truncate-end">
              {now.title}
            </Text>
            <Text color={C.muted} wrap="truncate-end">
              {now.sub}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Box flexDirection="row" gap={1} alignItems="center">
              {icon(PATHS.branch, C.blue, 16, '⎇')}
              <Text weight="bold" color={C.fg}>
                {g.branch || 'no git'}
              </Text>
              {g.ahead > 0 && <Text color={C.green} weight="bold">↑{g.ahead}</Text>}
              {g.behind > 0 && <Text color={C.red} weight="bold">↓{g.behind}</Text>}
            </Box>
            <Text color={C.muted}>
              {!g.repo ? 'not a git repo' : changedCount === 0 ? 'clean, nothing changed' : `${changedCount} file${changedCount === 1 ? '' : 's'} changed`}
            </Text>
          </Box>
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Text color={C.muted}><Text color={C.purple}>●</Text> Claude read</Text>
            <Text color={C.muted}><Text color={C.orange}>●</Text> Claude edited</Text>
            <Text color={C.muted}><Text color={C.yellow}>●</Text> Not committed</Text>
          </Box>
        </Box>
      </Box>
    )

    // ----- search + buttons -----
    const search = (
      <Box flexDirection="row" alignItems="center" gap={1} borderStyle="round" borderColor={C.border} paddingX={1}>
        {icon(PATHS.search, C.muted, 16, '⌕')}
        <Input
          key="find"
          placeholder="Find a file"
          value={view.query}
          onInput={value => void update($, viewAtom, v => ({ ...v, query: value }))}
          onSubmit={value => void update($, viewAtom, v => ({ ...v, query: value }))}
        />
      </Box>
    )

    // Two small icon buttons in the "All files" header: collapse and settings.
    // A button's label is text, so each icon is one symbol.
    const iconBtn = (key: string, glyph: string, onPress: () => void, isOn = false) => (
      <Button key={key} plain onPress={onPress}>
        <Text color={isOn ? C.fg : C.muted} weight="bold">{glyph}</Text>
      </Button>
    )
    const headerButtons = (
      <Box flexDirection="row" gap={1} alignItems="center">
        {iconBtn('collapse', '⊟', setView(v => ({ ...v, expanded: [] })))}
        {iconBtn('settings', '⚙', setView(v => ({ ...v, showSettings: !v.showSettings })), view.showSettings)}
      </Box>
    )

    // ----- settings card -----
    const set = (change: (s: PaneSettings) => PaneSettings) => () => void saveSettings($, change)
    const onOff = (b: boolean) => (b ? 'On' : 'Off')
    const settingRow = (key: string, label: string, value: string, onPress: () => void, hint?: string) => (
      <Box key={`sr:${key}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text color={C.fg}>{label}</Text>
          {hint && <Text size="footnote" color={C.muted} wrap="truncate-end">{hint}</Text>}
        </Box>
        <Button key={`s:${key}`} onPress={onPress}>{value}</Button>
      </Box>
    )
    const settingsCard = (
      <Box key="settings" flexDirection="column" borderStyle="round" borderColor={C.border} backgroundColor={C.card} paddingX={2} paddingY={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="caption" weight="bold" color={C.muted}>SETTINGS</Text>
          <Button key="settings-done" plain onPress={setView(v => ({ ...v, showSettings: false }))}>
            <Text color={C.muted} weight="bold">Done</Text>
          </Button>
        </Box>
        {settingRow('open', 'Open when Claude starts', onOff(settings.autoOpen), set(s => ({ ...s, autoOpen: !s.autoOpen })))}
        {settingRow(
          'close',
          'Close after Claude finishes',
          settings.closeAfter ? `${settings.closeAfter} s` : 'Never',
          set(s => ({ ...s, closeAfter: CLOSE_STEPS[(CLOSE_STEPS.indexOf(s.closeAfter) + 1) % CLOSE_STEPS.length] ?? 4 })),
        )}
        {settingRow('anim', 'Animations', onOff(settings.animations), set(s => ({ ...s, animations: !s.animations })))}
        {settingRow('reset', 'Clear the touched list each task', onOff(settings.resetEachTask), set(s => ({ ...s, resetEachTask: !s.resetEachTask })))}
        {settingRow('hidden', 'Hidden files', settings.showHidden ? 'Shown' : 'Hidden', set(s => ({ ...s, showHidden: !s.showHidden })))}
        {settingRow('column', 'Right column', settings.column === 'time' ? 'Time' : 'Size', set(s => ({ ...s, column: s.column === 'time' ? 'size' : 'time' })))}
        <Text size="footnote" color={C.muted}>Saved for every session. /files settings opens this.</Text>
      </Box>
    )

    // ----- Claude touched card -----
    const touchedCard = (
      <Box
        key="touched"
        flexDirection="column"
        borderStyle="round"
        borderColor={now.kind === 'committed' ? C.borderHot : C.border}
        backgroundColor={C.card}
        paddingX={2}
        paddingY={1}
        gap={1}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text size="caption" weight="bold" color={C.muted}>CLAUDE TOUCHED</Text>
          <Text size="caption" weight="bold" color={C.muted}>
            {touched.length} FILE{touched.length === 1 ? '' : 'S'}
          </Text>
        </Box>
        {touched.length === 0 ? (
          <Box paddingLeft={2}>
            <Text color={C.muted}>Nothing yet</Text>
          </Box>
        ) : (
          touched.map(t => {
            const [label, color] = badgeOf(base(t.path))
            const st = STATUS[t.status]
            const d = shortDir(root, dirOf(t.path))
            // The name keeps its room, the folder gives way first (cut with
            // "…"), and the pill always stays inside the card.
            return (
              <Box key={`t:${t.path}`} flexDirection="row" justifyContent="space-between" alignItems="center" paddingLeft={2} gap={1}>
                <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
                  {chip(`b:${t.path}`, label, color, true)}
                  <Box flexShrink={0}>
                    <Text weight="bold" color={C.fg} wrap="truncate-end">
                      {base(t.path)}
                    </Text>
                  </Box>
                  {d && (
                    <Box flexShrink={1} minWidth={0}>
                      <Text color={C.muted} wrap="truncate-start">{d}</Text>
                    </Box>
                  )}
                </Box>
                <Box flexShrink={0}>{chip(`p:${t.path}`, st.label, st.color)}</Box>
              </Box>
            )
          })
        )}
      </Box>
    )

    // ----- tree -----
    const activeStatus = new Map(touched.map(t => [t.path, t.status]))
    const changedUnder = (dir: string) => changedPaths.filter(p => p.startsWith(dir + '/')).length
    type Row = { path: string; name: string; isDir: boolean; depth: number; size: number; mtime: number }
    const rows: Row[] = []
    const MAX = 400

    const walk = async (dir: string, depth: number) => {
      if (rows.length >= MAX) return
      let entries: Awaited<ReturnType<typeof $.fs.list>> = []
      try {
        entries = await $.fs.list(dir)
      } catch {
        return
      }
      const list = entries
        .filter(en => settings.showHidden || !en.name.startsWith('.'))
        .filter(en => en.name !== '.DS_Store')
        .sort((a, b) => (a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1)
      for (const en of list) {
        if (rows.length >= MAX) return
        const path = join(dir, en.name)
        const isDir = en.kind === 'dir'
        rows.push({ path, name: en.name, isDir, depth, size: en.size, mtime: en.mtimeMs })
        if (isDir && view.expanded.includes(path)) await walk(path, depth + 1)
      }
    }

    let tree: RenderChildren[] = []
    if (view.query.trim()) {
      const q = view.query.trim().toLowerCase()
      const out = (await git($, root, ['ls-files', '-co', '--exclude-standard'])) ?? ''
      const hits = out.split('\n').filter(f => f && f.toLowerCase().includes(q)).slice(0, 50)
      tree = hits.length
        ? hits.map(f => {
            const path = join(root, f)
            const [label, color] = badgeOf(base(f))
            return (
              <Box key={`q:${f}`} flexDirection="row" gap={1} alignItems="center">
                {chip(`qc:${f}`, label, color, true)}
                <Button
                  key={`qb:${f}`}
                  plain
                  onPress={() => {
                    void update($, viewAtom, v => ({ ...v, query: '', expanded: [...new Set([...v.expanded, ...ancestors(root, path)])] }))
                  }}
                >
                  <Text color={C.fg}>{base(f)}</Text> <Text color={C.muted}>{rel(root, dirOf(path))}</Text>
                </Button>
              </Box>
            )
          })
        : [<Text key="nohits" color={C.muted}>No files match “{view.query}”</Text>]
    } else {
      await walk(root, 0)
      tree = rows.map(r => {
        const git1 = g.files[r.path]
        const st = activeStatus.get(r.path)
        const isLive = st === 'editing' || st === 'reading'
        const under = r.isDir ? changedUnder(r.path) : 0
        const isOpen = view.expanded.includes(r.path)
        const isDot = r.name.startsWith('.')
        const nameColor = isLive
          ? STATUS[st!].color
          : git1
            ? git1.code === '??' ? C.green : C.yellow
            : under
              ? C.yellow
              : isDot
                ? C.muted
                : C.fg
        let right: RenderChildren
        if (isLive) {
          const s = STATUS[st!]
          right = chip(`rp:${r.path}`, s.label.toLowerCase(), s.color)
        } else if (r.isDir && under) {
          right = <Text weight="bold" color={C.yellow}>{under} changed</Text>
        } else if (git1 && (git1.add || git1.del)) {
          right = (
            <Text weight="bold">
              <Text color={C.green}>+{git1.add}</Text> <Text color={C.red}>-{git1.del}</Text>
            </Text>
          )
        } else if (git1 && git1.code === '??') {
          right = <Text weight="bold" color={C.green}>new</Text>
        } else if (!r.isDir) {
          right = <Text color={C.faint}>{settings.column === "size" ? fmtSize(r.size) : fmtTime(r.mtime)}</Text>
        } else {
          right = <Text> </Text>
        }
        const [label, color] = badgeOf(r.name)
        const toggle = () =>
          void update($, viewAtom, v => ({
            ...v,
            expanded: v.expanded.includes(r.path) ? v.expanded.filter(x => x !== r.path && !x.startsWith(r.path + '/')) : [...v.expanded, r.path],
          }))
        return (
          <Box
            key={`r:${r.path}`}
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            paddingLeft={r.depth * 2}
            paddingRight={1}
          >
            {isLive && animate && Svg && (
              // Behind the whole row: a band of light sweeps from the name to
              // the pill. Absolute, so it moves nothing; drawn first, so the
              // name and the pill sit on top of it.
              <Box position="absolute" top={0} bottom={0} left={r.depth * 2} right={0}>
                <Svg source={rowSweep(STATUS[st!].color)} alt="working" height={22} isInteractive />
              </Box>
            )}
            <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
              {isLive && animate && Svg ? anim(`d:${r.path}`, liveDot(STATUS[st!].color), 14, 14, "live") : <Text color={C.faint}>{r.isDir ? (isOpen ? "▾" : "▸") : " "}</Text>}
              {r.isDir ? (
                icon(PATHS.folder, under ? C.yellow : isDot ? C.muted : C.blue, 18, '▤')
              ) : (
                chip(`fb:${r.path}`, label, color, true)
              )}
              {r.isDir ? (
                <Button key={`b:${r.path}`} plain onPress={toggle}>
                  <Text color={nameColor} weight={under ? 'bold' : 'regular'}>{r.name}</Text>
                </Button>
              ) : (
                <Text color={nameColor} weight={isLive || git1 ? 'bold' : 'regular'} wrap="truncate-end">
                  {r.name}
                </Text>
              )}
            </Box>
            {right}
          </Box>
        )
      })
      if (rows.length >= MAX) tree.push(<Text key="more" color={C.muted}>Showing the first {MAX} entries</Text>)
    }

    return (
      <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
        {nowCard}
        {view.showSettings ? (
          settingsCard
        ) : (
          <Box flexDirection="column" gap={1}>
            {search}
            {touchedCard}
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1} marginTop={1} gap={1}>
              <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                <Text size="caption" weight="bold" color={C.muted}>{view.query.trim() ? 'SEARCH' : 'ALL FILES'}</Text>
                <Text size="caption" weight="bold" color={C.faint} wrap="truncate-middle">
                  {base(g.repo && root.startsWith(g.repo) ? g.repo : root).toUpperCase()}
                </Text>
              </Box>
              {headerButtons}
            </Box>
            <Box flexDirection="column" paddingX={1}>
              {tree}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}

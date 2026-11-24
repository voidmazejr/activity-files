import { atom, read, update } from 'claude-code'
import type { ClientProps, ElementConstructor, EngineInterface, Register, RenderChildren, SvgProps, Timer } from "claude-code"

import type { GitFile, GitInfo, Now, PaneSettings, Tokens, Touched, TouchStatus, View, WebVisit } from '../types'
import type { HitProps } from "./hit"

const PANE = 'activity-monitor'

const nowAtom = atom({ plugin: 'activity-monitor', key: 'now' } as const, { kind: 'idle', title: 'Waiting for a task', sub: 'no files touched yet' } as Now, { shape: 'now-1' })
const touchedAtom = atom({ plugin: 'activity-monitor', key: 'touched' } as const, [] as Touched[], { shape: 'touched-1' })
const webAtom = atom({ plugin: 'activity-monitor', key: 'web' } as const, [] as WebVisit[], { shape: 'web-1' })

// The web: WebFetch (a page), WebSearch (a search), and any browser tool
// that goes to an address (the in-app browser's or Chrome's navigate).
function webOf(tool: string, input: Record<string, unknown>): Omit<WebVisit, 'isLive'> | undefined {
  if (tool === 'WebSearch' && typeof input.query === 'string') return { kind: 'search', target: input.query }
  const url = input.url
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return undefined
  if (tool === 'WebFetch' || /(^|__)(navigate|preview_start)$/.test(tool)) return { kind: 'page', target: url }
  return undefined
}

// An address split for display: the site, then the rest of the path.
const siteOf = (url: string) => {
  const m = /^https?:\/\/(?:www\.)?([^/?#]+)([^?#]*)/i.exec(url)
  return { host: m?.[1] ?? url, path: (m?.[2] ?? '').replace(/\/$/, '') }
}

async function setWeb($: Dollar, visit: Omit<WebVisit, 'isLive'>, isLive: boolean) {
  await update($, webAtom, list => {
    const rest = list.filter(v => !(v.kind === visit.kind && v.target === visit.target))
    return [...rest, { ...visit, isLive }].slice(-30)
  })
}

// ----- tokens -----
// Each model step reports what it cost. A step's output is what Claude wrote
// to ask for its tools (an edit's new text, a command), so it goes to the
// things those tools work on; the next step's new input is mostly those
// tools' results coming back (a file's text, a page), so it goes to them too.
// The first step's new input is your message and the context; a step that
// asks for no tool is Claude thinking and replying. Cache reads (the whole
// conversation served again each step) are counted apart, not per thing.
const EMPTY_TOKENS: Tokens = { input: 0, output: 0, cached: 0, by: {} }
const tokensAtom = atom({ plugin: 'activity-monitor', key: 'tokens' } as const, { ...EMPTY_TOKENS } as Tokens, { shape: 'tokens-1' })

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
function thingOf(tool: string, input: unknown): string {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const visit = webOf(tool, args)
  if (visit) return `web:${visit.kind}:${visit.target}`
  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    for (const k of ['file_path', 'notebook_path', 'path']) {
      const v = args[k]
      if (typeof v === 'string' && v.startsWith('/')) return tool === 'Read' || WRITE_TOOLS.has(tool) || tool === 'NotebookRead' ? `file:${v}` : 'other'
    }
  }
  if (tool === 'Bash') return 'cmd'
  if (tool === 'Agent' || tool === 'Task') return 'agents'
  return 'other'
}

// The things the main loop's last step asked tools for, waiting for the next
// step to bring their results in. A passing value, so a module variable.
let waiting: { turnId: string; things: string[] } | undefined

async function addTokens($: Dollar, cached: number, input: number, output: number, shares: [string[], number][]) {
  await update($, tokensAtom, t => {
    const by = { ...t.by }
    for (const [things, n] of shares) {
      if (!things.length || n <= 0) continue
      const each = n / things.length
      for (const k of things) by[k] = (by[k] ?? 0) + each
    }
    return { input: t.input + input, output: t.output + output, cached: t.cached + cached, by }
  })
}

const fmtTok = (n: number) =>
  n < 1000 ? String(Math.round(n)) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`

const gitAtom = atom({ plugin: 'activity-monitor', key: 'git' } as const, { repo: '', branch: '', ahead: 0, behind: 0, files: {} } as GitInfo, { shape: 'git-1' })
const viewAtom = atom(
  { plugin: 'activity-monitor', key: 'view' } as const,
  { root: "", expanded: [], query: "", showSettings: false, tick: 0 } as View,
  { shape: "view-3" },
)

// PaneSettings live in $.store too, so they carry over to every new session.
// By default the pane is always there: it opens with the session and when
// Claude starts working, and never closes on its own.
const DEFAULT_SETTINGS: PaneSettings = {
  autoOpen: true,
  closeAfter: 0,
  animations: true,
  showHidden: true,
  column: 'time',
  resetEachTask: true,
  showTokens: true,
}
// 'settings-2': the auto-close default changed to never, so a value saved
// under the old key keeps everything but its auto-close.
const STORE_KEY = 'settings-2'
const OLD_STORE_KEY = 'settings'
const settingsAtom = atom({ plugin: 'activity-monitor', key: 'settings' } as const, { ...DEFAULT_SETTINGS } as PaneSettings, { shape: 'settings-2' })
const CLOSE_CHOICES = [0, 2, 4, 8, 15, 30]

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
  teal: '#5eead4',
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
  browsing: 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10',
  searching: 'M11 4a7 7 0 1 0 0 14 7 7 0 1 0 0-14M20 20l-4-4',
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
  browsing: { label: 'RIGHT NOW', color: C.teal },
  searching: { label: 'RIGHT NOW', color: C.teal },
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

// A solid colour for the terminal, which takes no transparency: `color` laid
// over the pane's dark ground at `alpha`.
const GROUND = [0x1c, 0x1c, 0x1c]
const tint = (color: string, alpha: number) => {
  const m = /^#([0-9a-f]{6})/i.exec(color)
  if (!m || !m[1]) return undefined
  const n = parseInt(m[1], 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return '#' + rgb.map((c, i) => Math.round((GROUND[i] ?? 0) * (1 - alpha) + c * alpha).toString(16).padStart(2, '0')).join('')
}

// The status symbol in the terminal, in place of the drawn round icon.
const NOW_GLYPH: Record<Now['kind'], string> = {
  idle: '✻',
  thinking: '✻',
  reading: '◉',
  editing: '✎',
  running: '▸',
  browsing: '◍',
  searching: '⌕',
  done: '✓',
  committed: '✓',
}

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

// The toolbar's icons: a drawn icon in the desktop app, a symbol elsewhere.
const TOOLS = [
  { id: 'refresh', name: 'Refresh', glyph: '↻', path: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5' },
  { id: 'collapse', name: 'Collapse all folders', glyph: '⊟', path: 'm7 20 5-5 5 5M7 4l5 5 5-5' },
  { id: 'up', name: 'Up a folder', glyph: '↑', path: `${FOLDER}M12 10v6M9 13l3-3 3 3` },
  { id: 'home', name: 'Back to the project', glyph: '⌂', path: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z' },
  {
    id: 'settings',
    name: 'Settings',
    glyph: '⚙',
    path: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  },
] as const

async function toolAction($: Dollar, id: string) {
  if (id === 'refresh') {
    await refreshGit($)
    await update($, viewAtom, v => ({ ...v, tick: v.tick + 1 }))
  } else if (id === 'collapse') {
    await update($, viewAtom, v => ({ ...v, expanded: [] }))
  } else if (id === 'up') {
    const cwd = await $.session.cwd()
    await update($, viewAtom, v => ({ ...v, root: dirOf(v.root || cwd), expanded: [] }))
    await refreshGit($)
  } else if (id === 'home') {
    const cwd = await $.session.cwd()
    await update($, viewAtom, v => ({ ...v, root: cwd, expanded: [] }))
    await refreshGit($)
  } else if (id === 'settings') {
    await update($, viewAtom, v => ({ ...v, showSettings: !v.showSettings }))
  }
}

// The pane opens when Claude starts working and closes on its own a few
// seconds after Claude finishes (both in the settings). /files opens it by
// hand, and then it stays.
let closeTimer: Timer | undefined

// The toolbar icon under the pointer, '' for none. A passing look, so a
// module variable (a reload just forgets it) and a redraw when it changes.
let hovered = ''
const TOOL_PX = 22
const toolSvg = (d: string, color: string, isHover: boolean) =>
  svg(
    TOOL_PX,
    (isHover ? `<circle cx="11" cy="11" r="11" fill="#ffffff" fill-opacity="0.1"/>` : '') +
      `<g transform="translate(4 4) scale(${14 / 24})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>`,
  )

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
    let saved = (await $.store.get(STORE_KEY)) as Partial<PaneSettings> | undefined
    if (!saved) {
      const old = (await $.store.get(OLD_STORE_KEY)) as Partial<PaneSettings> | undefined
      if (old) {
        const { closeAfter: _oldClose, ...rest } = old
        saved = rest
      }
    }
    const s = await update($, settingsAtom, () => ({ ...DEFAULT_SETTINGS, ...(saved ?? {}) }))
    void refreshGit($)
    if (s.autoOpen) void openPane($)
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
    if (s.resetEachTask) {
      await update($, touchedAtom, () => [])
      await update($, webAtom, () => [])
      await update($, tokensAtom, () => ({ ...EMPTY_TOKENS, by: {} }))
    }
    waiting = undefined
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

    const visit = webOf(tool, input)
    if (visit) {
      const { host, path: rest } = siteOf(visit.target)
      await setWeb($, visit, true)
      await update($, nowAtom, () =>
        visit.kind === 'search'
          ? { kind: 'searching', title: 'Claude is searching the web', sub: `“${visit.target}”` }
          : { kind: 'browsing', title: `Claude is reading ${host}`, sub: rest || visit.target },
      )
      const ran = await next(e)
      await setWeb($, visit, false)
      return ran
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

  // Each model response: share out what it cost (see "tokens" above).
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      const u = r.usage
      if (u) {
        const fresh = u.input_tokens + u.cache_creation_input_tokens
        const out = u.output_tokens
        if (e.agentId) {
          // A subagent's steps all count toward "Subagents".
          await addTokens($, u.cache_read_input_tokens, fresh, out, [[['agents'], fresh + out]])
        } else {
          const asked = r.toolUses.map(t => thingOf(t.name, t.input))
          const before = waiting && waiting.turnId === e.turnId ? waiting.things : ['prompt']
          await addTokens($, u.cache_read_input_tokens, fresh, out, [
            [before, fresh],
            [asked.length ? asked : ['think'], out],
          ])
          waiting = { turnId: e.turnId, things: asked.length ? asked : ['think'] }
        }
      }
    } catch {
      // counting never gets in the way of the turn
    }
    return r
  })

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

  // A toolbar icon's click area (hit.tsx): a click, or the pointer coming
  // onto the icon or leaving it.
  on('ui.message', async ($, e, next) => {
    if (e.requestId === PANE && e.element.startsWith('hit-')) {
      const data = (e.data ?? {}) as { press?: unknown; over?: unknown; id?: unknown }
      if (typeof data.press === 'string') await toolAction($, data.press)
      else if (typeof data.over === 'boolean' && typeof data.id === 'string') {
        const nowOver = data.over ? data.id : hovered === data.id ? '' : hovered
        if (nowOver !== hovered) {
          hovered = nowOver
          $.ui.invalidate('ui.render')
        }
      }
      return {}
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input, Select } = els
    // The terminal draws no pictures: there every drawn icon, pill and
    // animation has a text twin (a coloured symbol, a tinted chip).
    const isGui = e.surface !== 'terminal'
    const Svg = isGui && 'Svg' in els ? (els as { Svg: ElementConstructor<SvgProps> }).Svg : null
    const Client = isGui && 'Client' in els ? (els as { Client: ElementConstructor<ClientProps> }).Client : null
    // Card look per surface: the terminal takes solid colours only and has
    // no room to spare, so its cards have dim solid borders and no blank rows.
    const K = isGui
      ? { border: C.border, hot: C.borderHot, card: C.card as string | undefined, padY: 1, gap: 1 }
      : { border: '#3c3c3c', hot: '#a0a0a0', card: undefined, padY: 0, gap: 0 }

    const [now, touched, g, view, settings, web, tokens] = await Promise.all([
      read($, nowAtom),
      read($, touchedAtom),
      read($, gitAtom),
      read($, viewAtom),
      read($, settingsAtom),
      read($, webAtom),
      read($, tokensAtom),
    ])
    const showTok = settings.showTokens !== false
    // A thing's token count, small and grey beside its pill; nothing before
    // Claude's next step has counted it.
    const tokOf = (key: string, k: string) => {
      const n = tokens.by[k] ?? 0
      return showTok && n >= 1 ? (
        <Box key={key} flexShrink={0}>
          <Text size="footnote" mono color={C.muted}>{fmtTok(n)}</Text>
        </Box>
      ) : null
    }
    const animate = settings.animations
    const root = view.root || (await $.session.cwd())
    const icon = (d: string, color: string, size: number, glyph: string) =>
      Svg ? <Svg source={lineIcon(d, color, size)} alt={glyph} width={size} height={size} /> : <Text color={color}>{glyph}</Text>

    // Labels: a small rounded drawing on the desktop; in the terminal a chip
    // of text on a soft tint of its colour, the closest a terminal gets.
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
        <Text weight="bold" color={color} backgroundColor={tint(color, 0.2)}>{` ${text} `}</Text>
      )
    const anim =(key: string, source: string, width: number, height: number, alt: string) =>
      Svg ? <Svg key={key} source={source} alt={alt} width={width} height={height} isInteractive /> : null

    const setView = (fn: (v: View) => View) => () => void update($, viewAtom, fn)
    const changedPaths = Object.keys(g.files)
    const changedCount = changedPaths.length
    const isWorking = ['reading', 'editing', 'running', 'browsing', 'searching'].includes(now.kind)
    const ns = NOW_STYLE[now.kind]

    // ----- Right now card -----
    const nowCard = (
      <Box
        key="now"
        flexDirection="column"
        borderStyle="round"
        borderColor={isWorking ? K.hot : K.border}
        backgroundColor={K.card}
        paddingX={2}
        paddingY={K.padY}
        gap={K.gap}
      >
        <Box flexDirection="row" gap={2} alignItems="center">
          {Svg ? (
            <Svg source={circleIcon(PATHS[now.kind], ns.color === C.muted ? '#cfcfcf' : ns.color, animate && (isWorking || now.kind === "thinking"))} alt={now.kind} width={44} height={44} isInteractive />
          ) : (
            // The round icon's twin: its symbol on a tint of its colour.
            <Text bold color={ns.color === C.muted ? '#cfcfcf' : ns.color} backgroundColor={tint(ns.color === C.muted ? '#cfcfcf' : ns.color, 0.18)}>
              {` ${NOW_GLYPH[now.kind]} `}
            </Text>
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
        <Box flexDirection="column" gap={K.gap}>
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
      <Box flexDirection="row" alignItems="center" gap={1} borderStyle="round" borderColor={K.border} paddingX={1}>
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

    // The toolbar icons (the gear on the top row, the rest beside "All
    // files"). In the desktop app each icon is a drawing with an invisible
    // click area over it (hit.tsx), since a Button's face can only be text;
    // the terminal, which draws no pictures, gets a one-symbol button.
    const toolIcon = (t: (typeof TOOLS)[number]) => {
      const isOn = t.id === 'settings' && view.showSettings
      const isHover = hovered === t.id
      const color = isOn || isHover ? C.fg : C.muted
      return Svg && Client ? (
        // A small bare icon. Under the pointer it turns white and a soft
        // round glow shows behind it, drawn inside its own square so
        // nothing around it moves.
        <Box key={`tool-${t.id}`} position="relative" flexShrink={0}>
          <Svg key={`tool-svg-${t.id}-${isHover ? 'on' : 'off'}`} source={toolSvg(t.path, color, isHover)} alt={t.name} width={TOOL_PX} height={TOOL_PX} />
          <Box position="absolute" top={0} left={0} right={0} bottom={0}>
            <Client key={`hit-${t.id}`} module="./hit.tsx" props={{ id: t.id } satisfies HitProps} width="100%" height="100%" />
          </Box>
        </Box>
      ) : (
        <Button key={`tool-${t.id}`} plain onPress={() => void toolAction($, t.id)}>
          <Text color={color} weight="bold">{t.glyph}</Text>
        </Button>
      )
    }
    const settingsIcon = TOOLS.filter(t => t.id === 'settings').map(toolIcon)
    const treeIcons = TOOLS.filter(t => t.id !== 'settings').map(toolIcon)

    // The top row: the mod's name, and the gear.
    const topRow = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
        <Text size="caption" weight="bold" color={C.muted}>ACTIVITY MONITOR</Text>
        {settingsIcon}
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
    // A setting with several values is a dropdown.
    const settingSelect = (key: string, label: string, value: string, options: { value: string; label: string }[], onSelect: (v: string) => void) => (
      <Box key={`sr:${key}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text color={C.fg}>{label}</Text>
        </Box>
        <Select key={`s:${key}`} options={options} value={value} onSelect={onSelect} />
      </Box>
    )
    const settingsCard = (
      <Box key="settings" flexDirection="column" borderStyle="round" borderColor={K.border} backgroundColor={K.card} paddingX={2} paddingY={K.padY} gap={K.gap}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="caption" weight="bold" color={C.muted}>SETTINGS</Text>
          <Button key="settings-done" plain onPress={setView(v => ({ ...v, showSettings: false }))}>
            <Text color={C.muted} weight="bold">Done</Text>
          </Button>
        </Box>
        {settingRow('open', 'Open automatically', onOff(settings.autoOpen), set(s => ({ ...s, autoOpen: !s.autoOpen })))}
        {settingSelect(
          'close',
          'Close after Claude finishes',
          String(settings.closeAfter),
          CLOSE_CHOICES.map(n => ({ value: String(n), label: n ? `After ${n} seconds` : 'Never' })),
          v => void saveSettings($, s => ({ ...s, closeAfter: Number(v) || 0 })),
        )}
        {settingRow('anim', 'Animations', onOff(settings.animations), set(s => ({ ...s, animations: !s.animations })))}
        {settingRow('reset', 'Clear the touched list each task', onOff(settings.resetEachTask), set(s => ({ ...s, resetEachTask: !s.resetEachTask })))}
        {settingRow('tokens', 'Token counts', onOff(showTok), set(s => ({ ...s, showTokens: s.showTokens === false })))}
        {settingRow('hidden','Hidden files', settings.showHidden ? 'Shown' : 'Hidden', set(s => ({ ...s, showHidden: !s.showHidden })))}
        {settingSelect(
          'column',
          'Right column',
          settings.column,
          [
            { value: 'time', label: 'Last modified' },
            { value: 'size', label: 'Size' },
          ],
          v => void saveSettings($, s => ({ ...s, column: v === 'size' ? 'size' : 'time' })),
        )}
        <Text size="footnote" color={C.muted}>Saved for every session. /files settings opens this.</Text>
      </Box>
    )

    // ----- Claude touched card -----
    const touchedCard = (
      <Box
        key="touched"
        flexDirection="column"
        borderStyle="round"
        borderColor={now.kind === 'committed' ? K.hot : K.border}
        backgroundColor={K.card}
        paddingX={2}
        paddingY={K.padY}
        gap={K.gap}
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
                <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                  {tokOf(`tk:${t.path}`, `file:${t.path}`)}
                  {chip(`p:${t.path}`, st.label, st.color)}
                </Box>
              </Box>
            )
          })
        )}
      </Box>
    )

    // ----- Web card: pages Claude read and searches it ran, this task -----
    // Shown only once there is something in it.
    const webCard = web.length > 0 && (
      <Box
        key="web"
        flexDirection="column"
        borderStyle="round"
        borderColor={web.some(v => v.isLive) ? K.hot : K.border}
        backgroundColor={K.card}
        paddingX={2}
        paddingY={K.padY}
        gap={K.gap}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text size="caption" weight="bold" color={C.muted}>CLAUDE ON THE WEB</Text>
          <Text size="caption" weight="bold" color={C.muted}>
            {web.length} {web.length === 1 ? 'VISIT' : 'VISITS'}
          </Text>
        </Box>
        {web.map(v => {
          const isSearch = v.kind === 'search'
          const { host, path: rest } = siteOf(v.target)
          const pill = isSearch ? (v.isLive ? 'Searching' : 'Searched') : v.isLive ? 'Reading' : 'Read'
          return (
            <Box key={`w:${v.kind}:${v.target}`} flexDirection="row" justifyContent="space-between" alignItems="center" paddingLeft={2} gap={1}>
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
                {chip(`wb:${v.kind}:${v.target}`, isSearch ? 'FIND' : 'WEB', C.teal, true)}
                <Box flexShrink={isSearch ? 1 : 0} minWidth={0}>
                  <Text weight="bold" color={C.fg} wrap="truncate-end">
                    {isSearch ? `“${v.target}”` : host}
                  </Text>
                </Box>
                {!isSearch && rest && (
                  <Box flexShrink={1} minWidth={0}>
                    <Text color={C.muted} wrap="truncate-end">{rest}</Text>
                  </Box>
                )}
              </Box>
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                {tokOf(`wt:${v.kind}:${v.target}`, `web:${v.kind}:${v.target}`)}
                {chip(`wp:${v.kind}:${v.target}`, pill, C.teal, false, v.isLive && animate)}
              </Box>
            </Box>
          )
        })}
      </Box>
    )

    // ----- Tokens card: where this task's tokens went -----
    const sumOf = (prefix: string) => Object.entries(tokens.by).reduce((n, [k, v]) => (k.startsWith(prefix) ? n + v : n), 0)
    const groups = [
      { id: 'files', label: 'Files', color: C.orange, n: sumOf('file:') },
      { id: 'web', label: 'Web', color: C.teal, n: sumOf('web:') },
      { id: 'cmd', label: 'Commands', color: C.blue, n: tokens.by.cmd ?? 0 },
      { id: 'agents', label: 'Subagents', color: C.purple, n: tokens.by.agents ?? 0 },
      { id: 'think', label: 'Thinking & replies', color: '#cfcfcf', n: tokens.by.think ?? 0 },
      { id: 'prompt', label: 'Your message & context', color: C.muted, n: tokens.by.prompt ?? 0 },
      { id: 'other', label: 'Other tools', color: C.faint, n: tokens.by.other ?? 0 },
    ].filter(x => x.n >= 1)
    const total = tokens.input + tokens.output
    const BAR_PX = 72
    const BAR_CH = 8
    const bar = (id: string, share: number, color: string) =>
      Svg ? (
        <Svg
          key={`tb:${id}`}
          source={`<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_PX}" height="22" viewBox="0 0 ${BAR_PX} 22"><rect x="0" y="9" width="${BAR_PX}" height="4" rx="2" fill="#ffffff" fill-opacity="0.08"/><rect x="0" y="9" width="${Math.max(3, Math.round(share * BAR_PX))}" height="4" rx="2" fill="${color}"/></svg>`}
          alt={`${Math.round(share * 100)}%`}
          width={BAR_PX}
          height={22}
        />
      ) : (
        <Text key={`tb:${id}`} color={color}>
          {'━'.repeat(Math.max(1, Math.round(share * BAR_CH)))}
          <Text color={K.border}>{'━'.repeat(BAR_CH - Math.max(1, Math.round(share * BAR_CH)))}</Text>
        </Text>
      )
    const tokensCard = showTok && total > 0 && (
      <Box key="tokens" flexDirection="column" borderStyle="round" borderColor={K.border} backgroundColor={K.card} paddingX={2} paddingY={K.padY} gap={K.gap}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text size="caption" weight="bold" color={C.muted}>TOKENS</Text>
          <Text size="caption" weight="bold" color={C.muted}>{fmtTok(total)} THIS TASK</Text>
        </Box>
        <Box flexDirection="column">
          {groups.map(x => (
            <Box key={`tg:${x.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" paddingLeft={2} gap={1}>
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
                <Text color={x.color}>●</Text>
                <Text color={C.fg} wrap="truncate-end">{x.label}</Text>
              </Box>
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                {bar(x.id, x.n / total, x.color)}
                <Box width={6} alignItems="flex-end">
                  <Text mono color={C.fg}>{fmtTok(x.n)}</Text>
                </Box>
              </Box>
            </Box>
          ))}
        </Box>
        <Text size="footnote" color={C.muted} wrap="truncate-end">
          {fmtTok(tokens.input)} in · {fmtTok(tokens.output)} out{tokens.cached >= 1 ? ` · ${fmtTok(tokens.cached)} reread from cache` : ''}
        </Text>
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
            // The terminal can't animate the sweep: there the live row is a
            // soft tint of its colour instead.
            backgroundColor={isLive && !isGui ? tint(STATUS[st!].color, 0.14) : undefined}
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
              {isLive && animate && Svg ? (
                anim(`d:${r.path}`, liveDot(STATUS[st!].color), 14, 14, 'live')
              ) : isLive ? (
                <Text color={STATUS[st!].color}>●</Text>
              ) : (
                // In the terminal the chevron takes the folder icon's colour.
                <Text color={!isGui && r.isDir ? (under ? C.yellow : isDot ? C.muted : C.blue) : C.faint}>
                  {r.isDir ? (isOpen ? '▾' : '▸') : ' '}
                </Text>
              )}
              {r.isDir ? (
                Svg ? icon(PATHS.folder, under ? C.yellow : isDot ? C.muted : C.blue, 18, '▤') : null
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
        {topRow}
        {nowCard}
        {view.showSettings ? (
          settingsCard
        ) : (
          <Box flexDirection="column" gap={1}>
            {touchedCard}
            {webCard}
            {tokensCard}
            {search}
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1} marginTop={1} gap={1}>
              <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                <Text size="caption" weight="bold" color={C.muted}>{view.query.trim() ? 'SEARCH' : 'ALL FILES'}</Text>
                <Text size="caption" weight="bold" color={C.faint} wrap="truncate-middle">
                  {base(g.repo && root.startsWith(g.repo) ? g.repo : root).toUpperCase()}
                </Text>
              </Box>
              <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                {treeIcons}
              </Box>
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

export type NowKind =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'running'
  | 'browsing'
  | 'searching'
  | 'done'
  | 'committed'

export type Now = { kind: NowKind; title: string; sub: string }

export type TouchStatus = 'reading' | 'opened' | 'editing' | 'edited' | 'committed'

export type Touched = { path: string; status: TouchStatus }

/** A web page Claude read, or a web search it ran, in this task. */
export type WebVisit = {
  kind: 'page' | 'search'
  /** the page's address, or the search's words */
  target: string
  isLive: boolean
}

/**
 * Tokens this task. The raw counts are the API's; `weighted` and `by` are
 * cost-weighted: every kind of token counted at what it costs next to a
 * plain input token on the model that answered (output 5x, cache writes
 * 1.25x or 2x, cache reads 0.025x to 0.1x). `by` maps a thing to its share:
 * `file:<path>`, `web:<kind>:<target>`, or a group: `cmd`, `agents`,
 * `think`, `prompt`, `other`.
 */
export type Tokens = {
  input: number
  output: number
  /** written to the prompt cache */
  writes: number
  /** served again from the prompt cache */
  cached: number
  weighted: number
  by: Record<string, number>
  /** the cost estimate when the task began, to show its share */
  start: { usd?: number }
}

/** The engine's live readings: cost so far and the conversation's size. */
export type Meter = {
  usd?: number
  context?: { tokens: number; window: number }
}

export type GitFile ={ code: string; add: number; del: number }

export type GitInfo = {
  repo: string
  branch: string
  ahead: number
  behind: number
  files: Record<string, GitFile>
}

export type View = {
  root: string
  expanded: string[]
  query: string
  showSettings: boolean
  /** bumped by the refresh button to redraw the tree */
  tick: number
}

export type PaneSettings = {
  /** open the pane when Claude starts working */
  autoOpen: boolean
  /** seconds after Claude finishes before the pane closes; 0 keeps it open */
  closeAfter: number
  /** the pulsing dot, the row sweep and the breathing status icon */
  animations: boolean
  showHidden: boolean
  /** what the tree's right column shows for a file */
  column: 'time' | 'size'
  /** start "Claude touched" empty on each new task */
  resetEachTask: boolean
  /** token counts on each file, site and in the Tokens card */
  showTokens: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'activity-monitor': {
      now: Shaped<Now>
      touched: Shaped<Touched[]>
      web: Shaped<WebVisit[]>
      tokens: Shaped<Tokens>
      meter: Shaped<Meter>
      git: Shaped<GitInfo>
      view: Shaped<View>
      settings: Shaped<PaneSettings>
    }
  }
}

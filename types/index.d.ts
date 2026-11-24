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
 * Tokens this task, as the API counted them. `by` maps a thing to its new
 * tokens (uncached input + cache writes + output): `file:<path>`,
 * `web:<kind>:<target>`, or a group: `cmd`, `agents`, `think`, `prompt`, `other`.
 */
export type Tokens = {
  input: number
  output: number
  /** input the prompt cache served again: cheap, so kept apart */
  cached: number
  by: Record<string, number>
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
      git: Shaped<GitInfo>
      view: Shaped<View>
      settings: Shaped<PaneSettings>
    }
  }
}

export type NowKind =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'running'
  | 'done'
  | 'committed'

export type Now = { kind: NowKind; title: string; sub: string }

export type TouchStatus = 'reading' | 'opened' | 'editing' | 'edited' | 'committed'

export type Touched = { path: string; status: TouchStatus }

export type GitFile = { code: string; add: number; del: number }

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
}

declare module 'claude-code' {
  interface PluginState {
    'activity-files': {
      now: Shaped<Now>
      touched: Shaped<Touched[]>
      git: Shaped<GitInfo>
      view: Shaped<View>
      settings: Shaped<PaneSettings>
    }
  }
}

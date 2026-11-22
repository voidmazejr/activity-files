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
  showHidden: boolean
  showSizes: boolean
  query: string
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'activity-files': {
      now: Shaped<Now>
      touched: Shaped<Touched[]>
      git: Shaped<GitInfo>
      view: Shaped<View>
    }
  }
}

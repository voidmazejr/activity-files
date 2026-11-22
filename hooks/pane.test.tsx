import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'activity-files',
  component: 'Pane',
  requestId: 'activity-files',
  props: {
    title: 'Files: weather-app',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const FILES: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  '/w': [
    { name: 'src', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
  ],
  '/w/src': [{ name: 'client.js', kind: 'file' }],
}

test('the pane follows a read and an edit, on every surface', async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.list', (_, e) => ({
    value: (FILES[String((e as { path?: string }).path)] ?? []).map(f => ({ ...f, size: 10, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const out = argv.includes('--show-toplevel') ? '/w\n' : argv.includes('status') ? '## main...origin/main [ahead 1]\n M src/client.js\n' : argv.includes('--numstat') ? '1\t1\tsrc/client.js\n' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // While the Edit runs, draw the pane: the live row (pulsing dot, shining
  // pill) must draw on every surface without throwing.
  const liveChecks: boolean[] = []
  on('tool.call', async (_, e) => {
    if (e.tool === 'Edit') {
      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await $.ui.mount({ ...PANE, surface })
        liveChecks.push(
          !!(surface === 'desktop'
            ? await ui.find({ type: 'Box', key: 'rp:/w/src/client.js' })
            : await ui.find({ type: 'Text', text: /^editing$/ })),
        )
        await ui.unmount()
      }
    }
    return { result: {} }
  })

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/w/src/client.js' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/src/client.js', old_string: 'a', new_string: 'b' })
  expect(liveChecks).toEqual([true, true])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /editing client\.js/ }))?.text).toBe('Claude is editing client.js')
    expect((await ui.find({ type: 'Text', text: /CLAUDE TOUCHED/ }))?.text).toBe('CLAUDE TOUCHED')
    expect(surface === 'desktop' ? await ui.find({ type: 'Box', key: 'p:/w/src/client.js' }) : await ui.find({ type: 'Text', text: /Edited/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1 changed/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the pane opens with a turn and closes a few seconds after it', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const events: string[] = []
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => {
    events.push('open')
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    events.push('close')
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  expect(events).toEqual([])

  await $.turn.start({ text: 'go' } as never)
  await clock.advance(0)
  expect(events).toEqual(['open'])

  await $.turn.complete({ reason: 'end_turn', turnId: 't1' } as never)
  await clock.advance(3000)
  expect(events).toEqual(['open'])
  await clock.advance(1500)
  expect(events).toEqual(['open', 'close'])
})

test('settings change from the pane and are kept for the next session', async ($, on) => {
  const stored: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: stored[String((e as { key: string }).key)] }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    stored[key] = value
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: /SETTINGS/ })).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 's:close' }))?.text).toBe('4 s')

  await ui.press({ key: 's:close' })
  expect((await ui.find({ type: 'Button', key: 's:close' }))?.text).toBe('8 s')
  await ui.press({ key: 's:anim' })
  expect((await ui.find({ type: 'Button', key: 's:anim' }))?.text).toBe('Off')
  expect(stored.settings).toEqual(expect.objectContaining({ closeAfter: 8, animations: false }))
  await ui.unmount()
})

import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'activity-monitor',
  component: 'Pane',
  requestId: 'activity-monitor',
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
            : await ui.find({ type: 'Text', text: /^\s*editing\s*$/ })),
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

test('by default the pane opens with the session and never closes by itself', async ($, on) => {
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
  await clock.advance(0)
  expect(events).toEqual(['open'])

  await $.turn.start({ text: 'go' } as never)
  await $.turn.complete({ reason: 'end_turn', turnId: 't1' } as never)
  await clock.advance(120_000)
  expect(events).not.toContain('close')
})

test('with a close delay set, the pane closes that long after Claude finishes', async ($, on) => {
  mock.store(on, { 'settings-2': { closeAfter: 4 } })
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
  await $.turn.start({ text: 'go' } as never)
  await clock.advance(0)
  expect(events).not.toContain('close')

  await $.turn.complete({ reason: 'end_turn', turnId: 't1' } as never)
  await clock.advance(3000)
  expect(events).not.toContain('close')
  await clock.advance(1500)
  expect(events[events.length - 1]).toBe('close')
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
  // The pointer comes onto the gear (its hover look) and leaves again.
  await ui.pointer({ type: 'move', x: 0, y: 0, in: 'hit-settings' })
  await ui.pointer({ type: 'leave', x: 0, y: 0, in: 'hit-settings' })
  // A click on the drawn gear icon: its click area hears the pointer.
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'hit-settings' })
  expect(await ui.find({ type: 'Text', text: /SETTINGS/ })).toBeTruthy()
  // The auto-close dropdown starts at Never; pick 8 seconds from it.
  expect(await ui.find({ type: 'Select', key: 's:close' })).toBeTruthy()
  await ui.select({ key: 's:close', value: '8' })
  await ui.press({ key: 's:anim' })
  expect((await ui.find({ type: 'Button', key: 's:anim' }))?.text).toBe('Off')
  expect(stored['settings-2']).toEqual(expect.objectContaining({ closeAfter: 8, animations: false }))
  await ui.unmount()
})

test('tokens are shared out to the files and sites each step worked on', async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', () => ({ turnId: 't1' }))
  const usage = (input: number, output: number, cached = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    model: 'm',
  })
  // Step 0 reads a file, step 1 searches, step 2 replies.
  const steps = [
    { toolUses: [{ name: 'Read', input: { file_path: '/w/src/client.js' } }], usage: usage(3000, 100) },
    { toolUses: [{ name: 'WebSearch', input: { query: 'retry jitter' } }], usage: usage(1500, 50, 20_000) },
    { toolUses: [], usage: usage(800, 400, 21_000) },
  ]
  on('turn.step', async function* (_, e) {
    const s = steps[e.index]!
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn' as const, ...s }
  })

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  for (let i = 0; i < 3; i++) {
    const it = $.turn.step({ turnId: 't1', index: i, model: 'm', messageCount: 1 } as never) as AsyncIterable<unknown>
    for await (const _ of it) void _
  }
  await $.tool.call({ tool: 'Read', file_path: '/w/src/client.js' })
  await $.tool.call({ tool: 'WebSearch', query: 'retry jitter', mode: 'standard' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // client.js: step 0's output (100) + step 1's new input (1500) = 1.6k
    expect(await ui.find({ type: 'Text', text: /^1\.6k$/ })).toBeTruthy()
    // the search: step 1's output (50) + step 2's new input (800) = 850
    expect(await ui.find({ type: 'Text', text: /^850$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /5\.8k THIS TASK/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Your message & context/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /41k reread from cache/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('web pages and searches show in the status card and the web card', async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const during: string[] = []
  on('tool.call', async (_, e) => {
    if (e.tool === 'WebFetch') {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      during.push((await ui.find({ type: 'Text', text: /Claude is reading/ }))?.text ?? '')
      await ui.unmount()
    }
    return { result: {} }
  })

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'WebSearch', query: 'claude code mods', mode: 'standard' })
  await $.tool.call({ tool: 'WebFetch', url: 'https://www.example.com/docs/page', prompt: 'read it' })
  expect(during).toEqual(['Claude is reading example.com'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /CLAUDE ON THE WEB/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /claude code mods/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^example\.com$/ }))?.text).toBe('example.com')
    expect((await ui.find({ type: 'Text', text: /^\/docs\/page$/ }))?.text).toBe('/docs/page')
    await ui.unmount()
  }
})

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { StartupError } from '@deepseek-ai/dsh-app-boot'
import { reportStartupFailure } from '../src/startup-diagnostics.ts'

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-startup-diagnostics-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function startupError(reason: unknown): StartupError {
  const error = new StartupError('dsh: startup failed: 1 required plugin did not activate', [
    { id: 'webserver', module: './webserver.mjs', required: true, fiberState: 3, outcome: { kind: 'failed', error: reason } },
    { id: 'waiting', module: './waiting.mjs', required: false, fiberState: 0, outcome: { kind: 'pending', missing: ['webServer'] } },
  ])
  error.startup = {
    configurationPath: '/example/cordis.yml',
    messages: [{ ts: 1, name: 'loader', type: 'error', args: [reason] }],
  }
  return error
}

describe('startup diagnostic files', () => {
  it('prints the summary and saved path to stderr by default', async () => {
    const dir = await home()
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((_text, callback?: BufferEncoding | ((error?: Error | null) => void)) => {
      if (typeof callback === 'function') callback()
      return true
    })
    onTestFinished(() => { write.mockRestore() })
    await reportStartupFailure(startupError('failed'), { home: dir, version: '1.2.3', profile: 'web' })
    expect(write).toHaveBeenCalledWith(expect.stringContaining('dsh: startup failed:'), expect.any(Function))
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`Full diagnostics: ${join(dir, 'logs')}`), expect.any(Function))
  })

  it('names the occupied address and the ways out when a plugin cannot bind', async () => {
    const dir = await home()
    const address = '127.0.0.1:3080'
    const error = startupError(new Error(`listen EADDRINUSE: address already in use ${address}`))
    error.message = 'dsh: startup failed: 2 required plugins did not activate'
      + '\n\nFailed plugins (1):\n  webserver (required)'
      + `\n    Package: @deepseek-ai/dsh-host-webserver\n    Error: listen EADDRINUSE: address already in use ${address}`
    const chunks: string[] = []

    await reportStartupFailure(error, { home: dir, version: '1.2.3', profile: 'web' }, (text) => { chunks.push(text) })

    const output = chunks.join('')
    // The real message carries no trailing newline; this pins the single blank line before the advice.
    expect(output).toContain(`${error.message}\n\ndsh: ${address} is already in use:`)
    expect(output).toContain('dsh web --port <port>')
    // The advice is terminal-only; the saved report keeps the raw failure.
    const files = await readdir(join(dir, 'logs'))
    expect(await readFile(join(dir, 'logs', files[0]!), 'utf8')).not.toContain('is already in use')
  })

  it('adds no bind advice when the bind failed for another reason', async () => {
    const dir = await home()
    const error = startupError(new Error('listen EACCES: permission denied 127.0.0.1:80'))
    error.message = 'dsh: startup failed: 1 required plugin did not activate'
      + '\n\nFailed plugins (1):\n  webserver (required)'
      + '\n    Error: listen EACCES: permission denied 127.0.0.1:80'
    const chunks: string[] = []

    await reportStartupFailure(error, { home: dir, version: '1.2.3', profile: 'web' }, (text) => { chunks.push(text) })

    // An unmatched failure keeps exactly the summary-to-report separator.
    expect(chunks.join('')).toContain(`${error.message}\n\nFull diagnostics: `)
    expect(chunks.join('')).not.toContain('is already in use')
  })

  it('waits for stderr completion before resolving', async () => {
    const dir = await home()
    const pending: Array<() => void> = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((_text, callback?: BufferEncoding | ((error?: Error | null) => void)) => {
      if (typeof callback === 'function') pending.push(() => { callback() })
      return false
    })
    onTestFinished(() => { write.mockRestore() })
    let finished = false
    const report = reportStartupFailure(startupError('failed'), { home: dir, version: '1.2.3', profile: 'web' })
      .then(() => { finished = true })
    expect(pending).toHaveLength(1)
    pending.shift()!()
    await vi.waitFor(() => { expect(pending).toHaveLength(1) })
    expect(finished).toBe(false)
    pending.shift()!()
    await report
    expect(finished).toBe(true)
  })

  it('rejects when stderr cannot complete the write', async () => {
    const dir = await home()
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((_text, callback?: BufferEncoding | ((error?: Error | null) => void)) => {
      if (typeof callback === 'function') callback(new Error('stderr closed'))
      return false
    })
    onTestFinished(() => { write.mockRestore() })
    await expect(reportStartupFailure(startupError('failed'), { home: dir, version: '1.2.3', profile: 'web' }))
      .rejects.toThrow('stderr closed')
  })

  it('retains original error properties, causes, aggregate members, cycles, and long values', async () => {
    const dir = await home()
    const chunks: string[] = []
    const large = 'x'.repeat(12_000) + 'END_OF_VALUE'
    const leaf = Object.assign(new Error('cannot listen'), { code: 'EADDRINUSE', payload: large })
    Object.defineProperty(leaf, 'hiddenDetail', { value: 'non-enumerable detail' })
    const symbol = Symbol('diagnostic-field')
    Object.assign(leaf, { [symbol]: 42n, self: leaf, values: Array.from({ length: 105 }, (_, i) => `value-${i}`) })
    let inspected = false
    let getterRead = false
    Object.defineProperty(leaf, inspect.custom, { value: () => { inspected = true; return 'hidden by custom inspector' } })
    Object.defineProperty(leaf, 'lazy', { get: () => { getterRead = true; return 'evaluated getter' } })
    const aggregate = new AggregateError([leaf, { transport: 'closed' }], 'activation failed', { cause: leaf })
    const error = startupError(aggregate)

    await reportStartupFailure(error, { home: dir, version: '1.2.3', profile: 'web' }, (text) => { chunks.push(text) })

    const files = await readdir(join(dir, 'logs'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^startup-[\w.-]+\.log$/u)
    const path = join(dir, 'logs', files[0]!)
    expect(chunks.join('')).toBe(`${error.message}\n\nFull diagnostics: ${path}\n`)
    const report = await readFile(path, 'utf8')
    expect(report.startsWith(
      'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.\n\n',
    )).toBe(true)
    for (const text of [
      'dshVersion: \'1.2.3\'', "profile: 'web'", process.version, 'configurationPath:', '/example/cordis.yml',
      "module: './waiting.mjs'", 'required: false', 'fiberState: 0', "missing: [ 'webServer'", 'messages:',
      'AggregateError: activation failed', '[cause]', '[errors]', 'EADDRINUSE', '[hiddenDetail]',
      'non-enumerable detail', 'Symbol(diagnostic-field)', '42n', '[Circular', large, 'value-104', '[Getter]',
      'transport:', 'closed', 'at startupError',
    ]) expect(report).toContain(text)
    expect(inspected).toBe(false)
    expect(getterRead).toBe(false)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir, 'logs'))).mode & 0o777).toBe(0o700)
    }
  })

  it('creates distinct files for concurrent failures without replacing earlier reports', async () => {
    const dir = await home()
    await Promise.all(['first', 'second'].map(reason => reportStartupFailure(
      startupError(reason), { home: dir, version: '1.2.3', profile: 'web' }, () => {},
    )))
    const files = await readdir(join(dir, 'logs'))
    expect(files).toHaveLength(2)
    const reports = await Promise.all(files.map(file => readFile(join(dir, 'logs', file), 'utf8')))
    expect(reports.filter(report => report.includes("error: 'first'"))).toHaveLength(1)
    expect(reports.filter(report => report.includes("error: 'second'"))).toHaveLength(1)
  })

  it('prints the complete report when the logs directory cannot be created', async () => {
    const dir = await home()
    await writeFile(join(dir, 'logs'), 'blocked')
    const chunks: string[] = []
    await reportStartupFailure(startupError({ code: 'CUSTOM', value: 'original details' }), {
      home: dir, version: '1.2.3', profile: 'web',
    }, (text) => { chunks.push(text) })
    const output = chunks.join('')
    expect(output).toContain('dsh: startup failed:')
    expect(output).toContain('dsh: warning: could not write startup diagnostics:')
    expect(output).toContain('Full diagnostics:\n')
    expect(output).toContain('original details')
    expect(output).toContain('CUSTOM')
    expect(output).not.toContain('Full diagnostics: ')
    expect(await readFile(join(dir, 'logs'), 'utf8')).toBe('blocked')
  })
})

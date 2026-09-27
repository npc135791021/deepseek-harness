/** Save original startup diagnostics while keeping the terminal report concise. */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import type { StartupError } from '@deepseek-ai/dsh-app-boot'

/** Launcher-owned context; no environment values or plugin configurations are collected. */
interface StartupDiagnosticContext {
  home: string
  version: string
  profile: string
}

/**
 * Node's `listen` failure text, whose capture group names the address that could not be bound.
 * The desktop host matches only the shorter `listen EADDRINUSE` prefix for its dialog, so the address
 * clause required here is what lets the terminal name the address; a reworded failure drops the advice.
 */
const ADDRESS_ALREADY_IN_USE = /\blisten EADDRINUSE: address already in use (\S+)/u

/**
 * Terminal advice for an occupied listen address, or an empty string for every other startup failure.
 * The saved report keeps the raw plugin failure; this only names the address and the operator's options,
 * and `dsh web` is the shipped listener whose `--port` flag moves the bind.
 * @param error - startup audit failure whose message renders the failed plugins.
 * @returns the blank line and the advice lines that follow the summary, each line ending in a newline,
 * or an empty string when the failure is not an occupied listen address.
 */
function bindAdvice(error: StartupError): string {
  const address = ADDRESS_ALREADY_IN_USE.exec(error.message)?.[1]
  if (address === undefined) return ''
  return `\ndsh: ${address} is already in use: something is listening there, often another DSH instance (such as dsh web or the desktop app).\n`
    + 'dsh: Use that instance, quit it and retry, or serve this one on another port (dsh web --port <port>).\n'
}

/** Wait for stderr to finish the write before the failed process exits. */
function writeStderr(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write(text, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * Print the startup summary, name the ways out of an occupied listen address, and save a private,
 * uniquely named report under DSH_HOME/logs.
 * Failed writes print the complete report to stderr instead of claiming a saved path.
 * @param error - startup audit failure retaining plugin metadata and original errors.
 * @param context - resolved Harness home, application version, and selected profile.
 * @param write - terminal output sink; awaited before returning, defaults to stderr.
 * @returns after saving or printing the report and completing terminal writes.
 */
export async function reportStartupFailure(
  error: StartupError,
  context: StartupDiagnosticContext,
  write: (text: string) => void | Promise<void> = writeStderr,
): Promise<void> {
  const now = new Date().toISOString()
  const report = 'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.\n\n' + inspect({
    timestamp: now,
    dshVersion: context.version,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    profile: context.profile,
    error,
  }, {
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    showHidden: true,
    customInspect: false,
    getters: false,
    colors: false,
  }) + '\n'
  // The trailing newline ends the summary line; bindAdvice owns the blank line and the advice when it applies.
  await write(`${error.message}\n${bindAdvice(error)}`)
  const logDir = join(context.home, 'logs')
  const logPath = join(logDir, `startup-${now.replaceAll(':', '-')}-${randomUUID()}.log`)
  try {
    await mkdir(logDir, { recursive: true, mode: 0o700 })
    await writeFile(logPath, report, { flag: 'wx', mode: 0o600 })
  } catch (writeError) {
    await write(`\ndsh: warning: could not write startup diagnostics: ${String(writeError)}\nFull diagnostics:\n${report}`)
    return
  }
  await write(`\nFull diagnostics: ${logPath}\n`)
}

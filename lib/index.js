/**
 * dsh-cache-report — DSH slash-command plugin.
 *
 * Registers `/cache-report` (and nothing else). It deliberately registers
 * **no tools**: tool definitions sit at the very front of every request, so
 * adding one would invalidate the prompt cache for every open session. This
 * plugin therefore costs nothing to keep installed.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const run = promisify(execFile)

/** Sibling copy shipped with this package; falls back to a standalone install. */
const SIBLING = fileURLToPath(new URL('./report.mjs', import.meta.url))
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const FALLBACK = join(HOME, 'tools', 'dsh-cache-report.mjs')

function scriptPath() {
  if (process.env.DSH_CACHE_REPORT_SCRIPT) return process.env.DSH_CACHE_REPORT_SCRIPT
  if (existsSync(SIBLING)) return SIBLING
  return FALLBACK
}

const SUBS = new Map([
  ['today', 180000],
  ['days', 300000],
  ['tools', 900000],
  ['before-after', 300000],
  ['ba', 300000],
  ['debug', 300000],
  ['help', 15000],
])
const MAX_TEXT = 20000

export const name = 'cache-report'
export const inject = ['commands']

export function apply(ctx) {
  ctx.commands.register({
    name: 'cache-report',
    description: 'Prompt-cache hit rate and tool-block cost report (no argument = today)',
    input: { hint: '[today | days N | tools N | before-after H | help]' },
    handler: async ({ rawInput }) => {
      const trimmed = String(rawInput || '').trim()
      const args = trimmed === '' ? ['today'] : trimmed.split(/\s+/)
      const sub = args[0].toLowerCase()
      if (!SUBS.has(sub)) {
        return {
          kind: 'error',
          text: `Unknown subcommand "${args[0]}". Available: today | days [N] | tools [N] | before-after [H] | help`,
        }
      }
      try {
        const { stdout } = await run(process.execPath, [scriptPath(), ...args], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: SUBS.get(sub),
          windowsHide: true,
        })
        const text = String(stdout || '').trimEnd() || '(no output)'
        return { kind: 'success', text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n… (truncated)' : text }
      } catch (e) {
        const out = `${e.stdout || ''}${e.stderr ? '\n' + e.stderr : ''}`.trim()
        return { kind: 'error', text: `Failed: ${e.message}${out ? '\n' + out : ''}`.slice(0, 4000) }
      }
    },
  })
}

export default { name, inject, apply }

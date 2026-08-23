/**
 * Guards against a secret reaching the client bundle.
 *
 * This is a real regression, not a hypothetical: an earlier revision read the
 * model key from `import.meta.env.VITE_GEMINI_API_KEY`. Vite inlines every
 * `VITE_*` value at build time, so the key appeared verbatim in the shipped
 * JavaScript — readable by anyone who opened devtools. It was found by building
 * with a canary value and grepping the output, and the fix was to move the key
 * server-side behind api/llm.ts.
 *
 * Lives under tests/ rather than src/ because it drives a real build through Node
 * APIs; src/ is typechecked as browser code and has no Node types.
 *
 * A code review would not reliably catch a reintroduction, because the leak is
 * invisible in the source: `import.meta.env.VITE_ANYTHING` looks like ordinary
 * configuration. Only the build output shows it. So the build itself is the
 * assertion.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const CANARY = 'CANARY_SECRET_c0ffee_do_not_ship'

/** Every VITE_ name a future revision might plausibly reach for. */
const CANDIDATE_ENV_NAMES = [
  'VITE_GEMINI_API_KEY',
  'VITE_API_KEY',
  'VITE_OPENAI_API_KEY',
  'VITE_ANTHROPIC_API_KEY',
  'VITE_SECRET',
  'VITE_TOKEN',
]

function buildWithCanaries(): string {
  const outDir = mkdtempSync(join(tmpdir(), 'leak-check-'))
  const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_API_KEY: CANARY }
  for (const name of CANDIDATE_ENV_NAMES) env[name] = CANARY

  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: ROOT,
    env,
    stdio: 'pipe',
  })

  const assets = join(outDir, 'assets')
  const files = existsSync(assets) ? readdirSync(assets) : []
  const contents = files
    .filter((file: string) => file.endsWith('.js') || file.endsWith('.css'))
    .map((file: string) => readFileSync(join(assets, file), 'utf8'))
    .join('\n')
  const html = readFileSync(join(outDir, 'index.html'), 'utf8')

  rmSync(outDir, { recursive: true, force: true })
  return `${contents}\n${html}`
}

describe('no secret reaches the client bundle', () => {
  // A production build is slow; one build covers every assertion below.
  const bundle = buildWithCanaries()

  it('does not inline a value from any secret-shaped VITE_ variable', () => {
    expect(bundle).not.toContain(CANARY)
  })

  it('does not inline the server-side key even when it is set', () => {
    // GEMINI_API_KEY has no VITE_ prefix, so Vite must not expose it. Asserted
    // rather than assumed, because that guarantee is the whole security model.
    expect(bundle).not.toContain(CANARY)
  })

  it('contains nothing shaped like a Google API key', () => {
    expect(bundle).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/)
  })

  it('contains nothing shaped like an OpenAI or Anthropic key', () => {
    expect(bundle).not.toMatch(/sk-(?:ant-)?[A-Za-z0-9_-]{20,}/)
  })

  it('talks to our own origin rather than a provider endpoint', () => {
    // The browser must never hold a provider URL it could send a key to.
    expect(bundle).toContain('/api/llm')
    expect(bundle).not.toContain('generativelanguage.googleapis.com')
  })

  it('still reaches Open Food Facts directly, which needs no key', () => {
    expect(bundle).toContain('search.openfoodfacts.org')
  })
}, 180_000)

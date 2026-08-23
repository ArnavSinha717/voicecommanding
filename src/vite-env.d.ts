/// <reference types="vite/client" />

/**
 * No `VITE_`-prefixed secrets exist, deliberately.
 *
 * Vite inlines every `VITE_*` value into the client bundle, so a key configured
 * that way is readable by anyone who opens devtools. An earlier revision did
 * exactly that; a canary build proved the value appeared verbatim in
 * `dist/assets/*.js`. The model key now lives only in the server environment as
 * `GEMINI_API_KEY`, read by api/llm.ts.
 *
 * `src/config.leak.test.ts` fails the build if a key-shaped literal ever reaches
 * the bundle again.
 */
interface ImportMetaEnv {
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

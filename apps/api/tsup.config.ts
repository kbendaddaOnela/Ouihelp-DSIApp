import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  bundle: true,
  // Bundle ALL npm deps — Oryx reuses a stale node_modules.tar.gz and misses new packages
  noExternal: [/^(?!node:)/],
  sourcemap: true,
  clean: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
})

import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  bundle: true,
  noExternal: [/@dsi-app\/.*/, /^mysql2($|\/)/, /^drizzle-orm($|\/)/, /^sql-escaper($|\/)/],
  sourcemap: true,
  clean: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
})

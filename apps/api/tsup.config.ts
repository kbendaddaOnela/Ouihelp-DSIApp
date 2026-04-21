import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  bundle: true,
  noExternal: [/@dsi-app\/.*/],
  sourcemap: true,
  clean: true,
})

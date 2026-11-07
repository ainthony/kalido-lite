import { defineConfig } from 'vite';

// base './' lets the build work from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  build: { target: 'es2020', outDir: 'dist' },
});

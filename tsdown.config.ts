import { defineConfig } from 'tsdown';

export default defineConfig({
  minify: true,
  entry: { index: 'bin/automerge.ts' },
  fixedExtension: false,
});

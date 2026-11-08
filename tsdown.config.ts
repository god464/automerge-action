import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/main.ts' },
  minify: true,
  fixedExtension: false,
  deps: { alwaysBundle: [/./] },
});

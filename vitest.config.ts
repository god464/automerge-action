import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep test discovery inside the project: the default glob otherwise picks
    // up unrelated `*.test.ts` files from `.direnv/flake-inputs`, making the
    // suite non-hermetic.
    include: ['test/**/*.test.ts'],
  },
});

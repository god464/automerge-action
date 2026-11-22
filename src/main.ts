import { setFailed } from '@actions/core';

import { createPlatform } from '@/platform';
import { runAction } from '@/run-action';

runAction(createPlatform()).catch((error: unknown) => {
  setFailed(error instanceof Error ? error.message : String(error));
});

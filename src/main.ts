import * as core from '@actions/core';

import { createPlatform } from '@/platform';
import { runAction } from '@/run-action';

runAction(createPlatform()).catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

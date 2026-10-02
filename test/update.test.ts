import { expect, test } from 'vitest';

import { update } from '../lib/update.js';
import { createConfig } from '../lib/common.js';
import type { Context } from '../lib/types.js';
import { pullRequest } from './common.js';

test('update will only run when the label matches', async () => {
  const pr = pullRequest();
  const config = createConfig({ UPDATE_LABELS: 'none' });
  // the label check short-circuits before any API call, so octokit and the
  // token are not needed for this test
  const context = { config } as unknown as Context;
  expect(await update(context, pr)).toEqual(false);
});

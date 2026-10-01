import { expect, test } from 'vitest';

import { update } from '../lib/update';
import { createConfig } from '../lib/common';
import type { Context } from '../lib/types';
import { pullRequest } from './common';

test('update will only run when the label matches', async () => {
  const pr = pullRequest();
  const config = createConfig({ UPDATE_LABELS: 'none' });
  // the label check short-circuits before any API call, so octokit and the
  // token are not needed for this test
  const context = { config } as unknown as Context;
  expect(await update(context, pr)).toEqual(false);
});

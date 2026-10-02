import { logger, tmpdir, sleep } from './common.js';
import type { Context, PullRequest } from './types.js';
import type { Octokit } from '@octokit/rest';
import * as git from './git.js';

const FETCH_TIMEOUT = 60000;

export async function update(context: Context, pullRequest: PullRequest): Promise<boolean> {
  if (skipPullRequest(context, pullRequest)) {
    return false;
  }

  logger.info(`Updating PR #${pullRequest.number} ${pullRequest.title}`);

  const { head } = pullRequest;

  const {
    token,
    octokit,
    config: { updateMethod, updateRetries, updateRetrySleep },
  } = context;

  let newSha: string | null;

  if (updateMethod === 'merge') {
    newSha = await mergePullRequest(octokit, updateRetries, updateRetrySleep, pullRequest);
  } else if (updateMethod === 'rebase') {
    const { full_name } = head.repo;
    const url = `https://x-access-token:${token}@github.com/${full_name}.git`;
    newSha = await tmpdir((path) => rebase(path, url, pullRequest));
  } else {
    throw new Error(`invalid update method: ${updateMethod}`);
  }

  if (newSha != null && newSha != head.sha) {
    head.sha = newSha;
    return true;
  } else {
    return false;
  }
}

function skipPullRequest(context: Context, pullRequest: PullRequest): boolean {
  const {
    config: { updateLabels },
  } = context;

  let skip = false;

  if (pullRequest.state !== 'open') {
    logger.info('Skipping PR update, state is not open:', pullRequest.state);
    skip = true;
  }

  if (pullRequest.merged === true) {
    logger.info('Skipping PR update, already merged!');
    skip = true;
  }

  const labels = pullRequest.labels.map((label) => label.name);

  for (const label of labels) {
    if (updateLabels.blocking.includes(label)) {
      logger.info('Skipping PR update, blocking label present:', label);
      skip = true;
    }
  }

  for (const required of updateLabels.required) {
    if (!labels.includes(required)) {
      logger.info('Skipping PR update, required label missing:', required);
      skip = true;
    }
  }

  return skip;
}

async function mergePullRequest(
  octokit: Octokit,
  updateRetries: number,
  updateRetrySleep: number,
  pullRequest: PullRequest,
): Promise<string | null> {
  const mergeableState = await pullRequestState(
    octokit,
    updateRetries,
    updateRetrySleep,
    pullRequest,
  );
  if (mergeableState === 'behind') {
    const headRef = pullRequest.head.ref;
    const baseRef = pullRequest.base.ref;

    logger.debug('Merging latest changes from', baseRef, 'into', headRef);
    const { status: mergeStatus, data } = await octokit.repos.merge({
      owner: pullRequest.base.repo.owner.login,
      repo: pullRequest.base.repo.name,
      base: headRef,
      head: baseRef,
    });
    // the API returns 204 when the branches are already up to date, which the
    // octokit response types do not model
    const status: number = mergeStatus;

    logger.trace('Merge result:', status, data);

    if (status === 204) {
      logger.info('No merge performed, branch is up to date!');
      return pullRequest.head.sha;
    } else {
      logger.info('Merge succeeded, new HEAD:', headRef, data.sha);
      return data.sha;
    }
  } else if (mergeableState === 'clean' || mergeableState === 'has_hooks') {
    logger.info('No update necessary, mergeable_state:', mergeableState);
    return pullRequest.head.sha;
  } else {
    logger.info('No update done due to PR mergeable_state', mergeableState);
    return null;
  }
}

async function pullRequestState(
  octokit: Octokit,
  updateRetries: number,
  updateRetrySleep: number,
  pullRequest: PullRequest,
): Promise<string | null> {
  if (pullRequest.mergeable_state != null) {
    return pullRequest.mergeable_state;
  } else {
    logger.debug('Getting pull request info for', pullRequest.number, '...');
    let fullPullRequest: PullRequest = (
      await octokit.pulls.get({
        owner: pullRequest.base.repo.owner.login,
        repo: pullRequest.base.repo.name,
        pull_number: pullRequest.number,
      })
    ).data as unknown as PullRequest;

    logger.trace('Full PR:', fullPullRequest);

    for (let run = 1; run <= updateRetries; run++) {
      if (fullPullRequest.mergeable_state != null) {
        break;
      } else {
        logger.info('Unknown PR state, mergeable_state: null');
        logger.info(`Retrying after ${updateRetrySleep} ms ... (${run}/${updateRetries})`);

        await sleep(updateRetrySleep);

        const { data } = await octokit.pulls.get({
          owner: pullRequest.base.repo.owner.login,
          repo: pullRequest.base.repo.name,
          pull_number: pullRequest.number,
          headers: { 'If-None-Match': '' },
        });
        fullPullRequest = data as unknown as PullRequest;
      }
    }

    return fullPullRequest.mergeable_state ?? null;
  }
}

async function rebase(dir: string, url: string, pullRequest: PullRequest): Promise<string | null> {
  const headRef = pullRequest.head.ref;
  const baseRef = pullRequest.base.ref;

  logger.debug('Cloning into', dir, `(${headRef})`);
  await git.clone(url, dir, headRef);

  logger.debug('Fetching', baseRef, '...');
  await git.fetch(dir, baseRef);
  await git.fetchUntilMergeBase(dir, baseRef, FETCH_TIMEOUT);

  const head = await git.head(dir);
  if (head !== pullRequest.head.sha) {
    logger.info(`HEAD changed to ${head}, skipping`);
    return null;
  }

  logger.info(headRef, 'HEAD:', head);

  const onto = await git.sha(dir, baseRef);

  logger.info('Rebasing onto', baseRef, onto);
  await git.rebase(dir, onto);

  const newHead = await git.head(dir);
  if (newHead === head) {
    logger.info('Already up to date:', headRef, '->', baseRef, onto);
  } else {
    logger.debug('Pushing changes...');
    await git.push(dir, true, headRef);

    logger.info('Updated:', headRef, head, '->', newHead);
  }

  return newHead;
}

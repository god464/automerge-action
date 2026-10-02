import process from 'node:process';

import { ClientError, logger, RESULT_NOT_READY, RESULT_SKIPPED } from './common.js';
import { update } from './update.js';
import { merge } from './merge.js';
import { branchName } from './util.js';
import type {
  ActionOutputs,
  ActionResult,
  ActionResultLike,
  CheckPayload,
  Context,
  EventData,
  PullRequest,
  Repository,
} from './types.js';

const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';

const URL_REGEXP = new RegExp(`^${GITHUB_SERVER_URL}/([^/]+)/([^/]+)/(pull|tree)/([^ ]+)$`);

const RELEVANT_ACTIONS = [
  'labeled',
  'unlabeled',
  'synchronize',
  'opened',
  'edited',
  'ready_for_review',
  'reopened',
  'unlocked',
];

// we'll only update a few PRs at once:
const MAX_PR_COUNT: number = Number(process.env.MAX_PR_COUNT || 10);

export async function executeLocally(
  context: Context,
  url: string,
  outputs: ActionOutputs,
): Promise<void> {
  const { octokit } = context;

  const m = url.match(URL_REGEXP);
  if (m && m[3] === 'pull') {
    logger.debug('Getting PR data...');
    const { data: pull_request } = await octokit.pulls.get({
      owner: m[1],
      repo: m[2],
      pull_number: Number(m[4]),
      headers: { 'If-None-Match': '' },
    });

    const event: EventData = {
      action: 'opened',
      pull_request: pull_request as unknown as PullRequest,
    };

    return executeGitHubAction(context, 'pull_request', event, outputs);
  } else if (m && m[3] === 'tree') {
    const event: EventData = {
      ref: `refs/heads/${m[4]}`,
      // NOTE: the original payload set `owner.name` (not `owner.login`), which
      // the push handler below reads; kept verbatim during the TS conversion.
      repository: { name: m[2], owner: { name: m[1] } } as unknown as Repository,
    };

    return executeGitHubAction(context, 'push', event, outputs);
  } else {
    throw new ClientError(`invalid URL: ${url}`);
  }
}

export async function executeGitHubAction(
  context: Context,
  eventName: string,
  eventData: EventData,
  outputs: ActionOutputs,
): Promise<void> {
  const result = await executeGitHubActionImpl(context, eventName, eventData);
  logger.info('Action result:', result);

  let singleResult: ActionResult | undefined;
  if (Array.isArray(result)) {
    logger.info('More than one result, using  first result for action output');
    singleResult = result[0];
  } else if (result != null) {
    singleResult = result;
  } else {
    throw new Error('invalid result!');
  }

  const { mergeResult, pullRequestNumber } = singleResult || {};
  outputs.setOutput('mergeResult', mergeResult || RESULT_SKIPPED);
  outputs.setOutput('pullRequestNumber', pullRequestNumber || 0);
}

async function executeGitHubActionImpl(
  context: Context,
  eventName: string,
  eventData: EventData,
): Promise<ActionResultLike> {
  logger.info('Event name:', eventName);
  logger.trace('Event data:', eventData);

  if (context.config.pullRequest != null) {
    return await handleArbitraryPullRequestUpdate(context, eventData);
  } else if (['push'].includes(eventName)) {
    await handleBaseBranchUpdate(context, eventName, eventData);
  } else if (['status'].includes(eventName)) {
    return await handleStatusUpdate(context, eventName, eventData);
  } else if (['pull_request', 'pull_request_target'].includes(eventName)) {
    return await handlePullRequestUpdate(context, eventName, eventData);
  } else if (['check_suite', 'check_run', 'workflow_run'].includes(eventName)) {
    return await handleCheckOrWorkflowUpdate(context, eventName, eventData);
  } else if (['pull_request_review'].includes(eventName)) {
    return await handlePullRequestReviewUpdate(context, eventName, eventData);
  } else if (['schedule', 'repository_dispatch'].includes(eventName)) {
    return await handleScheduleTriggerOrRepositoryDispatch(context);
  } else if (['issue_comment'].includes(eventName)) {
    return await handleIssueComment(context, eventName, eventData);
  } else if (['workflow_dispatch'].includes(eventName)) {
    return await handleWorkflowDispatch(context, eventName, eventData);
  } else {
    throw new ClientError(`invalid event type: ${eventName}`);
  }
}

async function handlePullRequestUpdate(
  context: Context,
  eventName: string,
  event: EventData,
): Promise<ActionResult> {
  const { action } = event;
  if (!RELEVANT_ACTIONS.includes(action ?? '')) {
    logger.info('Action ignored:', eventName, action);
    return { mergeResult: RESULT_SKIPPED };
  }

  const pullRequest = await fetchPullRequest(
    context,
    event.pull_request!.base.repo,
    event.pull_request!,
  );

  return updateAndMerge(context, pullRequest);
}

async function handleArbitraryPullRequestUpdate(
  context: Context,
  eventData: EventData,
): Promise<ActionResult> {
  const { config, octokit } = context;

  const repoOwner = config.pullRequest!.repoOwner || eventData.repository!.owner.login;
  const repoName = config.pullRequest!.repoName || eventData.repository!.name;
  const { pullRequestNumber } = config.pullRequest!;

  logger.info(`Looking for pull request #${pullRequestNumber}...`);

  try {
    const { data: pullRequest } = await octokit.pulls.get({
      owner: repoOwner,
      repo: repoName,
      pull_number: pullRequestNumber,
      headers: { 'If-None-Match': '' },
    });
    logger.trace('Full PR:', pullRequest);

    return updateAndMerge(context, pullRequest as unknown as PullRequest);
  } catch (e) {
    logger.error(`Error fetching pull request: ${repoOwner}/${repoName}/${pullRequestNumber}`);
    throw e;
  }
}

async function handleCheckOrWorkflowUpdate(
  context: Context,
  eventName: string,
  event: EventData,
): Promise<ActionResult | ActionResult[]> {
  const { action } = event;
  const eventType = eventName === 'workflow_run' ? 'workflow' : 'status check';
  if (action !== 'completed') {
    logger.info(`A ${eventType} is not yet complete:`, eventName);
    return { mergeResult: RESULT_NOT_READY };
  }

  const payload = event[eventName] as CheckPayload | undefined;
  if (!payload) {
    throw new Error(`failed to find payload for event type: ${eventName}`);
  }
  if (payload.conclusion !== 'success') {
    logger.info(`A ${eventType} completed unsuccessfully:`, eventName);
    return { mergeResult: RESULT_NOT_READY };
  }

  logger.info(`${eventType} completed successfully`);

  const eventPullRequest = payload.pull_requests![0];
  if (eventPullRequest != null) {
    const { octokit } = context;
    const { data: pullRequest } = await octokit.request(eventPullRequest.url);
    logger.trace('PR:', pullRequest);

    return updateAndMerge(context, pullRequest as unknown as PullRequest);
  } else {
    const branchName = payload.head_branch;
    if (branchName != null) {
      return await checkPullRequestsForBranches(context, event, branchName);
    } else {
      return await checkPullRequestsForHeadSha(context, event.repository!, payload.head_sha!);
    }
  }
}

async function handlePullRequestReviewUpdate(
  context: Context,
  eventName: string,
  event: EventData,
): Promise<ActionResult> {
  const { action, review } = event;
  if (action === 'submitted') {
    if (review!.state === 'approved') {
      const pullRequest = await fetchPullRequest(
        context,
        event.pull_request!.base.repo,
        event.pull_request!,
      );
      return updateAndMerge(context, pullRequest);
    } else {
      logger.info('Review state is not approved:', review!.state);
      logger.info('Action ignored:', eventName, action);
    }
  } else {
    logger.info('Action ignored:', eventName, action);
  }
  return { mergeResult: RESULT_SKIPPED };
}

async function handleStatusUpdate(
  context: Context,
  eventName: string,
  event: EventData,
): Promise<ActionResult[]> {
  const { state, branches } = event;
  if (state !== 'success') {
    logger.info('Event state ignored:', eventName, state);
    return [];
  }

  if (!branches || branches.length === 0) {
    logger.info('No branches have been referenced:', eventName);
    return [];
  }

  let results: ActionResult[] = [];
  for (const branch of branches) {
    results = results.concat(await checkPullRequestsForBranches(context, event, branch.name));
  }
  return results;
}

async function checkPullRequestsForBranches(
  context: Context,
  event: EventData,
  branchName: string,
): Promise<ActionResult[]> {
  const { octokit } = context;
  logger.debug('Listing pull requests for', branchName, '...');
  const { data: pullRequests } = await octokit.pulls.list({
    owner: event.repository!.owner.login,
    repo: event.repository!.name,
    state: 'open',
    head: `${event.repository!.owner.login}:${branchName}`,
    sort: 'updated',
    direction: 'desc',
    per_page: MAX_PR_COUNT,
  });

  logger.trace('PR list:', pullRequests);

  let updated = 0;
  const results: ActionResult[] = [];
  for (const pullRequest of pullRequests) {
    try {
      const result = await updateAndMerge(context, pullRequest as unknown as PullRequest);
      results.push(result);
      ++updated;
    } catch (e) {
      logger.error(e);
    }
  }

  if (updated === 0) {
    logger.info('No PRs have been updated/merged');
  }
  return results;
}

async function checkPullRequestsForHeadSha(
  context: Context,
  repo: Repository,
  head_sha: string,
): Promise<ActionResult[]> {
  const { octokit } = context;
  logger.debug('Listing pull requests to look for', head_sha, '...');
  const { data: pullRequests } = await octokit.pulls.list({
    owner: repo.owner.login,
    repo: repo.name,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: MAX_PR_COUNT,
  });

  let updated = 0;
  let foundPR = false;
  const results: ActionResult[] = [];
  for (const pullRequest of pullRequests) {
    if (pullRequest.head.sha !== head_sha) {
      continue;
    }
    foundPR = true;
    try {
      const result = await updateAndMerge(context, pullRequest as unknown as PullRequest);
      results.push(result);
      ++updated;
    } catch (e) {
      logger.error(e);
    }
  }

  if (updated === 0) {
    logger.info('No PRs have been updated/merged');
  }
  if (!foundPR) {
    logger.info(
      'Could not find branch name in this status check result' +
        ' or corresponding PR from a forked repository',
    );
  }
  return results;
}

async function handleBaseBranchUpdate(
  context: Context,
  eventName: string,
  event: EventData,
): Promise<void> {
  logger.trace('Event name:', eventName);
  const { ref } = event;
  const branch = branchName(ref!);
  if (!branch) {
    logger.info('Push does not reference a branch:', ref);
    return;
  }

  logger.debug('Updated branch:', branch);

  const { octokit } = context;

  logger.debug('Listing pull requests...');
  const { data: pullRequests } = await octokit.pulls.list({
    owner: event.repository!.owner.login,
    repo: event.repository!.name,
    state: 'open',
    base: branch,
    sort: 'updated',
    direction: 'desc',
    per_page: MAX_PR_COUNT,
  });

  logger.trace('PR list:', pullRequests);

  if (pullRequests.length > 0) {
    logger.info('Open PRs:', pullRequests.length);
  } else {
    logger.info('No open PRs for', branch);
    return;
  }

  let updated = 0;
  for (const pullRequest of pullRequests) {
    try {
      await update(context, pullRequest as unknown as PullRequest);
      updated++;
    } catch (e) {
      logger.error(e);
    }
  }

  if (updated > 0) {
    logger.info(updated, 'PRs based on', branch, 'have been updated');
  } else {
    logger.info('No PRs based on', branch, 'have been updated');
  }
}

async function handleWorkflowDispatch(
  context: Context,
  eventName: string,
  event: EventData,
): Promise<ActionResult[]> {
  logger.trace('Event name:', eventName);
  const { ref } = event;
  const branch = branchName(ref!);
  if (!branch) {
    logger.info('Dispatch does not reference a branch:', ref);
    return [{ mergeResult: RESULT_SKIPPED }];
  }

  return await checkPullRequestsForBranches(context, event, branch);
}

async function handleScheduleTriggerOrRepositoryDispatch(
  context: Context,
): Promise<ActionResult[]> {
  const { octokit } = context;

  const { GITHUB_REPOSITORY } = process.env;
  const [owner, repo] = (GITHUB_REPOSITORY || '').split('/', 2);

  if (!owner || !repo) {
    throw new Error(`invalid GITHUB_REPOSITORY value: ${GITHUB_REPOSITORY}`);
  }

  logger.debug('Listing pull requests ...');
  const { data: pullRequests } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: MAX_PR_COUNT,
  });

  logger.trace('PR list:', pullRequests);

  let updated = 0;
  const results: ActionResult[] = [];
  for (const pullRequest of pullRequests) {
    try {
      const result = await updateAndMerge(context, pullRequest as unknown as PullRequest);
      results.push(result);
      ++updated;
    } catch (e) {
      logger.error(e);
    }
  }

  if (updated === 0) {
    logger.info('No PRs have been updated/merged');
  }
  return results;
}

async function handleIssueComment(
  context: Context,
  eventName: string,
  event: EventData,
): Promise<ActionResult> {
  const { action, issue, repository } = event;
  if (action === 'created') {
    if (issue!.pull_request == null) {
      logger.info('Comment not on a PR, skipping');
    } else {
      const pullRequest = await fetchPullRequest(context, repository!, issue!);
      return updateAndMerge(context, pullRequest);
    }
  } else {
    logger.info('Action ignored:', eventName, action);
  }
  return { mergeResult: RESULT_SKIPPED };
}

async function fetchPullRequest(
  context: Context,
  repository: Repository,
  issue: { number: number },
): Promise<PullRequest> {
  const { octokit } = context;
  const { number } = issue;

  logger.debug('Getting pull request info for', number, '...');
  const { data: pullRequest } = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    headers: { 'If-None-Match': '' },
  });

  logger.trace('Full PR:', pullRequest);
  return pullRequest as unknown as PullRequest;
}

async function updateAndMerge(context: Context, pullRequest: PullRequest): Promise<ActionResult> {
  const approvalCount = await fetchApprovalReviewCount(context, pullRequest);
  await update(context, pullRequest);
  const mergeResult = await merge(context, pullRequest, approvalCount);
  return { mergeResult, pullRequestNumber: pullRequest.number };
}

async function fetchApprovalReviewCount(
  context: Context,
  pullRequest: PullRequest,
): Promise<number> {
  const {
    octokit,
    config: { mergeRequiredApprovals },
  } = context;
  const { number } = pullRequest;

  if (mergeRequiredApprovals === 0) {
    // If we don't care about review approvals, let's short circuit.
    return 0;
  }

  logger.debug('Getting reviews for', number, '...');
  const reviews = (await octokit.paginate(octokit.pulls.listReviews, {
    owner: pullRequest.base.repo.owner.login,
    repo: pullRequest.base.repo.name,
    pull_number: number,
  })) as unknown as Array<{ state: string; user: { login: string } }>;

  const approvingReviewers = reviews
    .filter((review) => review.state === 'APPROVED')
    .map((review) => review.user.login);
  const uniqueApprovingReviewers = approvingReviewers.filter(
    (login, index) => approvingReviewers.indexOf(login) === index,
  );

  logger.trace('Approval reviewers:', uniqueApprovingReviewers);
  return uniqueApprovingReviewers.length;
}

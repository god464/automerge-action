import {describe, expect, it} from 'vitest';
import {parseEvent} from '../src/events/parse';
import {resolveTargets} from '../src/events/targets';
import {expectOk} from './factories';

const repo = { owner: 'owner', repo: 'repo' };
const payloadRepository = { name: 'repo', owner: { login: 'owner' } };

function pullRequestPayload(action = 'labeled'): unknown {
  return { action, repository: payloadRepository, pull_request: { number: 7 } };
}

describe('parseEvent', () => {
  it('parses pull_request events', () => {
    const event = expectOk(parseEvent('pull_request', pullRequestPayload()));

    expect(event).toEqual({ kind: 'pull_request', action: 'labeled', repo, pullRequestNumber: 7 });
  });

  it('parses pull_request_review events', () => {
    const event = expectOk(
      parseEvent('pull_request_review', {
        action: 'submitted',
        repository: payloadRepository,
        review: { state: 'approved' },
        pull_request: { number: 7 },
      }),
    );

    expect(event).toEqual({
      kind: 'pull_request_review',
      action: 'submitted',
      reviewState: 'approved',
      repo,
      pullRequestNumber: 7,
    });
  });

  it('parses workflow_run pull_request events', () => {
    const event = expectOk(
      parseEvent('workflow_run', {
        action: 'completed',
        repository: payloadRepository,
        workflow_run: {
          conclusion: 'success',
          event: 'pull_request',
          head_branch: 'feature',
          head_sha: 'sha',
          pull_requests: [{ number: 8 }],
        },
      }),
    );

    expect(event).toEqual({
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'success',
      triggerEvent: 'pull_request',
      headBranch: 'feature',
      headSha: 'sha',
      repo,
      pullRequests: [{ number: 8 }],
    });
  });

  it('parses check_suite and status events', () => {
    const checkSuite = expectOk(
      parseEvent('check_suite', {
        action: 'completed',
        repository: payloadRepository,
        check_suite: { conclusion: 'success', head_sha: 'sha', pull_requests: [] },
      }),
    );
    const status = expectOk(
      parseEvent('status', { state: 'success', sha: 'sha', repository: payloadRepository }),
    );

    expect(checkSuite.kind).toEqual('check_suite');
    expect(status).toEqual({ kind: 'status', state: 'success', sha: 'sha', repo });
  });

  it('returns unsupported for other event names', () => {
    expect(expectOk(parseEvent('push', {}))).toEqual({ kind: 'unsupported', eventName: 'push' });
  });

  it('rejects malformed payloads', () => {
    expect(parseEvent('pull_request', { action: 'labeled' })).toMatchObject({
      ok: false,
      error: { kind: 'malformed' },
    });
  });
});

describe('resolveTargets', () => {
  const pullRequestTarget = { kind: 'pull_request', repo, number: 7, mode: 'update_and_merge' };

  it('resolves relevant pull_request actions and ignores the rest', () => {
    expect(resolveTargets(expectOk(parseEvent('pull_request', pullRequestPayload())))).toEqual(
      pullRequestTarget,
    );
    expect(
      resolveTargets(expectOk(parseEvent('pull_request', pullRequestPayload('closed')))),
    ).toEqual({ kind: 'ignored', reason: 'pull_request action ignored: closed' });
  });

  it('resolves approved reviews and ignores other reviews', () => {
    const approved = expectOk(
      parseEvent('pull_request_review', {
        action: 'submitted',
        repository: payloadRepository,
        review: { state: 'approved' },
        pull_request: { number: 7 },
      }),
    );
    const commented = expectOk(
      parseEvent('pull_request_review', {
        action: 'submitted',
        repository: payloadRepository,
        review: { state: 'commented' },
        pull_request: { number: 7 },
      }),
    );

    expect(resolveTargets(approved)).toEqual(pullRequestTarget);
    expect(resolveTargets(commented).kind).toEqual('ignored');
  });

  it('resolves workflow_run pull_request and push sources separately', () => {
    const pullRequestRun = expectOk(
      parseEvent('workflow_run', {
        action: 'completed',
        repository: payloadRepository,
        workflow_run: {
          conclusion: 'success',
          event: 'pull_request',
          head_branch: 'feature',
          head_sha: 'sha',
          pull_requests: [{ number: 8 }],
        },
      }),
    );
    const pushRun = expectOk(
      parseEvent('workflow_run', {
        action: 'completed',
        repository: payloadRepository,
        workflow_run: {
          conclusion: 'success',
          event: 'push',
          head_branch: 'main',
          head_sha: 'sha',
          pull_requests: [],
        },
      }),
    );

    expect(resolveTargets(pullRequestRun)).toEqual({
      kind: 'pull_requests',
      repo,
      numbers: [8],
      mode: 'update_and_merge',
    });
    expect(resolveTargets(pushRun)).toEqual({
      kind: 'pull_requests_by_base',
      repo,
      base: 'main',
      mode: 'update_only',
    });
  });

  it('falls back to commit SHA for fork pull requests', () => {
    const event = expectOk(
      parseEvent('workflow_run', {
        action: 'completed',
        repository: payloadRepository,
        workflow_run: {
          conclusion: 'success',
          event: 'pull_request',
          head_branch: 'fork-branch',
          head_sha: 'sha',
          pull_requests: [],
        },
      }),
    );

    expect(resolveTargets(event)).toEqual({
      kind: 'pull_requests_by_commit',
      repo,
      sha: 'sha',
      mode: 'update_and_merge',
    });
  });

  it('maps incomplete and failed checks to not_ready', () => {
    const incomplete = expectOk(
      parseEvent('workflow_run', {
        action: 'requested',
        repository: payloadRepository,
        workflow_run: {
          conclusion: null,
          event: 'pull_request',
          head_branch: 'feature',
          head_sha: 'sha',
          pull_requests: [],
        },
      }),
    );
    const failed = expectOk(
      parseEvent('check_suite', {
        action: 'completed',
        repository: payloadRepository,
        check_suite: { conclusion: 'failure', head_sha: 'sha', pull_requests: [] },
      }),
    );

    expect(resolveTargets(incomplete)).toEqual({ kind: 'not_ready', reason: 'check_incomplete' });
    expect(resolveTargets(failed)).toEqual({ kind: 'not_ready', reason: 'check_failed' });
  });

  it('resolves check suites and statuses by SHA', () => {
    const checkSuite = expectOk(
      parseEvent('check_suite', {
        action: 'completed',
        repository: payloadRepository,
        check_suite: { conclusion: 'success', head_sha: 'sha', pull_requests: [] },
      }),
    );
    const status = expectOk(
      parseEvent('status', { state: 'success', sha: 'sha', repository: payloadRepository }),
    );
    const failedStatus = expectOk(
      parseEvent('status', { state: 'failure', sha: 'sha', repository: payloadRepository }),
    );

    expect(resolveTargets(checkSuite)).toEqual({
      kind: 'pull_requests_by_commit',
      repo,
      sha: 'sha',
      mode: 'update_and_merge',
    });
    expect(resolveTargets(status)).toEqual({
      kind: 'pull_requests_by_commit',
      repo,
      sha: 'sha',
      mode: 'update_and_merge',
    });
    expect(resolveTargets(failedStatus).kind).toEqual('ignored');
  });

  it('returns unsupported for removed events', () => {
    expect(resolveTargets(expectOk(parseEvent('push', {})))).toEqual({
      kind: 'unsupported',
      eventName: 'push',
    });
  });
});

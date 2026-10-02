import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { preserveFocusForBuildTrigger } from '../build/buildTrigger';

/**
 * Pure coalesce rules mirrored by BuildController:
 * - command while busy → reject (caller shows "already running")
 * - save while busy → queue one follow-up
 * - multiple saves while busy → still one follow-up
 * - cancel while busy → clear follow-up; finish idle (no queued start)
 */

type Trigger = 'command' | 'onSave';

interface QueueState {
  building: boolean;
  followUp: boolean;
  cancelRequested: boolean;
}

function request(state: QueueState, trigger: Trigger): 'start' | 'reject' | 'queued' {
  if (!state.building) {
    state.building = true;
    state.followUp = false;
    state.cancelRequested = false;
    return 'start';
  }
  if (trigger === 'command') {
    return 'reject';
  }
  state.followUp = true;
  return 'queued';
}

function cancel(state: QueueState): 'cancelling' | 'idle' {
  if (!state.building) {
    return 'idle';
  }
  state.cancelRequested = true;
  state.followUp = false;
  return 'cancelling';
}

function finish(state: QueueState): 'idle' | 'start-followup' {
  const wasCancelled = state.cancelRequested;
  state.building = false;
  state.cancelRequested = false;
  if (wasCancelled) {
    state.followUp = false;
    return 'idle';
  }
  if (state.followUp) {
    state.followUp = false;
    state.building = true;
    return 'start-followup';
  }
  return 'idle';
}

describe('build on-save coalesce', () => {
  it('rejects second command while building', () => {
    const s: QueueState = { building: false, followUp: false, cancelRequested: false };
    assert.equal(request(s, 'command'), 'start');
    assert.equal(request(s, 'command'), 'reject');
  });

  it('queues one follow-up for saves during a build', () => {
    const s: QueueState = { building: false, followUp: false, cancelRequested: false };
    assert.equal(request(s, 'onSave'), 'start');
    assert.equal(request(s, 'onSave'), 'queued');
    assert.equal(request(s, 'onSave'), 'queued');
    assert.equal(s.followUp, true);
    assert.equal(finish(s), 'start-followup');
    assert.equal(s.followUp, false);
    assert.equal(finish(s), 'idle');
  });

  it('cancel clears queued follow-up and finishes idle', () => {
    const s: QueueState = { building: false, followUp: false, cancelRequested: false };
    assert.equal(request(s, 'onSave'), 'start');
    assert.equal(request(s, 'onSave'), 'queued');
    assert.equal(cancel(s), 'cancelling');
    assert.equal(s.followUp, false);
    assert.equal(finish(s), 'idle');
    assert.equal(s.building, false);
  });
});

describe('preserveFocusForBuildTrigger', () => {
  it('preserves focus for onSave and queued follow-ups', () => {
    assert.equal(preserveFocusForBuildTrigger('onSave'), true);
    assert.equal(preserveFocusForBuildTrigger('queued'), true);
  });

  it('does not force preserveFocus for manual command builds', () => {
    assert.equal(preserveFocusForBuildTrigger('command'), false);
  });
});

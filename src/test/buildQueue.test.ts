import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { preserveFocusForBuildTrigger } from '../build/buildTrigger';

/**
 * Pure coalesce rules mirrored by BuildController:
 * - command while busy → reject (caller shows "already running")
 * - save while busy → queue one follow-up
 * - multiple saves while busy → still one follow-up
 */

type Trigger = 'command' | 'onSave';

interface QueueState {
  building: boolean;
  followUp: boolean;
}

function request(state: QueueState, trigger: Trigger): 'start' | 'reject' | 'queued' {
  if (!state.building) {
    state.building = true;
    state.followUp = false;
    return 'start';
  }
  if (trigger === 'command') {
    return 'reject';
  }
  state.followUp = true;
  return 'queued';
}

function finish(state: QueueState): 'idle' | 'start-followup' {
  state.building = false;
  if (state.followUp) {
    state.followUp = false;
    state.building = true;
    return 'start-followup';
  }
  return 'idle';
}

describe('build on-save coalesce', () => {
  it('rejects second command while building', () => {
    const s: QueueState = { building: false, followUp: false };
    assert.equal(request(s, 'command'), 'start');
    assert.equal(request(s, 'command'), 'reject');
  });

  it('queues one follow-up for saves during a build', () => {
    const s: QueueState = { building: false, followUp: false };
    assert.equal(request(s, 'onSave'), 'start');
    assert.equal(request(s, 'onSave'), 'queued');
    assert.equal(request(s, 'onSave'), 'queued');
    assert.equal(s.followUp, true);
    assert.equal(finish(s), 'start-followup');
    assert.equal(s.followUp, false);
    assert.equal(finish(s), 'idle');
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

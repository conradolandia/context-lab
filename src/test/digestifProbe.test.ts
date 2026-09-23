import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { preferDigestifError, withTimeout } from '../lsp/digestifProcess';

describe('withTimeout', () => {
  it('resolves when the promise finishes in time', async () => {
    const value = await withTimeout(Promise.resolve(42), 1000, 'timed out');
    assert.equal(value, 42);
  });

  it('rejects with the timeout message when slow', async () => {
    await assert.rejects(
      () =>
        withTimeout(
          new Promise((resolve) => {
            setTimeout(resolve, 200);
          }),
          20,
          'DigestiF LSP initialize timed out after 20ms',
        ),
      /timed out after 20ms/,
    );
  });
});

describe('preferDigestifError', () => {
  it('prefers DigestiF stderr over stream-destroyed', () => {
    const msg = preferDigestifError(new Error('Cannot call write after a stream was destroyed'), {
      stdout: '',
      stderr: 'Error: could not find data files\n',
    });
    assert.match(msg, /data files/);
  });

  it('annotates stream-destroyed when stderr empty', () => {
    const msg = preferDigestifError(new Error('Cannot call write after a stream was destroyed'), {
      stdout: '',
      stderr: '',
    });
    assert.match(msg, /last stderr/);
  });
});

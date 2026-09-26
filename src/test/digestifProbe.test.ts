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
  it('keeps LanguageClient error; stderr is ignored', () => {
    const msg = preferDigestifError(new Error('Cannot call write after a stream was destroyed'), {
      stdout: '',
      stderr: 'Error: could not find data files\n',
    });
    assert.match(msg, /stream was destroyed/);
    assert.doesNotMatch(msg, /data files/);
  });

  it('returns LanguageClient message when stderr empty', () => {
    const msg = preferDigestifError(new Error('could not create connection to server'), {
      stdout: '',
      stderr: '',
    });
    assert.match(msg, /could not create connection/);
  });
});

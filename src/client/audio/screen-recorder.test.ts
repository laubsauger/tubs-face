import { describe, expect, it } from 'vitest';
import { createChunkUploader } from './screen-recorder.js';

const piece = (text: string) => new Blob([text]);

describe('recording uploader', () => {
  // The pieces only make a video in order and each exactly once. A server
  // restart mid-take must cost a pause, not the rest of the recording.
  it('resends a failed piece at the same offset while later pieces wait', async () => {
    const sent: Array<[string, number]> = [];
    let failuresLeft = 2;
    const uploader = createChunkUploader(async (chunk, offset) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('ECONNREFUSED');
      }
      sent.push([await chunk.text(), offset]);
    }, () => { throw new Error('should not give up'); }, { retryMs: 1 });

    uploader.push(piece('aaa'));
    uploader.push(piece('bb'));
    uploader.push(piece('c'));
    await uploader.drain();

    expect(sent).toEqual([['aaa', 0], ['bb', 3], ['c', 5]]);
  });

  // Recording on into a file that is already broken would only hide it.
  it('gives up once, loudly, when the server refuses a piece', async () => {
    const failures: string[] = [];
    let calls = 0;
    const uploader = createChunkUploader(async () => {
      calls += 1;
      throw Object.assign(new Error('409 offset mismatch'), { permanent: true });
    }, (error) => failures.push(error.message), { retryMs: 1 });

    uploader.push(piece('aaa'));
    uploader.push(piece('bb'));
    await uploader.drain();
    uploader.push(piece('c'));
    await uploader.drain();

    expect(failures).toEqual(['409 offset mismatch']);
    expect(calls).toBe(1);
  });

  it('gives up when the server stays away too long', async () => {
    const failures: string[] = [];
    const uploader = createChunkUploader(async () => {
      throw new Error('ECONNREFUSED');
    }, (error) => failures.push(error.message), { retryMs: 1, giveUpMs: 20 });

    uploader.push(piece('aaa'));
    await uploader.drain();

    expect(failures).toEqual(['ECONNREFUSED']);
  });
});

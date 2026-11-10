import { afterEach, describe, expect, it } from 'vitest';
import { lastLlmCall, resetLlmCall, trackLlmCall } from './last-call.js';

// GET /studio shows whether the brain works from how its last call went. A
// turn cut off by a visitor is not a failure; an error is, with its reason.

afterEach(() => resetLlmCall());

describe('trackLlmCall', () => {
  it('keeps the outcome, the time and the model, and passes the result or the error through', async () => {
    let t = 1000;
    const now = () => t;
    const result = await trackLlmCall(async () => {
      t += 620;
      return { text: 'Hi', model: 'gemini-3-flash' };
    }, now);
    expect(result.text).toBe('Hi');
    expect(lastLlmCall()).toEqual({ ok: true, ms: 620, model: 'gemini-3-flash', at: 1620 });

    await expect(trackLlmCall(async () => {
      throw new Error('Gemini answered 503');
    }, now)).rejects.toThrow('503');
    expect(lastLlmCall()).toMatchObject({ ok: false, error: 'Gemini answered 503' });
  });

  it('says nothing about a call that was cut off', async () => {
    await trackLlmCall(async () => ({ model: 'm' }));
    await trackLlmCall(async () => ({ model: 'm', aborted: true }));
    expect(lastLlmCall()?.ok).toBe(true);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(trackLlmCall(async () => {
      throw abort;
    })).rejects.toBe(abort);
    expect(lastLlmCall()?.ok).toBe(true);
  });
});

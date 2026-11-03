import { describe, expect, it } from 'vitest';
import { isWsClientMessage } from './index.js';

// The server acts on client messages directly; a bad payload must be dropped
// at the door instead of reaching a turn, a broadcast or the TTS stream.
describe('isWsClientMessage', () => {
  it('accepts the messages the clients actually send', () => {
    expect(isWsClientMessage({ type: 'incoming', text: 'hey tubs' })).toBe(true);
    expect(isWsClientMessage({ type: 'face_motion', actor: 'main', x: 0.2, y: -0.1, ts: 1 })).toBe(true);
    expect(isWsClientMessage({ type: 'head_speech_state', actor: 'small', state: 'end', turnId: null })).toBe(true);
    expect(isWsClientMessage({ type: 'appearance_frame', frame: 'data:image/jpeg;base64,AAAA', faces: ['Flo'] })).toBe(true);
    expect(isWsClientMessage({ type: 'proactive', context: 'Greet Flo.', faces: ['Flo'] })).toBe(true);
    expect(isWsClientMessage({ type: 'tts_request', text: 'Hi.', turnId: 'abc' })).toBe(true);
  });

  it('rejects payloads that would break a handler', () => {
    expect(isWsClientMessage({ type: 'incoming' })).toBe(false);
    expect(isWsClientMessage({ type: 'incoming', text: '   ' })).toBe(false);
    expect(isWsClientMessage({ type: 'incoming', text: 'x'.repeat(5000) })).toBe(false);
    expect(isWsClientMessage({ type: 'face_motion', actor: 'main', x: Number.NaN, y: 0 })).toBe(false);
    expect(isWsClientMessage({ type: 'face_motion', actor: 'third', x: 0, y: 0 })).toBe(false);
    expect(isWsClientMessage({ type: 'camera_frame', frame: 'https://example.com/x.jpg' })).toBe(false);
    expect(isWsClientMessage({ type: 'tts_request', text: 42 })).toBe(false);
    expect(isWsClientMessage({ type: 'nope' })).toBe(false);
    expect(isWsClientMessage('incoming')).toBe(false);
  });
});

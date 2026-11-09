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
    expect(isWsClientMessage({ type: 'presence', present: true, newVisitor: true, faces: [], count: 1 })).toBe(true);
    expect(isWsClientMessage({ type: 'appearance_frame', frame: 'data:image/jpeg;base64,AAAA', returning: true, awayMs: 45000 })).toBe(true);
  });

  // A window lights text[0..spoken]: a count past the text would light nothing sensible.
  it('takes a studio caption only with a spoken count inside its text', () => {
    const caption = { type: 'studio_caption', actor: 'small', turnId: '', text: 'Four.', spoken: 5, done: true, ts: 1 };
    expect(isWsClientMessage(caption)).toBe(true);
    expect(isWsClientMessage({ ...caption, spoken: 6 })).toBe(false);
    expect(isWsClientMessage({ ...caption, spoken: 1.5 })).toBe(false);
    expect(isWsClientMessage({ ...caption, spoken: -1 })).toBe(false);
    expect(isWsClientMessage({ ...caption, done: 'yes' })).toBe(false);
  });

  // GET /studio/sources lists these as local:<label>, so each must be a label local:<label> takes.
  it('takes the listener page\'s devices only as short lists of labels', () => {
    const status = (devices: unknown) => ({ type: 'studio_status', actor: 'main', publishing: true, devices });
    expect(isWsClientMessage(status({ audio: ['MacBook Pro Microphone'], video: [] }))).toBe(true);
    expect(isWsClientMessage({ type: 'studio_status', actor: 'main', publishing: true })).toBe(true);
    expect(isWsClientMessage(status({ audio: ['MacBook Pro Microphone'] }))).toBe(false);
    expect(isWsClientMessage(status({ audio: [''], video: [] }))).toBe(false);
    expect(isWsClientMessage(status({ audio: ['x'.repeat(201)], video: [] }))).toBe(false);
    expect(isWsClientMessage(status({ audio: Array.from({ length: 33 }, (_, i) => `mic ${i}`), video: [] }))).toBe(false);
  });

  // The memory view shows it as an <img>: only a small JPEG data URL, nothing else.
  it('takes a visitor snapshot in the people report only as a small JPEG', () => {
    const people = (thumbnail: unknown) => ({ type: 'people', people: [{ id: 'v1', names: [], position: 'center', snapshots: 1, thumbnail }] });
    expect(isWsClientMessage(people('data:image/jpeg;base64,AAAA'))).toBe(true);
    expect(isWsClientMessage(people('https://example.com/face.jpg'))).toBe(false);
    expect(isWsClientMessage(people(`data:image/jpeg;base64,${'A'.repeat(70_000)}`))).toBe(false);
  });

  it('rejects payloads that would break a handler', () => {
    expect(isWsClientMessage({ type: 'incoming' })).toBe(false);
    expect(isWsClientMessage({ type: 'incoming', text: '   ' })).toBe(false);
    expect(isWsClientMessage({ type: 'incoming', text: 'x'.repeat(5000) })).toBe(false);
    expect(isWsClientMessage({ type: 'face_motion', actor: 'main', x: Number.NaN, y: 0 })).toBe(false);
    expect(isWsClientMessage({ type: 'face_motion', actor: 'third', x: 0, y: 0 })).toBe(false);
    expect(isWsClientMessage({ type: 'camera_frame', frame: 'https://example.com/x.jpg' })).toBe(false);
    expect(isWsClientMessage({ type: 'tts_request', text: 42 })).toBe(false);
    expect(isWsClientMessage({ type: 'presence', present: true, newVisitor: 'yes' })).toBe(false);
    expect(isWsClientMessage({ type: 'nope' })).toBe(false);
    expect(isWsClientMessage('incoming')).toBe(false);
  });
});

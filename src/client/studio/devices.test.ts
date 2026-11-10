import { describe, expect, it, vi } from 'vitest';
import { readInputDevices } from './devices.js';

// The Studio tab offers this Mac's devices by the label local:<label> takes.
// Chrome hides labels until the page may use a device: one short open unlocks
// them, and it must be closed again at once (a camera left on is a lit LED and
// a busy device), never repeated, and never for a kind that already has names.

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: '', toJSON: () => ({}) }) as MediaDeviceInfo;

function fakeMedia(locked: boolean) {
  let unlocked = !locked;
  const stopped: string[] = [];
  const all = [
    device('audioinput', 'default', 'Default - MacBook Pro Microphone (Built-in)'),
    device('audioinput', 'communications', 'Communications - MacBook Pro Microphone (Built-in)'),
    device('audioinput', 'a1', 'MacBook Pro Microphone (Built-in)'),
    device('audioinput', 'a2', 'Scarlett 2i2 USB'),
    device('videoinput', 'v1', 'FaceTime HD Camera'),
    device('audiooutput', 'o1', 'MacBook Pro Speakers (Built-in)'),
  ];
  const media = {
    enumerateDevices: vi.fn(async () => all.map((entry) => (unlocked ? entry : device(entry.kind, '', '')))),
    getUserMedia: vi.fn(async (constraints?: MediaStreamConstraints) => {
      unlocked = true;
      const kind = constraints?.audio ? 'audio' : 'video';
      return { getTracks: () => [{ stop: () => stopped.push(kind) }] } as unknown as MediaStream;
    }),
  };
  return { media, stopped };
}

describe('readInputDevices', () => {
  it('opens each kind without names once, closes it at once, and lists the real devices', async () => {
    const { media, stopped } = fakeMedia(true);
    const devices = await readInputDevices(media, true);
    expect(devices).toEqual({ audio: ['MacBook Pro Microphone (Built-in)', 'Scarlett 2i2 USB'], video: ['FaceTime HD Camera'] });
    expect(media.getUserMedia.mock.calls.map(([constraints]) => constraints)).toEqual([{ audio: true }, { video: true }]);
    expect(stopped).toEqual(['audio', 'video']);
  });

  it('opens nothing when the names are there or a probe was done already', async () => {
    const unlocked = fakeMedia(false);
    expect((await readInputDevices(unlocked.media, true)).audio).toHaveLength(2);
    const locked = fakeMedia(true);
    expect(await readInputDevices(locked.media, false)).toEqual({ audio: [], video: [] });
    expect(unlocked.media.getUserMedia).not.toHaveBeenCalled();
    expect(locked.media.getUserMedia).not.toHaveBeenCalled();
  });
});

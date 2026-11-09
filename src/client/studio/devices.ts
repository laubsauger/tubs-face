// The listener page's input devices, by label, for GET /studio/sources: the
// names local:<label> takes. Chrome shows labels only once the page may use
// that kind of device, so a kind with none is opened once for a moment
// (as findInputDevice and cameraByLabel do) and closed again.

import type { StudioDevices } from '../../shared/contracts/studio.js';

const MAX_DEVICES = 32;
const MAX_LABEL_CHARS = 200;

type Media = Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'>;

export async function readInputDevices(media: Media, probe: boolean): Promise<StudioDevices> {
  let list = await media.enumerateDevices();
  if (probe) {
    let opened = false;
    for (const [kind, constraints] of [['audioinput', { audio: true }], ['videoinput', { video: true }]] as const) {
      const ofKind = list.filter((device) => device.kind === kind);
      if (ofKind.length === 0 || ofKind.some((device) => device.label)) continue;
      try {
        const stream = await media.getUserMedia(constraints);
        for (const track of stream.getTracks()) track.stop();
        opened = true;
      } catch {
        // Not allowed or busy: that kind stays without names.
      }
    }
    if (opened) list = await media.enumerateDevices();
  }
  // "default" and "communications" are Chrome's aliases of a real device ("local" is the default);
  // a label longer than local:<label> takes could not be chosen anyway.
  const labels = (kind: MediaDeviceKind) => [...new Set(list
    .filter((device) => device.kind === kind && device.deviceId !== 'default' && device.deviceId !== 'communications')
    .map((device) => device.label)
    .filter((label) => label && label.length <= MAX_LABEL_CHARS))].slice(0, MAX_DEVICES);
  return { audio: labels('audioinput'), video: labels('videoinput') };
}

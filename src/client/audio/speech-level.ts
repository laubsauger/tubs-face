/**
 * How loud Tubs's voice is right now, for lip sync. Streamed speech plays
 * through one analyser per AudioContext and the face reads the level every
 * frame, so the mouth closes in pauses and opens on loud syllables instead of
 * flapping at a fixed rate.
 */

// Voices differ in loudness (Ming speaks about a third quieter than Kokoro),
// so the level is measured against the loudest recent syllable: any voice
// uses the mouth's full range. Below the gate it is a pause.
const PEAK_FLOOR = 0.05;
const PEAK_DECAY_MS = 1500;
const GATE = 0.025;
// A jaw opens fast and closes a little slower.
const ATTACK_MS = 30;
const RELEASE_MS = 90;

interface Meter {
  input: GainNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
}

const meters = new WeakMap<AudioContext, Meter>();
let active: Meter | null = null;
let envelope = 0;
let peak = PEAK_FLOOR;
let lastReadAt = 0;

/** Where speech sources connect instead of the destination. */
export function speechOutput(context: AudioContext): AudioNode {
  let meter = meters.get(context);
  if (!meter) {
    const input = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    input.connect(analyser);
    input.connect(context.destination);
    meter = { input, analyser, samples: new Float32Array(analyser.fftSize) };
    meters.set(context, meter);
  }
  active = meter;
  return meter.input;
}

/** Smoothed level 0..1, or null before any speech was played. */
export function readSpeechLevel(now: number): number | null {
  if (!active) return null;
  active.analyser.getFloatTimeDomainData(active.samples);
  let sum = 0;
  for (const sample of active.samples) sum += sample * sample;
  const rms = Math.sqrt(sum / active.samples.length);
  const dt = lastReadAt ? Math.min(100, Math.max(0, now - lastReadAt)) : 16;
  lastReadAt = now;
  peak = Math.max(rms, PEAK_FLOOR + (peak - PEAK_FLOOR) * Math.exp(-dt / PEAK_DECAY_MS));
  const target = rms < GATE ? 0 : Math.min(1, rms / peak);
  const tau = target > envelope ? ATTACK_MS : RELEASE_MS;
  envelope += (target - envelope) * (1 - Math.exp(-dt / tau));
  return envelope;
}

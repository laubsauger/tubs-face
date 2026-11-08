// Barge-in while a head talks, when the mic also hears that head.
//
// The browser's echo cancellation only removes audio its own page plays. A
// studio face page sends the voice to the site node and the room plays it from
// somewhere else, and a site: mic is another box altogether, so Tubs' voice
// comes back into the mic at full strength. Taken as speech, he would cut
// himself off or answer himself. So while a head talks nothing is recognised
// (the voice runtime drops the clip), and only a voice clearly louder than the
// echo, for a while, counts as someone talking over him.

export interface EchoBargeInOptions {
  /** Never fires below this level, however quiet the echo (the normal VAD starts at ~0.02). */
  minRms: number;
  /** A visitor must be this many times louder than the echo (2.5 is about +8 dB). */
  ratio: number;
  /** ...for this long. */
  holdMs: number;
  /** Brief dips between syllables up to this long don't restart the hold. */
  dipMs: number;
  /**
   * The echo level is learnt fast over the first part of a head's line (the
   * stream reaches the room a few hundred ms late), and no barge-in fires then.
   */
  warmupMs: number;
  warmupTauMs: number;
  /** Afterwards it follows slowly, from frames that are not a barge-in. */
  tauMs: number;
}

export const ECHO_BARGE_IN: EchoBargeInOptions = {
  minRms: 0.05,
  ratio: 2.5,
  holdMs: 400,
  dipMs: 120,
  warmupMs: 1000,
  warmupTauMs: 200,
  tauMs: 1500,
};

export interface EchoBargeIn {
  /** One mic frame while a head talks. True once someone is clearly talking over it. */
  feed(rms: number, dtMs: number): boolean;
  /** The heads went quiet: the next line starts learning afresh. */
  reset(): void;
}

export function createEchoBargeIn(options: EchoBargeInOptions = ECHO_BARGE_IN): EchoBargeIn {
  let echo = 0;
  let elapsedMs = 0;
  let loudMs = 0;
  let dipMs = 0;

  return {
    feed(rms, dtMs) {
      const dt = Math.max(0, Math.min(200, dtMs));
      elapsedMs += dt;
      if (elapsedMs <= options.warmupMs) {
        echo += (rms - echo) * (1 - Math.exp(-dt / options.warmupTauMs));
        return false;
      }
      const threshold = Math.max(options.minRms, echo * options.ratio);
      if (rms >= threshold) {
        loudMs += dt;
        dipMs = 0;
      } else {
        echo += (rms - echo) * (1 - Math.exp(-dt / options.tauMs));
        dipMs += dt;
        if (dipMs > options.dipMs) loudMs = 0;
      }
      return loudMs >= options.holdMs;
    },
    reset() {
      echo = 0;
      elapsedMs = 0;
      loudMs = 0;
      dipMs = 0;
    },
  };
}

/** Quiet after a head stops before the mic listens again: room reverb and the stream's delay. */
export const ECHO_TAIL_MS = 1200;

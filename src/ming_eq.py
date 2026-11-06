"""Warmer EQ on the cloned voices' output (voice lab run 16; the user picked "round" for both voices).

Ming's output is brighter and thinner than the recordings it copies: main gets +3.5 dB at 2-4 kHz and
+4 dB above 8 kHz, and Mini's take is thin under 250 Hz with +4 dB of air (run16/eq16.py has the
measurements). Each voice gets a curve of RBJ biquads at 24 kHz with makeup gain, so loudness (BS.1770)
stays where it was. Applied chunk by chunk with the filter state carried over, a streamed reply comes out
the same as the whole reply filtered at once. No mlx here, so the tests can import it.
"""
import numpy as np
from scipy.signal import sosfilt

SR = 24000

# Bands as (kind, Hz, dB, Q); shelves use Q 0.707. Then the makeup gain in dB: the median over 12 lines
# per voice that brings the EQ'd line back to the loudness of the plain one (peaks stay under 0.86).
CURVES = {
    "main": ([("highpass", 45, 0.0, 0.707), ("lowshelf", 130, 5.5, 0.707), ("peak", 220, 1.5, 0.9),
              ("peak", 3200, -4.5, 0.9), ("highshelf", 7000, -6.0, 0.707)], 2.1),
    "mini": ([("highpass", 60, 0.0, 0.707), ("lowshelf", 170, 5.0, 0.707), ("peak", 250, 2.0, 1.0),
              ("highshelf", 7000, -6.0, 0.707)], 0.0),
}


def _biquad(kind, f, gain_db, q, fs=SR):
    a = 10 ** (gain_db / 40)
    w = 2 * np.pi * f / fs
    cw, sw = np.cos(w), np.sin(w)
    alpha = sw / (2 * q)
    if kind == "peak":
        b = [1 + alpha * a, -2 * cw, 1 - alpha * a]
        den = [1 + alpha / a, -2 * cw, 1 - alpha / a]
    elif kind == "lowshelf":
        sq = 2 * np.sqrt(a) * alpha
        b = [a * ((a + 1) - (a - 1) * cw + sq), 2 * a * ((a - 1) - (a + 1) * cw), a * ((a + 1) - (a - 1) * cw - sq)]
        den = [(a + 1) + (a - 1) * cw + sq, -2 * ((a - 1) + (a + 1) * cw), (a + 1) + (a - 1) * cw - sq]
    elif kind == "highshelf":
        sq = 2 * np.sqrt(a) * alpha
        b = [a * ((a + 1) + (a - 1) * cw + sq), -2 * a * ((a - 1) + (a + 1) * cw), a * ((a + 1) + (a - 1) * cw - sq)]
        den = [(a + 1) - (a - 1) * cw + sq, 2 * ((a - 1) - (a + 1) * cw), (a + 1) - (a - 1) * cw - sq]
    elif kind == "highpass":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        den = [1 + alpha, -2 * cw, 1 - alpha]
    else:
        raise ValueError(kind)
    return np.array(b + den) / den[0]


class VoiceEQ:
    """One reply's EQ: call it on each 24 kHz chunk in order."""

    def __init__(self, curve):
        bands, gain_db = CURVES[curve]
        self.sos = np.stack([_biquad(*band) for band in bands])
        self.gain = 10 ** (gain_db / 20)
        self.zi = np.zeros((self.sos.shape[0], 2))

    def __call__(self, chunk):
        y, self.zi = sosfilt(self.sos, np.asarray(chunk, dtype=np.float64), zi=self.zi)
        return (y * self.gain).astype(np.float32)

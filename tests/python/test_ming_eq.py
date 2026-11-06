"""The warmer EQ on the cloned voices (src/ming_eq.py, used by src/ming-tts-service.py).

Run from the repo root:  venv/bin/python -m unittest discover -s tests/python -v
"""
import ast
import os
import sys
import unittest

import numpy as np
from scipy.signal import sosfreqz

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src"))
import ming_eq  # noqa: E402

SERVICE = os.path.join(ROOT, "src", "ming-tts-service.py")


def service_dict(name):
    """A dict literal from the service source (importing it would load MLX)."""
    for node in ast.walk(ast.parse(open(SERVICE).read())):
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in ming-tts-service.py")


def gain_db(curve, hz):
    eq = ming_eq.VoiceEQ(curve)
    _, h = sosfreqz(eq.sos, worN=[hz], fs=ming_eq.SR)
    return 20 * np.log10(abs(h[0]) * eq.gain)


class VoiceEq(unittest.TestCase):
    # Ming streams a reply in chunks of any size. Filtering each chunk on its
    # own would click at every boundary; with the state carried over, the
    # streamed reply must equal the whole reply filtered at once.
    def test_a_reply_in_chunks_comes_out_the_same_as_in_one_piece(self):
        rng = np.random.default_rng(0)
        reply = (rng.standard_normal(3 * ming_eq.SR) * 0.2).astype(np.float32)
        for curve in ming_eq.CURVES:
            with self.subTest(curve):
                whole = ming_eq.VoiceEQ(curve)(reply)
                eq, parts, at = ming_eq.VoiceEQ(curve), [], 0
                for size in (9600, 7, 12000, 1, 4800, 31):
                    parts.append(eq(reply[at:at + size]))
                    at += size
                parts.append(eq(reply[at:]))
                self.assertLess(np.abs(np.concatenate(parts) - whole).max(), 1e-6)

    # What the user asked for: the clones were "heavy on the high end and
    # missing low ends". Each curve lifts the body and takes off the air.
    def test_each_voice_gets_more_low_end_and_less_high_end(self):
        for curve in ming_eq.CURVES:
            with self.subTest(curve):
                mid = gain_db(curve, 1000)
                self.assertGreater(gain_db(curve, 120) - mid, 3)
                self.assertLess(gain_db(curve, 9000) - mid, -4)

    # A voice without a curve would fail on its first line.
    def test_every_cloned_voice_has_a_curve(self):
        voices, voice_eq = service_dict("VOICES"), service_dict("VOICE_EQ")
        self.assertEqual(set(voice_eq), set(voices))
        self.assertTrue(set(voice_eq.values()) <= set(ming_eq.CURVES))


if __name__ == "__main__":
    unittest.main()

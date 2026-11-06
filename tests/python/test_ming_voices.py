"""Tubs' cloned voices and the Ming service's voice table (src/ming-tts-service.py) must agree.

Run from the repo root:  venv/bin/python -m unittest discover -s tests/python -v

A ming:<name> voice in Tubs' settings that the Ming service doesn't know fails on
every line and drops to Kokoro; a Ming voice without its reference files fails the
whole service at load. Neither shows up until someone talks to Tubs.
"""
import ast
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(ROOT, "src", "ming-tts-service.py")
VOICE_DIR = os.environ.get("MING_VOICE_DIR") or os.path.join(ROOT, "data", "ming-voices")


def _ming_voices():
    """VOICES from the service source (importing it would load MLX)."""
    tree = ast.parse(open(SERVICE).read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "VOICES" for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError("VOICES not found in ming-tts-service.py")


def _tubs_ming_voices():
    config = open(os.path.join(ROOT, "src", "shared", "contracts", "config.ts")).read()
    return set(re.findall(r"'ming:([a-z0-9-]+)'", config))


class MingVoices(unittest.TestCase):
    def test_every_cloned_voice_in_tubs_exists_in_the_ming_service(self):
        self.assertEqual(_tubs_ming_voices(), set(_ming_voices()))

    @unittest.skipUnless(os.path.isdir(VOICE_DIR), "voice references not on this machine (kept out of git)")
    def test_every_ming_voice_has_its_reference_files(self):
        for name, ref in _ming_voices().items():
            for f in (f"{ref}.wav", f"{ref}.txt", f"spk_emb_{ref}.npy"):
                with self.subTest(voice=name, file=f):
                    self.assertTrue(os.path.isfile(os.path.join(VOICE_DIR, f)))


if __name__ == "__main__":
    unittest.main()

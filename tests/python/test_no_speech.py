"""Whisper's no-speech score in the speech service (src/realtime-processing-service.py).

Run from the repo root:  venv/bin/python -m unittest discover -s tests/python -v

Fed silence or noise, Whisper writes fluent text ("you", "I'm sorry." x29) and
Tubs answered it as if a visitor had spoken. Whisper scores each window's
chance of no speech; on this model silence, noise and hum scored 0.81-0.91,
real speech 0.04-0.11.
"""
import importlib.util
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_spec = importlib.util.spec_from_file_location("speech_service", os.path.join(ROOT, "src", "realtime-processing-service.py"))
svc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(svc)


class NoSpeechFilter(unittest.TestCase):
    # A confident phantom is still a phantom: Whisper's own guard also wants
    # low confidence, which is how "I'm sorry." x29 got through.
    def test_drops_text_whisper_scored_as_no_speech(self):
        self.assertEqual(svc._speech_text("I'm sorry. I'm sorry. I'm sorry.", [0.84]), "")
        self.assertEqual(svc._speech_text("you", [0.91]), "")

    def test_keeps_real_speech_even_a_single_word(self):
        self.assertEqual(svc._speech_text("Boring!", [0.11]), "Boring!")
        self.assertEqual(svc._speech_text("Ooh, he's nervous.", [0.04]), "Ooh, he's nervous.")

    # A long clip with speech in one window and silence in another is speech.
    def test_keeps_a_clip_with_speech_in_any_window(self):
        self.assertEqual(svc._speech_text("Hello there.", [0.9, 0.05]), "Hello there.")

    def test_keeps_the_text_when_no_score_came_back(self):
        self.assertEqual(svc._speech_text("Hello.", []), "Hello.")
        self.assertEqual(svc._speech_text("Hello.", [float("nan")]), "Hello.")


if __name__ == "__main__":
    unittest.main()

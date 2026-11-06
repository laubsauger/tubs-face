"""Silero voice check before Whisper in the speech service (src/realtime-processing-service.py).

Run from the repo root:  venv/bin/python -m unittest discover -s tests/python -v

The browser's voice detector lets through music, clatter and hum, and Whisper
writes text for all of it. Clips Silero finds no speech in never reach Whisper,
so the gate must stop noise and must never stop a one-word answer.
"""
import importlib.util
import io
import os
import shutil
import subprocess
import tempfile
import unittest
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_spec = importlib.util.spec_from_file_location("speech_service", os.path.join(ROOT, "src", "realtime-processing-service.py"))
svc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(svc)

RATE = 16000


def _noises():
    rng = np.random.default_rng(0)
    t = np.arange(3 * RATE) / RATE
    return {
        "white noise": (rng.standard_normal(3 * RATE) * 0.3).astype(np.float32),
        "mains hum": (0.2 * np.sin(2 * np.pi * 50 * t) + 0.1 * np.sin(2 * np.pi * 150 * t)).astype(np.float32),
        "a held chord": (0.1 * sum(np.sin(2 * np.pi * f * t) for f in (220, 277, 330))).astype(np.float32),
    }


def _wav_bytes(samples):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


class VoiceGate(unittest.TestCase):
    def test_noise_has_less_speech_than_the_gate(self):
        for name, audio in _noises().items():
            with self.subTest(name):
                self.assertLess(svc._speech_ms(audio), svc.VAD_MIN_SPEECH_MS)

    @unittest.skipUnless(shutil.which("say"), "needs macOS say to speak a word")
    def test_a_single_spoken_word_passes_the_gate(self):
        from faster_whisper.audio import decode_audio
        with tempfile.TemporaryDirectory() as d:
            for word in ("No.", "Hi."):
                path = os.path.join(d, "word.wav")
                subprocess.run(["say", "-o", path, "--data-format=LEI16@16000", word], check=True)
                with self.subTest(word):
                    self.assertGreaterEqual(svc._speech_ms(decode_audio(path, sampling_rate=RATE)), svc.VAD_MIN_SPEECH_MS)

    # The point of the gate: noise is answered with no text and Whisper never runs.
    def test_transcribe_returns_no_text_for_noise_without_running_whisper(self):
        def whisper_must_not_run():
            raise AssertionError("Whisper ran on noise")
        original, svc.ensure_stt_model = svc.ensure_stt_model, whisper_must_not_run
        try:
            client = svc.app.test_client()
            for name, audio in _noises().items():
                with self.subTest(name):
                    res = client.post("/transcribe", data={"audio": (io.BytesIO(_wav_bytes(audio)), "clip.wav", "audio/wav")},
                                      content_type="multipart/form-data")
                    self.assertEqual(res.status_code, 200)
                    self.assertEqual(res.get_json()["text"], "")
        finally:
            svc.ensure_stt_model = original


if __name__ == "__main__":
    unittest.main()

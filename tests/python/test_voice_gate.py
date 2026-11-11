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
import threading
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

    # Each decode of the clip costs ~40-50 ms before Whisper can start, and the
    # reply waits for Whisper. The clip is decoded once; Whisper gets the samples.
    @unittest.skipUnless(shutil.which("say"), "needs macOS say to speak a phrase")
    def test_the_clip_is_decoded_once_and_whisper_gets_the_samples(self):
        class FakeWhisper:
            got = None

            def transcribe(self, audio, language=None):
                FakeWhisper.got = audio
                return {"text": "Hi there."}
        decodes = []
        real_decode = svc._decode_clip
        patched = dict(_decode_clip=lambda path: decodes.append(path) or real_decode(path),
                       ensure_stt_model=lambda: FakeWhisper(), STT_BACKEND="mlx")
        saved = {k: getattr(svc, k) for k in patched}
        for k, v in patched.items():
            setattr(svc, k, v)
        try:
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, "phrase.wav")
                subprocess.run(["say", "-o", path, "--data-format=LEI16@16000", "Hi there, how are you?"], check=True)
                with open(path, "rb") as f:
                    res = svc.app.test_client().post("/transcribe", data={"audio": (f, "clip.wav", "audio/wav")},
                                                     content_type="multipart/form-data")
            self.assertEqual(res.get_json()["text"], "Hi there.")
            self.assertEqual(len(decodes), 1)
            self.assertNotIsInstance(FakeWhisper.got, str)  # samples, not a file for Whisper to decode again
        finally:
            for k, v in saved.items():
                setattr(svc, k, v)


if __name__ == "__main__":
    unittest.main()


class ClipDecode(unittest.TestCase):
    # Seen on 10 Nov: the service crashed twice (Metal "A command encoder is already encoding to this
    # command buffer", then a segfault). The MLX loader's clip is a lazy GPU array; the voice check turned
    # it into numpy outside _gpu_lock while another request's Whisper ran on the GPU.
    @unittest.skipUnless(svc.STT_BACKEND == "mlx" and shutil.which("ffmpeg"), "needs the MLX speech-to-text and ffmpeg")
    def test_the_clip_waits_for_the_gpu_and_leaves_as_numpy(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "clip.wav")
            with open(path, "wb") as f:
                f.write(_wav_bytes(_noises()["mains hum"]))
            got = {}
            svc._gpu_lock.acquire()   # another request is on the GPU
            try:
                t = threading.Thread(target=lambda: got.setdefault("audio", svc._decode_clip(path)))
                t.start()
                t.join(1.0)
                self.assertTrue(t.is_alive(), "the clip was decoded on the GPU while another request held it")
            finally:
                svc._gpu_lock.release()
            t.join(10)
            self.assertIsInstance(got["audio"], np.ndarray, "only numpy leaves the lock")
            self.assertEqual(got["audio"].dtype, np.float32)
            self.assertEqual(len(got["audio"]), 3 * RATE)

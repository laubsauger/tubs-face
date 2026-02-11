#!/usr/bin/env python3
"""
Benchmark STT + TTS models on Apple Silicon to find the sweet spot.
Usage: ./venv/bin/python benchmark.py
"""

import os
import sys
import time
import struct
import io
import subprocess
import tempfile
import numpy as np

# Suppress noisy logs
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

SAMPLE_TTS_TEXT = "Hey, what are you doing just standing there? You know I need wheels, right? Venmo me and let's make this happen."
SAMPLE_TTS_SHORT = "What's your name?"
STT_TEST_DURATION = 3  # seconds of silence to transcribe (tests pipeline overhead)

# Generate a test WAV (3s of near-silence with a tiny bit of noise)
def make_test_wav(duration_s=3, sample_rate=16000):
    samples = int(duration_s * sample_rate)
    audio = (np.random.randn(samples) * 0.001).astype(np.float32)
    pcm = np.clip(audio * 32767, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    buf.write(b'RIFF')
    buf.write(struct.pack('<I', 36 + len(pcm) * 2))
    buf.write(b'WAVE')
    buf.write(b'fmt ')
    buf.write(struct.pack('<IHHIIHH', 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
    buf.write(b'data')
    buf.write(struct.pack('<I', len(pcm) * 2))
    buf.write(pcm.tobytes())
    path = os.path.join(tempfile.gettempdir(), "bench_test.wav")
    with open(path, 'wb') as f:
        f.write(buf.getvalue())
    return path


def pcm_to_wav_bytes(pcm_float32, sample_rate=24000):
    pcm_int16 = np.clip(pcm_float32 * 32767, -32768, 32767).astype(np.int16)
    num_samples = len(pcm_int16)
    data_size = num_samples * 2
    buf = io.BytesIO()
    buf.write(b'RIFF')
    buf.write(struct.pack('<I', 36 + data_size))
    buf.write(b'WAVE')
    buf.write(b'fmt ')
    buf.write(struct.pack('<IHHIIHH', 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
    buf.write(b'data')
    buf.write(struct.pack('<I', data_size))
    buf.write(pcm_int16.tobytes())
    return buf.getvalue()


def hr(label=""):
    print(f"\n{'━' * 60}")
    if label:
        print(f"  {label}")
        print(f"{'━' * 60}")


def benchmark_stt():
    """Test different Whisper model sizes via lightning-whisper-mlx."""
    hr("STT BENCHMARK (lightning-whisper-mlx)")

    models = ["tiny", "small", "distil-small.en", "medium", "distil-medium.en", "large-v3-turbo"]
    test_wav = make_test_wav()
    results = []

    for model_name in models:
        print(f"\n  Loading {model_name}...", end=" ", flush=True)
        try:
            from lightning_whisper_mlx import LightningWhisperMLX
            t0 = time.time()
            model = LightningWhisperMLX(model=model_name, batch_size=12)
            load_time = time.time() - t0
            print(f"loaded in {load_time:.1f}s")

            # Warm-up run
            model.transcribe(test_wav, language="en")

            # Benchmark 3 runs
            times = []
            for _ in range(3):
                t0 = time.time()
                result = model.transcribe(test_wav, language="en")
                times.append(time.time() - t0)

            avg = sum(times) / len(times)
            results.append({
                "model": model_name,
                "load_s": load_time,
                "avg_ms": avg * 1000,
                "text": result.get("text", "")[:60],
            })
            print(f"  → avg {avg*1000:.0f}ms per transcription (load: {load_time:.1f}s)")

            # Cleanup
            del model

        except Exception as e:
            print(f"FAILED: {e}")
            results.append({"model": model_name, "load_s": 0, "avg_ms": -1, "text": str(e)[:60]})

    hr("STT RESULTS")
    print(f"  {'Model':<25} {'Load':>7} {'Avg Transcribe':>15}")
    print(f"  {'─'*25} {'─'*7} {'─'*15}")
    for r in results:
        load = f"{r['load_s']:.1f}s" if r['load_s'] > 0 else "—"
        avg = f"{r['avg_ms']:.0f}ms" if r['avg_ms'] > 0 else "FAILED"
        print(f"  {r['model']:<25} {load:>7} {avg:>15}")


def benchmark_tts():
    """Test Kokoro TTS performance."""
    hr("TTS BENCHMARK (Kokoro-82M-bf16)")

    try:
        from mlx_audio.tts.utils import load_model as load_tts_model

        print("  Loading Kokoro model...", end=" ", flush=True)
        t0 = time.time()
        tts_model = load_tts_model("mlx-community/Kokoro-82M-bf16")
        load_time = time.time() - t0
        print(f"loaded in {load_time:.1f}s")

        texts = [
            ("short", SAMPLE_TTS_SHORT),
            ("medium", SAMPLE_TTS_TEXT),
        ]

        # Warm-up
        for result in tts_model.generate(text="Hello.", voice="af_heart", speed=1.0, lang_code="a"):
            pass

        results = []
        for label, text in texts:
            times = []
            audio_len = 0
            for _ in range(3):
                t0 = time.time()
                segments = []
                for result in tts_model.generate(text=text, voice="af_heart", speed=1.0, lang_code="a"):
                    segments.append(np.array(result.audio))
                elapsed = time.time() - t0
                times.append(elapsed)
                if segments:
                    combined = np.concatenate(segments)
                    audio_len = len(combined) / 24000  # seconds at 24kHz

            avg = sum(times) / len(times)
            rtf = avg / audio_len if audio_len > 0 else 0
            results.append({
                "label": label,
                "text_len": len(text),
                "audio_s": audio_len,
                "avg_ms": avg * 1000,
                "rtf": rtf,
            })
            print(f"  {label}: {avg*1000:.0f}ms → {audio_len:.1f}s audio (RTF: {rtf:.2f}x)")

        hr("TTS RESULTS")
        print(f"  {'Type':<10} {'Chars':>6} {'Gen Time':>10} {'Audio':>8} {'RTF':>8}")
        print(f"  {'─'*10} {'─'*6} {'─'*10} {'─'*8} {'─'*8}")
        for r in results:
            print(f"  {r['label']:<10} {r['text_len']:>6} {r['avg_ms']:>8.0f}ms {r['audio_s']:>6.1f}s {r['rtf']:>7.2f}x")
        print(f"\n  RTF < 1.0 = faster than real-time (good)")
        print(f"  RTF > 1.0 = slower than real-time (user waits)")

    except Exception as e:
        print(f"  FAILED: {e}")


def benchmark_stt_batch_sizes():
    """Test different batch sizes for the current model."""
    hr("STT BATCH SIZE BENCHMARK")

    model_name = "small"
    batch_sizes = [6, 12, 24]
    test_wav = make_test_wav(duration_s=5)

    from lightning_whisper_mlx import LightningWhisperMLX

    for bs in batch_sizes:
        try:
            print(f"\n  {model_name} batch_size={bs}...", end=" ", flush=True)
            model = LightningWhisperMLX(model=model_name, batch_size=bs)
            # Warm-up
            model.transcribe(test_wav, language="en")
            times = []
            for _ in range(3):
                t0 = time.time()
                model.transcribe(test_wav, language="en")
                times.append(time.time() - t0)
            avg = sum(times) / len(times)
            print(f"avg {avg*1000:.0f}ms")
            del model
        except Exception as e:
            print(f"FAILED: {e}")


if __name__ == "__main__":
    print("╔══════════════════════════════════════════════════════════╗")
    print("║     TUBS ML BENCHMARK — Apple Silicon (M3 Max)         ║")
    print("╚══════════════════════════════════════════════════════════╝")

    args = sys.argv[1:]
    run_all = not args or "all" in args

    if run_all or "stt" in args:
        benchmark_stt()

    if run_all or "tts" in args:
        benchmark_tts()

    if run_all or "batch" in args:
        benchmark_stt_batch_sizes()

    hr("RECOMMENDATIONS")
    print("""
  GPU load breakdown (typical):
  • STT (Whisper): Spikes during transcription (~1-3s per utterance)
  • TTS (Kokoro):  Spikes during generation (~0.1-2s per phrase)
  • Face detection: Continuous but runs on CPU (WASM), not GPU

  To reduce GPU load:
  1. STT: Switch from large-v3-turbo → small or distil-small.en
     (biggest single win — large model saturates GPU during transcription)
  2. STT: Reduce batch_size from 12 → 6
     (trades latency for less peak GPU usage)
  3. TTS: Kokoro-82M is already small, little to gain here
  4. Face detection: Increase detection interval (already adaptive)

  Sweet spot for M3 Max:
  • STT: distil-small.en or small (fast, accurate enough for conversational)
  • TTS: Kokoro-82M-bf16 (only option, already efficient)
  • Batch size: 12 (good balance)
""")

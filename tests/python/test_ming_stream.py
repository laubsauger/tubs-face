"""Ming streaming in the speech service (src/realtime-processing-service.py).

Run from the repo root:  venv/bin/python -m unittest discover -s tests/python -v

A fake Ming service (stdlib HTTP on a free port) plays scripted answers and a
fake socket records what the Node server would receive. No model is loaded and
nothing is played.
"""
import base64
import importlib.util
import json
import os
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_spec = importlib.util.spec_from_file_location("speech_service", os.path.join(ROOT, "src", "realtime-processing-service.py"))
svc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(svc)

TEXT = "Nice hat. Did it come with instructions?"


def chunk_line(index, last):
    audio = base64.b64encode(f"wav{index}".encode()).decode()
    return (json.dumps({"audio": audio, "index": index, "last": last}) + "\n").encode()


class FakeMing(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    script = None  # (handler) -> None, set per test
    paths = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        FakeMing.paths.append(self.path)
        FakeMing.script(self)

    def stream_head(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True


class FakeSocket:
    """The Node server's end of /tts/stream."""

    def __init__(self, fail_on_send=None):
        self.messages = []
        self.fail_on_send = fail_on_send

    def send(self, raw):
        if self.fail_on_send is not None and len(self.messages) >= self.fail_on_send:
            raise ConnectionError("socket closed by the Node server")
        self.messages.append(json.loads(raw))


class MingStreamForwarding(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeMing)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        svc.MING_TTS_URL = f"http://127.0.0.1:{self.server.server_address[1]}"
        FakeMing.paths = []
        svc.print = lambda *a, **k: None  # keep the service's log lines out of the test output

    def tearDown(self):
        del svc.print

    # The first sound must not wait for the whole reply: each chunk goes to
    # the face as soon as Ming has it, in order, the same text on every chunk
    # (Node uses it for subtitles and fillers), "more" on all but the last.
    def test_forwards_each_chunk_in_order_then_done(self):
        def script(h):
            h.stream_head()
            for i in range(3):
                h.wfile.write(chunk_line(i, last=i == 2))
            h.wfile.write(b'{"done": true, "render_ms": 900, "audio_s": 2.1}\n')
        FakeMing.script = script
        ws = FakeSocket()

        self.assertTrue(svc._send_ming_stream(ws, TEXT))

        self.assertEqual(FakeMing.paths, ["/tts/stream"])
        chunks, done = ws.messages[:-1], ws.messages[-1]
        self.assertEqual([base64.b64decode(m["audio"]) for m in chunks], [b"wav0", b"wav1", b"wav2"])
        self.assertTrue(all(m["chunk"] and m["text"] == TEXT for m in chunks))
        self.assertEqual([m.get("more", False) for m in chunks], [True, True, False])
        self.assertEqual(done, {"text": TEXT, "done": True})

    # Half a reply can't be finished in Kokoro's voice, but the turn must not
    # hang waiting for audio that never comes: the done still goes out.
    def test_a_stream_that_dies_midway_still_ends_the_reply(self):
        def cut_off(h):
            h.stream_head()
            h.wfile.write(chunk_line(0, last=False))
        def error_line(h):
            h.stream_head()
            h.wfile.write(chunk_line(0, last=False))
            h.wfile.write(b'{"error": "RuntimeError: Metal out of memory"}\n')
        for script in (cut_off, error_line):
            with self.subTest(script.__name__):
                FakeMing.script = script
                ws = FakeSocket()
                self.assertTrue(svc._send_ming_stream(ws, TEXT))
                self.assertEqual([m.get("chunk", False) for m in ws.messages], [True, False])
                self.assertEqual(ws.messages[-1], {"text": TEXT, "done": True})

    # Nothing rendered yet: the caller speaks the whole reply with Kokoro.
    def test_no_audio_from_ming_means_kokoro_speaks_instead(self):
        def error_first(h):
            h.stream_head()
            h.wfile.write(b'{"error": "RuntimeError: boom"}\n')
        def http_500(h):
            h.send_response(500)
            h.send_header("Content-Length", "0")
            h.end_headers()
        for script in (error_first, http_500):
            with self.subTest(script.__name__):
                FakeMing.script = script
                ws = FakeSocket()
                self.assertFalse(svc._send_ming_stream(ws, TEXT))
                self.assertEqual(ws.messages, [])
        with self.subTest("ming down"):
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                free_port = s.getsockname()[1]
            svc.MING_TTS_URL = f"http://127.0.0.1:{free_port}"
            ws = FakeSocket()
            self.assertFalse(svc._send_ming_stream(ws, TEXT))
            self.assertEqual(ws.messages, [])

    # The streaming speech service may be deployed before the Ming service is
    # switched to ming_service_stream.py: the old one has no /tts/stream, and
    # Tubs must keep its voice (whole reply in one chunk), not drop to Kokoro.
    def test_older_ming_service_without_stream_route_still_speaks_ming(self):
        def old_service(h):
            if h.path == "/tts/stream":
                h.send_response(404)
                h.send_header("Content-Length", "0")
                h.end_headers()
                return
            body = b"RIFFwhole-reply"
            h.send_response(200)
            h.send_header("Content-Type", "audio/wav")
            h.send_header("Content-Length", str(len(body)))
            h.end_headers()
            h.wfile.write(body)
        FakeMing.script = old_service
        ws = FakeSocket()

        self.assertTrue(svc._send_ming_stream(ws, TEXT))

        self.assertEqual(FakeMing.paths, ["/tts/stream", "/tts"])
        self.assertEqual(len(ws.messages), 2)
        self.assertEqual(base64.b64decode(ws.messages[0]["audio"]), b"RIFFwhole-reply")
        self.assertNotIn("more", ws.messages[0])
        self.assertEqual(ws.messages[1], {"text": TEXT, "done": True})

    # An interrupt closes the Node socket. The Ming request must be dropped
    # with it, so Ming stops rendering audio nobody will hear and frees the GPU
    # for the next reply.
    def test_a_closed_socket_cancels_the_ming_request(self):
        dropped = threading.Event()

        def endless(h):
            h.stream_head()
            try:
                for i in range(200):
                    h.wfile.write(chunk_line(i, last=False))
                    time.sleep(0.02)
            except OSError:
                dropped.set()
        FakeMing.script = endless
        ws = FakeSocket(fail_on_send=1)

        with self.assertRaises(ConnectionError):
            svc._send_ming_stream(ws, TEXT)
        self.assertTrue(dropped.wait(3), "Ming kept streaming after the socket closed")
        self.assertEqual(len(ws.messages), 1)


if __name__ == "__main__":
    unittest.main()

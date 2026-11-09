"""The face service's pipeline (src/face_pipeline.py) against the browser worker's embeddings.

The face library's embeddings were made by the browser worker (src/workers/face-worker.ts). If
the service embedded the same face differently, everyone enrolled would stop being recognised
the day it took over. So: the same pictures through both, and the embeddings must agree
(tests/fixtures/faces/browser-embeddings.json, written by tests/face-compat/run.ts from the
real worker in headless Chrome).

Run from the repo root:  venv/bin/python -m unittest discover -s tests/python -v
The model tests need the models in FACE_MODEL_DIR (~/.cache/tubs-face/models; the face
service downloads them on its first start) and are skipped, loudly, without them.
"""
import json
import os
import sys
import unittest

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src"))
import face_pipeline as fp  # noqa: E402

FIXTURES = os.path.join(ROOT, "tests", "fixtures", "faces")
MODEL_DIR = os.path.expanduser(os.environ.get("FACE_MODEL_DIR") or "~/.cache/tubs-face/models")
BROWSER = json.load(open(os.path.join(FIXTURES, "browser-embeddings.json")))
# Same face, same pixels: anything below this is a preprocessing difference, not float noise
# (CoreML's FP16 default came out at 0.995; the browser copy on CPU or CoreML FP32 at 0.99998).
MIN_COSINE = 0.999


class BrowserConventions(unittest.TestCase):
    """The browser's quirks the library depends on; insightface does each of these differently."""

    def test_anchor_centres_sit_half_a_stride_in(self):
        # face-worker.ts generateAnchors: (col + 0.5) * stride. With insightface's col * stride
        # the landmarks move by up to 16 px and the embeddings drop to a cosine of ~0.5-0.7.
        for anchors, stride in zip(fp.ANCHORS, fp.STRIDES):
            self.assertEqual(tuple(anchors[0]), (stride / 2, stride / 2))
            self.assertEqual(tuple(anchors[1]), (stride / 2, stride / 2))  # two anchors per place
            self.assertEqual(tuple(anchors[2]), (stride * 1.5, stride / 2))

    def test_models_get_blue_green_red_planes(self):
        rgb = np.zeros((4, 4, 3), dtype=np.uint8)
        rgb[..., 0] = 255  # pure red
        face = fp.embedding_input(np.zeros((112, 112, 3), dtype=np.uint8) + np.array([255, 0, 0], dtype=np.uint8))
        self.assertAlmostEqual(float(face[0, 2].mean()), 1.0)  # red is the last plane
        self.assertAlmostEqual(float(face[0, 0].mean()), -1.0)
        tensor, _ = fp.detector_input(rgb)
        self.assertGreater(float(tensor[0, 2, 320, 320]), 0.99)
        self.assertLess(float(tensor[0, 0, 320, 320]), -0.99)

    def test_picture_is_centred_in_the_detector_input_on_black(self):
        rgb = np.full((480, 640, 3), 200, dtype=np.uint8)
        tensor, (scale, pad_x, pad_y) = fp.detector_input(rgb)
        self.assertEqual((scale, pad_x, pad_y), (1.0, 0, 80))
        black = (0 - 127.5) / 128
        self.assertAlmostEqual(float(tensor[0, 0, 40, 320]), black, places=5)  # the band above
        self.assertAlmostEqual(float(tensor[0, 0, 320, 320]), (200 - 127.5) / 128, places=5)

    def test_umeyama_maps_the_template_onto_itself(self):
        a, b, c, d, tx, ty = fp.estimate_umeyama(fp.ARCFACE_TEMPLATE)
        np.testing.assert_allclose([a, b, c, d, tx, ty], [1, 0, 0, 1, 0, 0], atol=1e-9)

    def test_umeyama_undoes_a_shift_and_a_scale(self):
        landmarks = fp.ARCFACE_TEMPLATE * 2 + np.array([100.0, 40.0])
        a, b, c, d, tx, ty = fp.estimate_umeyama(landmarks)
        mapped = landmarks @ np.array([[a, c], [b, d]]) + np.array([tx, ty])
        np.testing.assert_allclose(mapped, fp.ARCFACE_TEMPLATE, atol=1e-6)


class TrackerIds(unittest.TestCase):
    def test_a_face_that_stays_keeps_its_track_and_a_new_one_gets_its_own(self):
        tracker = fp.Tracker()
        first = [{"box": [100, 100, 200, 220]}]
        tracker.assign(first, 0.0)
        first[0]["embedding"] = np.ones(4)
        tracker.remember(first, 0.0)
        moved = [{"box": [104, 102, 204, 222]}, {"box": [400, 100, 500, 220]}]
        tracker.assign(moved, 0.2)
        self.assertEqual(moved[0]["track"], first[0]["track"])
        self.assertIsNotNone(moved[0]["reuse"])  # within a second: no new embedding needed
        self.assertNotEqual(moved[1]["track"], first[0]["track"])
        self.assertIsNone(moved[1]["reuse"])

    def test_an_embedding_is_computed_again_after_a_second(self):
        tracker = fp.Tracker(reuse_s=1.0)
        faces = [{"box": [100, 100, 200, 220]}]
        tracker.assign(faces, 0.0)
        faces[0]["embedding"] = np.ones(4)
        tracker.remember(faces, 0.0)
        later = [{"box": [100, 100, 200, 220]}]
        tracker.assign(later, 0.5)
        tracker.remember(later, 0.5)
        again = [{"box": [100, 100, 200, 220]}]
        tracker.assign(again, 1.1)
        self.assertEqual(again[0]["track"], faces[0]["track"])
        self.assertIsNone(again[0]["reuse"])


def models_present():
    return all(os.path.exists(os.path.join(MODEL_DIR, name)) for name in ("det_10g.onnx", "w600k_r50.onnx"))


@unittest.skipUnless(models_present(), f"face models not in {MODEL_DIR}: start the face service once")
class SameEmbeddingsAsTheBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.log_severity_level = 3
        cls.pipeline = fp.Pipeline(
            ort.InferenceSession(os.path.join(MODEL_DIR, "det_10g.onnx"), options, providers=["CPUExecutionProvider"]),
            ort.InferenceSession(os.path.join(MODEL_DIR, "w600k_r50.onnx"), options, providers=["CPUExecutionProvider"]),
        )

    def test_every_fixture_face_embeds_as_in_the_browser(self):
        checked = 0
        for image, expected in BROWSER["images"].items():
            rgb = np.asarray(Image.open(os.path.join(FIXTURES, image)).convert("RGB"), dtype=np.uint8)
            faces = self.pipeline.detect(rgb)
            self.assertEqual(len(faces), len(expected["faces"]), image)
            for browser_face in expected["faces"]:
                face = max(faces, key=lambda f: fp.iou(f["box"], browser_face["box"]))
                self.assertGreater(fp.iou(face["box"], browser_face["box"]), 0.99, image)
                np.testing.assert_allclose(face["landmarks"], browser_face["landmarks"], atol=0.05, err_msg=image)
                cosine = float(np.dot(self.pipeline.embed(rgb, face["landmarks"]), fp.normalize(browser_face["embedding"])))
                self.assertGreater(cosine, MIN_COSINE, f"{image}: cosine {cosine:.5f} to the browser's embedding")
                checked += 1
        self.assertGreaterEqual(checked, 7)


if __name__ == "__main__":
    unittest.main()

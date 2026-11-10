"""A picture as raw RGBA (base64), decoded by Pillow as the face service decodes it (tests/face-compat/run.ts)."""
import base64
import json
import sys

import numpy as np
from PIL import Image

rgb = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.uint8)
rgba = np.concatenate([rgb, np.full(rgb.shape[:2] + (1,), 255, dtype=np.uint8)], axis=2)
json.dump({"width": rgb.shape[1], "height": rgb.shape[0], "rgba": base64.b64encode(rgba.tobytes()).decode("ascii")}, sys.stdout)

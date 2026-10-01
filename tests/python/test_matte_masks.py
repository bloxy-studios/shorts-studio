import numpy as np
from PIL import Image

from shorts_studio_py.ext_matte import masks


def test_rect_mask_is_opaque_inside_for_any_radius(tmp_path):
    for radius in (0, 200):
        out = tmp_path / f"m{radius}.png"
        masks({"card": {"region": {"x": 0, "y": 1200, "w": 1080, "h": 720}, "rect": {"x": -65, "y": 1200, "w": 1210, "h": 864, "radius": radius}, "out": str(out)}})
        a = np.asarray(Image.open(out), dtype=np.float32) / 255
        assert a[400, 540] == 1.0  # interior
        assert a[0, 540] >= 0.49  # top edge straddles the pixel centre line
        if radius:
            assert a[2, 2] == 0.0  # outside the rounded top-left corner
        else:
            assert a[2, 2] == 1.0


def test_head_ramp_opaque_above_card_top(tmp_path):
    out = tmp_path / "ramp.png"
    masks({"ramp": {"w": 1080, "h": 160, "y0": 1080, "featherY": 1200, "featherPx": 40, "out": str(out)}})
    a = np.asarray(Image.open(out), dtype=np.float32) / 255
    assert a[110, 10] == 1.0  # y=1190, above the card top: fully opaque head
    assert 0.4 < a[140, 10] < 0.6  # y=1220: halfway through the in-card fade
    assert a[159, 10] < 0.05  # y=1239: faded out inside the card

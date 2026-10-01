"""HDR → SDR colour management through a generated 3D LUT (no zimg required).

color.hdr_lut — writes a .cube LUT mapping full-range BT.2020 RGB code values with a PQ
(SMPTE ST 2084) or HLG (ARIB STD-B67, system gamma 1.2) transfer to BT.709 SDR code values:
  decode to display light (nits) → normalise to the BT.2408 reference white (203 nits) →
  hue-preserving luminance tone curve (linear below a knee, smooth exponential shoulder that
  reaches 1.0 at the mastering peak) → BT.2020→BT.709 primaries → BT.1886 inverse (γ 2.4).
color.hdr_testclip — synthesizes a tagged 10-bit HDR test clip with known patch luminances.
"""

from __future__ import annotations

import subprocess

import numpy as np

from .io import ffmpeg_bin

COMMANDS: dict = {}

# SMPTE ST 2084
M1, M2 = 2610 / 16384, 2523 / 4096 * 128
C1, C2, C3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
# ARIB STD-B67
HA, HB, HC = 0.17883277, 1 - 4 * 0.17883277, 0.5 - 0.17883277 * np.log(4 * 0.17883277)
BT2020_TO_709 = np.array([[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]])
Y2020 = np.array([0.2627, 0.6780, 0.0593])
REF_WHITE = 203.0


def pq_eotf(e: np.ndarray) -> np.ndarray:
    p = np.power(np.clip(e, 0, 1), 1 / M2)
    return 10000 * np.power(np.maximum(p - C1, 0) / (C2 - C3 * p), 1 / M1)


def pq_inverse(nits: np.ndarray) -> np.ndarray:
    y = np.power(np.clip(nits / 10000, 0, 1), M1)
    return np.power((C1 + C2 * y) / (1 + C3 * y), M2)


def hlg_inverse_oetf(e: np.ndarray) -> np.ndarray:
    e = np.clip(e, 0, 1)
    return np.where(e <= 0.5, e * e / 3, (np.exp((e - HC) / HA) + HB) / 12)


def hlg_oetf(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0, 1)
    return np.where(x <= 1 / 12, np.sqrt(3 * x), HA * np.log(np.maximum(12 * x - HB, 1e-12)) + HC)


def tone_curve(y: np.ndarray, peak: float, knee: float = 0.75) -> np.ndarray:
    """Linear below `knee` (SDR-normalised); exponential shoulder normalised so `peak` → 1.0."""
    s = 1 - knee
    norm = 1 - np.exp(-(peak - knee) / s)
    over = np.maximum(y - knee, 0)
    return np.where(y <= knee, y, knee + s * (1 - np.exp(-over / s)) / norm)


def to_sdr(rgb: np.ndarray, kind: str, peak_nits: float) -> np.ndarray:
    """rgb: (..., 3) full-range BT.2020 code values → (..., 3) BT.709 SDR code values."""
    if kind == "pq":
        nits = pq_eotf(rgb)
    else:
        scene = hlg_inverse_oetf(rgb)
        ys = np.maximum((scene * Y2020).sum(-1, keepdims=True), 1e-12)
        nits = peak_nits * np.power(ys, 0.2) * scene  # OOTF, system gamma 1.2 at a 1000-nit display
    x = nits / REF_WHITE
    y = np.maximum((x * Y2020).sum(-1, keepdims=True), 1e-12)
    yt = tone_curve(y, peak_nits / REF_WHITE)
    x = x * (yt / y)
    lin709 = np.clip(x @ BT2020_TO_709.T, 0, None)
    over = lin709.max(-1, keepdims=True)
    scale = np.divide(1.0, over, out=np.ones_like(over), where=over > 1)
    lin709 = lin709 * scale  # keep hue when a channel exceeds white
    return np.power(np.clip(lin709, 0, 1), 1 / 2.4)


def hdr_lut(a: dict) -> dict:
    kind = a["kind"]
    if kind not in ("pq", "hlg"):
        raise ValueError("kind must be pq or hlg")
    n = int(a.get("size", 33))
    peak = float(a.get("peakNits", 1000))
    g = np.linspace(0, 1, n)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")  # .cube order: R fastest
    rgb = np.stack([r, gg, b], -1).reshape(-1, 3)
    out = to_sdr(rgb, kind, peak)
    with open(a["out"], "w") as f:
        f.write(f"TITLE \"Shorts Studio {kind.upper()} BT.2020 -> SDR BT.709 (ref white 203 nits, peak {peak:g} nits)\"\n")
        f.write(f"LUT_3D_SIZE {n}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n")
        for v in out:
            f.write(f"{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
    probe = {nits: float(to_sdr(np.array([[pq_inverse(np.array(nits))] * 3]) if kind == "pq" else np.array([[float(hlg_oetf(np.array(nits / peak) ** (1 / 1.2)))] * 3]), kind, peak)[0, 0]) for nits in (36.5, 100.0, 203.0, 1000.0)}
    return {"out": a["out"], "size": n, "kind": kind, "peakNits": peak, "sdrCodeForNits": probe}


def hdr_testclip(a: dict) -> dict:
    """Patches (neutral) at given nits + a saturated BT.2020 red; 10-bit ProRes tagged PQ or HLG."""
    kind = a["kind"]
    w, h = 640, 360
    nits = [36.5, 100.0, 203.0, 1000.0]
    peak = float(a.get("peakNits", 1000))
    img = np.zeros((h, w, 3))
    for i, L in enumerate(nits):
        code = pq_inverse(np.array(L)) if kind == "pq" else hlg_oetf(np.array((L / peak) ** (1 / 1.2)))
        img[:, i * 128 : (i + 1) * 128] = code
    img[:, 512:] = (pq_inverse(np.array([203.0, 10.0, 10.0])) if kind == "pq" else hlg_oetf(np.array([203.0, 10.0, 10.0]) / peak) ** 1)
    raw = (np.clip(img, 0, 1) * 65535).astype("<u2").tobytes()
    trc = "smpte2084" if kind == "pq" else "arib-std-b67"
    cmd = [ffmpeg_bin(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", f"{w}x{h}", "-r", "30", "-i", "-", "-t", "1",
           "-vf", f"scale=out_color_matrix=bt2020:out_range=tv,format=yuv422p10le,setparams=color_trc={trc}:color_primaries=bt2020:colorspace=bt2020nc:range=tv", "-c:v", "prores_ks", "-profile:v", "3",
           "-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc", "-color_range", "tv", a["out"]]
    frames = raw * 30
    subprocess.run(cmd, input=frames, check=True)
    return {"out": a["out"], "patchNits": nits, "patchX": [64, 192, 320, 448], "redX": 576}


COMMANDS["color.hdr_lut"] = hdr_lut
COMMANDS["color.hdr_testclip"] = hdr_testclip

"""Shorts Studio Python helpers: audio analysis, sync, synthesis, CV tracking, matting.

Every command is invoked as ``python -m shorts_studio_py <command> --in args.json --out result.json``
from the TypeScript CLI. Inputs and outputs are JSON; times are integer flicks
(1/705,600,000 s) unless a field name says otherwise.
"""

__version__ = "0.1.0"

FLICKS_PER_SECOND = 705_600_000


def sec_to_flicks(seconds: float) -> int:
    return int(round(seconds * FLICKS_PER_SECOND))


def flicks_to_sec(flicks: int) -> float:
    return flicks / FLICKS_PER_SECOND

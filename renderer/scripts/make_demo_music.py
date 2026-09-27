"""Ambient space score for the landing demo: warm pads, a bell arpeggio, a soft sub, long reverb.
Pure additive synthesis, no noise sources. Writes renderer/public/demo-vo/music.wav (stereo, 44.1 kHz)."""

import wave
from pathlib import Path

import numpy as np

SR = 44100
TOTAL = 47.5
OUT = Path(__file__).resolve().parents[1] / "public" / "demo-vo" / "music.wav"

n = int(SR * TOTAL)
t = np.arange(n) / SR
left = np.zeros(n)
right = np.zeros(n)


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def env(start: float, dur: float, attack: float, release: float) -> np.ndarray:
    """Smooth (raised cosine) attack and release, zero outside the note."""
    e = np.zeros(n)
    i0, i1 = int(start * SR), min(n, int((start + dur + release) * SR))
    if i0 >= n:
        return e
    tt = t[i0:i1] - start
    a = np.clip(tt / attack, 0, 1)
    a = 0.5 - 0.5 * np.cos(np.pi * a)
    r = np.clip((start + dur + release - t[i0:i1]) / release, 0, 1)
    r = 0.5 - 0.5 * np.cos(np.pi * r)
    e[i0:i1] = a * r
    return e


def pad_voice(freq: float, e: np.ndarray, brightness: np.ndarray, pan: float, gain: float) -> None:
    """Soft saw-like tone: a few harmonics with rolloff, two detuned copies for width, slow vibrato."""
    idx = np.nonzero(e)[0]
    if not len(idx):
        return
    sl = slice(idx[0], idx[-1] + 1)
    tt = t[sl]
    vib = 1 + 0.0015 * np.sin(2 * np.pi * 0.21 * tt + freq)
    tone = np.zeros(len(tt))
    for cents, ph in ((-7, 0.0), (7, 1.3)):
        f = freq * 2 ** (cents / 1200) * vib
        phase = 2 * np.pi * np.cumsum(f) / SR + ph
        for h in range(1, 7):
            tone += np.sin(h * phase) * (brightness[sl] ** (h - 1)) / h**1.4
    tone *= e[sl] * gain
    left[sl] += tone * (1 - pan)
    right[sl] += tone * (1 + pan)


def bell(freq: float, start: float, gain: float, pan: float) -> None:
    """Glassy bell: fundamental plus an inharmonic partial, fast decay."""
    i0 = int(start * SR)
    if i0 >= n:
        return
    length = min(n - i0, int(2.4 * SR))
    tt = np.arange(length) / SR
    decay = np.exp(-tt * 2.2)
    tone = np.sin(2 * np.pi * freq * tt) + 0.35 * np.sin(2 * np.pi * freq * 2.76 * tt) * np.exp(-tt * 5)
    tone += 0.12 * np.sin(2 * np.pi * freq * 5.4 * tt) * np.exp(-tt * 9)
    attack = np.clip(tt / 0.004, 0, 1)
    tone *= decay * attack * gain
    left[i0:i0 + length] += tone * (1 - pan)
    right[i0:i0 + length] += tone * (1 + pan)


# Progression in D (lydian colour), ~5.2 s per chord, ending on a wide resolved chord for the outro.
CHORDS = [
    (0.0, [50, 57, 61, 64, 69]),     # Dmaj9 (no 3rd low)   D A C# E A
    (5.2, [47, 54, 57, 61, 66]),     # Bm11 feel            B F# A C# F#
    (10.4, [43, 50, 54, 57, 62]),    # Gmaj7 add9           G D F# A D
    (15.6, [45, 52, 56, 59, 64]),    # A6/9 feel            A E G# B E
    (20.8, [50, 57, 61, 64, 68]),    # Dmaj7#11             D A C# E G#
    (26.0, [47, 54, 57, 62, 66]),    # Bm9                  B F# A D F#
    (31.2, [43, 50, 55, 59, 64]),    # G6/9                 G D G B E
    (36.4, [50, 57, 62, 64, 69]),    # Dsus2 add6 outro     D A D E A
]
CHORD_LEN = 5.2

# Filter brightness rises slowly through the piece and blooms at the outro.
brightness = 0.28 + 0.14 * np.clip(t / TOTAL, 0, 1) + 0.1 * np.clip((t - 36) / 4, 0, 1)
brightness *= 1 + 0.08 * np.sin(2 * np.pi * 0.05 * t)

for start, notes in CHORDS:
    last = start == CHORDS[-1][0]
    dur = (TOTAL - start - 3.0) if last else CHORD_LEN
    e = env(start, dur, attack=1.8, release=2.6 if not last else 3.0)
    for i, midi in enumerate(notes):
        pad_voice(hz(midi), e, brightness, pan=(i - 2) * 0.22, gain=0.055 if i else 0.07)
    # Sub bass: root an octave down, pure sine, gentle.
    root = hz(notes[0] - 12)
    idx = np.nonzero(e)[0]
    sl = slice(idx[0], idx[-1] + 1)
    sub = np.sin(2 * np.pi * root * t[sl]) * e[sl] * 0.11
    left[sl] += sub
    right[sl] += sub

# Bell arpeggio from the second scene on: eighth notes at 88 bpm, up and down the chord an octave up.
step = 60 / 88 / 2
rng = np.random.default_rng(3)
beat = 3.4
k = 0
while beat < TOTAL - 3.5:
    chord = [c for c in CHORDS if c[0] <= beat][-1][1]
    pattern = chord[1:] + chord[-2:0:-1]
    midi = pattern[k % len(pattern)] + 12
    accent = 1.0 if k % 4 == 0 else 0.7
    thin = 0.55 if 20 < beat < 26 else 1.0  # breathe during the audio overview scene
    if rng.random() > 0.12:  # a few rests so it does not feel mechanical
        bell(hz(midi), beat, gain=0.045 * accent * thin, pan=0.5 * np.sin(k * 0.9))
    beat += step
    k += 1

# Ping pong delay on everything (dotted eighth), dark feedback.
delay = int(SR * step * 1.5)
fb = 0.3
dl, dr = np.zeros(n), np.zeros(n)
for i in range(3):
    shift = delay * (i + 1)
    g = fb ** (i + 1)
    src_l, src_r = (right, left) if i % 2 == 0 else (left, right)
    dl[shift:] += src_l[:-shift] * g
    dr[shift:] += src_r[:-shift] * g
left += dl * 0.5
right += dr * 0.5

# Long reverb: convolution with a smooth decaying impulse (built from low passed, decaying partials,
# not white noise, so it stays silky).
ir_len = int(SR * 3.2)
it = np.arange(ir_len) / SR
ir_l = np.zeros(ir_len)
ir_r = np.zeros(ir_len)
for f in rng.uniform(180, 2400, 90):
    ph = rng.uniform(0, 2 * np.pi, 2)
    d = np.exp(-it * rng.uniform(1.1, 2.2))
    ir_l += np.sin(2 * np.pi * f * it + ph[0]) * d
    ir_r += np.sin(2 * np.pi * f * it + ph[1]) * d
ir_l /= np.max(np.abs(ir_l))
ir_r /= np.max(np.abs(ir_r))


def convolve(x: np.ndarray, ir: np.ndarray) -> np.ndarray:
    size = 1 << int(np.ceil(np.log2(len(x) + len(ir))))
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)
    return y[: len(x)]


wet_l = convolve(left, ir_l)
wet_r = convolve(right, ir_r)
wet_l /= np.max(np.abs(wet_l)) + 1e-9
wet_r /= np.max(np.abs(wet_r)) + 1e-9
dry = max(np.max(np.abs(left)), np.max(np.abs(right)))
mix_l = left / dry * 0.75 + wet_l * 0.45
mix_r = right / dry * 0.75 + wet_r * 0.45

# Master: fade in, fade out, gentle soft clip, normalize.
master = np.minimum(1, t / 2.5) * np.minimum(1, (TOTAL - t) / 3.0)
mix_l *= master
mix_r *= master
peak = max(np.max(np.abs(mix_l)), np.max(np.abs(mix_r)))
mix_l = np.tanh(mix_l / peak * 1.1) * 0.8
mix_r = np.tanh(mix_r / peak * 1.1) * 0.8
stereo = np.stack([mix_l, mix_r], axis=1)
with wave.open(str(OUT), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype("<i2").tobytes())
print("music ok", OUT)

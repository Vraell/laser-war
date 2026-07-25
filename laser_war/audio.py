from __future__ import annotations

import random
from array import array
from math import pi, sin

import pygame

SAMPLE_RATE = 44_100


class AudioBank:
    def __init__(self) -> None:
        """Build the synthesized sound bank when an audio device is available."""
        self.enabled = True
        self.available = pygame.mixer.get_init() is not None
        self.sounds: dict[str, pygame.mixer.Sound] = {}
        if not self.available:
            return
        self.sounds = {
            "place": self._tone(520, 0.08, 0.20),
            "laser": self._sweep(180, 620, 0.42, 0.18),
            "impact": self._noise(0.18, 0.25),
            "victory": self._chord((392, 494, 659), 0.65, 0.18),
            "undo": self._sweep(420, 220, 0.16, 0.14),
        }

    def play(self, name: str) -> None:
        """Play a named effect when sound output is enabled."""
        if self.enabled and self.available and name in self.sounds:
            self.sounds[name].play()

    def toggle(self) -> None:
        self.enabled = not self.enabled

    def _sound(self, samples: list[float]) -> pygame.mixer.Sound:
        """Convert normalized floating-point samples into a Pygame sound."""
        pcm = array("h", (max(-32767, min(32767, int(sample * 32767))) for sample in samples))
        return pygame.mixer.Sound(buffer=pcm.tobytes())

    def _tone(self, frequency: float, duration: float, volume: float) -> pygame.mixer.Sound:
        """Synthesize a decaying sine tone."""
        count = int(SAMPLE_RATE * duration)
        samples = [
            sin(2 * pi * frequency * index / SAMPLE_RATE) * volume * (1 - index / count) for index in range(count)
        ]
        return self._sound(samples)

    def _sweep(self, start: float, end: float, duration: float, volume: float) -> pygame.mixer.Sound:
        """Synthesize a frequency sweep with a smooth amplitude envelope."""
        count = int(SAMPLE_RATE * duration)
        phase = 0.0
        samples = []
        for index in range(count):
            progress = index / count
            frequency = start + (end - start) * progress
            phase += 2 * pi * frequency / SAMPLE_RATE
            envelope = sin(pi * progress) ** 0.5
            samples.append(sin(phase) * volume * envelope)
        return self._sound(samples)

    def _noise(self, duration: float, volume: float) -> pygame.mixer.Sound:
        """Synthesize deterministic decaying noise for impact feedback."""
        generator = random.Random(7)
        count = int(SAMPLE_RATE * duration)
        samples = [generator.uniform(-1, 1) * volume * (1 - index / count) ** 2 for index in range(count)]
        return self._sound(samples)

    def _chord(self, frequencies: tuple[float, ...], duration: float, volume: float) -> pygame.mixer.Sound:
        """Synthesize an enveloped chord from the supplied frequencies."""
        count = int(SAMPLE_RATE * duration)
        samples = []
        for index in range(count):
            progress = index / count
            wave = sum(sin(2 * pi * frequency * index / SAMPLE_RATE) for frequency in frequencies)
            samples.append(wave / len(frequencies) * volume * sin(pi * progress))
        return self._sound(samples)

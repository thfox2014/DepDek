#!/usr/bin/env python3
"""Read one bounded PCM WAV from stdin and print only the recognized text."""

import json
import sys
import wave

from vosk import KaldiRecognizer, Model


def main() -> int:
    if len(sys.argv) != 2:
        print("expected one model directory", file=sys.stderr)
        return 2
    with wave.open(sys.stdin.buffer, "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
            print("unsupported audio format", file=sys.stderr)
            return 2
        recognizer = KaldiRecognizer(Model(sys.argv[1]), 16000)
        parts = []
        while True:
            frames = audio.readframes(4000)
            if not frames:
                break
            if recognizer.AcceptWaveform(frames):
                parts.append(json.loads(recognizer.Result()).get("text", ""))
        parts.append(json.loads(recognizer.FinalResult()).get("text", ""))
    print(" ".join(part for part in parts if part))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

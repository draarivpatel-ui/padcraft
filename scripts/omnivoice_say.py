#!/usr/bin/env python3
"""Aariv's cloned voice with OmniVoice (local, Apple Silicon, mlx-audio).

Batch TTS for this repo's demo pipeline. Replaces macOS `say`. The reference
clip is voice-ref.wav plus its exact words in voice-ref.txt (chosen 2026-11-01
over Chatterbox). Seed 1 tested clean; if a line sounds off, retake it by
editing that unit's "seed" in the job file (2 or 3).

    nice -n 15 ~/mlx-audio-venv/bin/python scripts/omnivoice_say.py job.json

job.json: {"seed": 1, "units": [{"id": "s0-0", "text": "...", "out": "/abs/x.wav",
"seed": 2}]}. Each unit writes `out` at the model's native sample rate (the
caller normalizes to 24 kHz mono). Writes <job>.report.json next to the job
file with durations, rms and seconds-per-word outlier flags. The model loads
once per invocation, so keep the whole job in one file.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

REF = Path.home() / "Hub/personal/DDC Portfolio - Aariv Patel/Club Materials/Video/voice-ref.wav"
REF_TEXT = REF.with_name("voice-ref.txt").read_text().strip()
MODEL = "mlx-community/OmniVoice-bf16"


def main():
    job_path = Path(sys.argv[1]).resolve()
    job = json.loads(job_path.read_text())
    seed_default = int(job.get("seed", 1))

    from mlx_audio.tts.utils import load_model
    import mlx.core as mx

    t0 = time.time()
    model = load_model(MODEL)
    sr = model.sample_rate
    print(f"model loaded in {time.time() - t0:.1f}s, sr={sr}", flush=True)

    report = {"model": MODEL, "seed": seed_default, "sr": sr, "units": []}
    for u in job["units"]:
        out = Path(u["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        seed = int(u.get("seed", seed_default))
        ts = time.time()
        mx.random.seed(seed)
        parts = model.generate(text=u["text"], ref_audio=str(REF), ref_text=REF_TEXT, language="english")
        audio = np.concatenate([np.array(r.audio) for r in parts]).astype(np.float32)
        sf.write(str(out), audio, sr)
        dur = len(audio) / sr
        rms = float(np.sqrt(np.mean(audio**2) + 1e-12))
        rec = {"id": u["id"], "text": u["text"], "seed": seed, "dur": round(dur, 4),
               "words": len(u["text"].split()), "rms": round(rms, 5), "sec": round(time.time() - ts, 2)}
        report["units"].append(rec)
        print(f'{u["id"]} seed={seed} {dur:5.2f}s rms={rms:.4f} in {time.time() - ts:4.1f}s  {u["text"][:55]}', flush=True)

    durs = [x["dur"] / max(1, x["words"]) for x in report["units"]]
    if durs:
        med = float(np.median(durs))
        report["median_s_per_word"] = round(med, 4)
        for x in report["units"]:
            ratio = x["dur"] / max(1, x["words"])
            if ratio > med * 2.5 or ratio < med * 0.4 or x["rms"] < 0.003:
                x["outlier"] = True
                print(f'OUTLIER {x["id"]}: {ratio:.2f}s/word vs median {med:.2f}, rms={x["rms"]}', flush=True)
    job_path.with_suffix(".report.json").write_text(json.dumps(report, indent=1))
    print(f"report -> {job_path.with_suffix('.report.json')}", flush=True)


if __name__ == "__main__":
    main()

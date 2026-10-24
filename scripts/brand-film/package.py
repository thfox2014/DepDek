#!/usr/bin/env python3
"""Decode-check and package declared, non-private brand-film deliverables."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
import zipfile

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]

parser = argparse.ArgumentParser()
parser.add_argument("--ffmpeg", required=True)
args = parser.parse_args()
out = REPO / "os/artifacts/jiaho-brand-film-20261019"
timeline = json.loads((out/"timeline.json").read_text())
movie = out/"Jiaho-家合-东西有归处-品牌片-v1.mp4"
assert len(timeline["scenes"]) == 16, "Wait until the final 16-scene render is complete"
assert hashlib.sha256(movie.read_bytes()).hexdigest() == timeline["sha256"]
decoded = subprocess.run([args.ffmpeg,"-hide_banner","-i",str(movie),"-vf","blackdetect=d=0.8:pix_th=0.025","-af","volumedetect","-f","null","-"],capture_output=True,text=True)
(out/"render/decode-validation.log").write_text(decoded.stderr)
assert decoded.returncode == 0, "Full video/audio decode failed"
assert "1920x1080" in decoded.stderr and "Audio: aac" in decoded.stderr
duration = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", decoded.stderr)
actual = int(duration[1])*3600+int(duration[2])*60+float(duration[3])
assert abs(actual-timeline["duration"]) < .3, "Unexpected master duration"
black = [float(value) for value in re.findall(r"black_duration:([\d.]+)",decoded.stderr)]
assert not any(value>1 for value in black), "Unexpected blank/black scene"

# Inspect actual encoded midpoints, not only the source PNGs.
sheet = Image.new("RGB",(1280,4*205),"#fff9ee")
face = ImageFont.truetype("/System/Library/Fonts/Avenir Next.ttc",16)
for index,scene in enumerate(timeline["scenes"]):
    timestamp=scene["start"]+scene["duration"]/2
    frame=out/"render"/(scene["id"]+"-encoded.jpg")
    result=subprocess.run([args.ffmpeg,"-hide_banner","-loglevel","error","-y","-ss",str(timestamp),"-i",str(movie),"-frames:v","1","-q:v","2",str(frame)],capture_output=True,text=True)
    assert result.returncode==0 and frame.exists()
    tile=Image.open(frame).resize((320,180),Image.Resampling.LANCZOS)
    x,y=index%4*320,index//4*205
    sheet.paste(tile,(x,y))
    ImageDraw.Draw(sheet).text((x+8,y+183),f"{timestamp:.1f}s / {scene['id']}",font=face,fill="#153d35")
sheet.save(out/"encoded-review.jpg",quality=94)

inputs=[REPO/"src/assets/jiaho-boot-logo.png",REPO/"scripts/fixtures/treasure-assets/sea-child.png",*sorted((out/"screens").glob("*.png"))]
manifest=[{"source":str(path.relative_to(REPO)),"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"bytes":path.stat().st_size} for path in inputs]
(out/"asset-manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
report={"video":movie.name,"duration_seconds":actual,"resolution":"1920x1080","fps":25,"scenes":len(timeline["scenes"]),"video_audio_decode":"passed","unexpected_black_intervals":black,"max_volume":re.findall(r"max_volume: ([-\d.]+ dB)",decoded.stderr),"sha256":timeline["sha256"],"cloud_api":"NOT CALLED: missing opened-service credentials and spending approval","visual_review":"See encoded-review.jpg; screenshot data are synthetic, future scene marked","voice":"local synthetic scratch voice, not a human actor"}
(out/"validation.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")

deliverables=[movie,out/"poster.jpg",out/"contact-sheet.jpg",out/"encoded-review.jpg",out/"旁白字幕.srt",out/"timeline.json",out/"validation.json",out/"asset-manifest.json"]
with zipfile.ZipFile(out/"Jiaho-品牌片-v1-制作素材包.zip","w",compression=zipfile.ZIP_DEFLATED) as bundle:
    for path in deliverables:
        bundle.write(path,path.name)
    for path in sorted((out/"screens").glob("*.png")):
        bundle.write(path,"screens/"+path.name)
    for name in ["README.md","scenes.json","xiaoyunque-opening-prompt.txt"]:
        bundle.write(Path(__file__).with_name(name),"production/"+name)
print(json.dumps(report,ensure_ascii=False,indent=2))

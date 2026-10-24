#!/usr/bin/env python3
"""Local brand-film compositor. Reads only declared brand/demo assets and shots.

No Home scan, models, credentials, public upload, or third-party music.
Requires Pillow/numpy, ffmpeg, and macOS Tingting for the local scratch voice.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
from pathlib import Path
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

REPO = Path(__file__).resolve().parents[2]
W, H, FPS = 1920, 1080, 25
CREAM = "#fff9ee"
INK = "#153d35"
GREEN = "#00b88a"
ORANGE = "#ff8429"
MUTED = "#667b6d"
FONT = "/System/Library/Fonts/STHeiti Medium.ttc"
LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"
EN = "/System/Library/Fonts/Avenir Next.ttc"
PHOTO = REPO / "scripts/fixtures/treasure-assets/sea-child.png"
LOGO = REPO / "src/assets/jiaho-boot-logo.png"


def run(args, log=None):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if log:
        Path(log).write_text(result.stderr, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"{Path(str(args[0])).name} failed: {result.stderr[-1400:]}")
    return result


def font(size, light=False, english=False):
    return ImageFont.truetype(EN if english else LIGHT if light else FONT, size)


def wrap(text, face, width):
    lines, line = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(line)
            line = ""
        elif face.getlength(line + ch) > width and line:
            lines.append(line)
            line = ch
        else:
            line += ch
    if line:
        lines.append(line)
    return lines


def text(draw, value, xy, size, fill=INK, width=None, line_height=None, light=False, english=False):
    face = font(size, light, english)
    lines = wrap(value, face, width) if width else value.split("\n")
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=face, fill=fill)
        y += line_height or round(size * 1.45)
    return y


def fitted(draw, value, xy, size, fill, width, max_lines=4):
    while size > 30 and len(wrap(value, font(size), width)) > max_lines:
        size -= 2
    return text(draw, value, xy, size, fill, width, round(size * 1.35))


def bg(dark=False):
    base = Image.new("RGB", (W, H), INK if dark else CREAM)
    # Broad paper-light variation, not UI decoration or a redrawn logo.
    light = Image.new("RGBA", (W, H))
    draw = ImageDraw.Draw(light)
    if not dark:
        draw.ellipse((-500, -850, 1000, 500), fill=(255, 132, 41, 13))
        draw.ellipse((1500, 600, 2500, 1600), fill=(0, 184, 138, 12))
    return Image.alpha_composite(base.convert("RGBA"), light).convert("RGB")


def screenshot_card(canvas, path, rect, crop_banner=True):
    image = Image.open(path).convert("RGB")
    if crop_banner:
        image = image.crop((0, 26, image.width, image.height))
    x, y, width, height = map(int, rect)
    contained = ImageOps.contain(image, (width, height), Image.Resampling.LANCZOS)
    px, py = x + (width - contained.width) // 2, y + (height - contained.height) // 2
    shadow = Image.new("RGBA", canvas.size)
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((px - 3, py + 15, px + contained.width + 3, py + contained.height + 17), 18, fill=(10, 39, 29, 40))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB"))
    mask = Image.new("L", contained.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, contained.width - 1, contained.height - 1), 14, fill=255)
    canvas.paste(contained, (px, py), mask)
    ImageDraw.Draw(canvas).rounded_rectangle((px, py, px + contained.width, py + contained.height), 14, outline="#dce4d8", width=1)


def footer(canvas, scene, dark):
    draw = ImageDraw.Draw(canvas)
    white = "#fff9ee" if dark else INK
    lines = wrap(scene["voice"], font(30, light=True), 1640)
    if len(lines) > 2:
        raise ValueError(f"Caption overflows in {scene['id']}")
    y = 945 if len(lines) == 2 else 968
    for line in lines:
        length = font(30, light=True).getlength(line)
        draw.text(((W - length) / 2, y), line, font=font(30, light=True), fill=white)
        y += 40
    note = scene["note"]
    if font(20, light=True).getlength(note) > 1710:
        raise ValueError(f"Disclosure overflows in {scene['id']}")
    text(draw, note, (96, 1032), 20, "#c0d2c5" if dark else MUTED, light=True)


def render_plate(scene, out):
    kind = scene["kind"]
    dark = kind in {"opening", "photo", "vision"}
    canvas = bg(dark)
    draw = ImageDraw.Draw(canvas)
    fg = "#fff9ee" if dark else INK
    if kind in {"opening", "photo"}:
        full = ImageOps.fit(Image.open(PHOTO).convert("RGB"), (W, H), Image.Resampling.LANCZOS, centering=(.55, .42))
        xs = np.linspace(0, 1, W)
        alpha = np.clip(225 - xs * 100, 110, 225).astype(np.uint8)
        overlay = Image.new("RGBA", (W, H), (9, 33, 28))
        overlay.putalpha(Image.fromarray(np.repeat(alpha[None, :], H, axis=0)))
        canvas = Image.alpha_composite(full.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(canvas)
    text(draw, "JIAHO / HOME AI HUB", (96, 48), 25, "#e0e8d9" if dark else MUTED, english=True)
    text(draw, f"{scene.get('number',int(scene['id'][:2])):02d} / {scene.get('count',15)}", (1725, 48), 23, "#e0e8d9" if dark else MUTED, english=True)
    text(draw, scene["chapter"], (96, 117), 24, ORANGE)

    if kind in {"brand", "end"}:
        mark = Image.open(LOGO).convert("RGB").resize((650, 650), Image.Resampling.LANCZOS)
        canvas.paste(mark, (100, 190))
        draw = ImageDraw.Draw(canvas)
        fitted(draw, scene["title"], (850, 285 if kind == "end" else 330), 78, INK, 940)
        text(draw, scene["sub"], (855, 725 if kind == "end" else 675), 29, MUTED)
        draw.line((855, 810, 970, 810), fill=ORANGE, width=5)
    elif kind == "opening":
        text(draw, scene["title"], (96, 330), 96, fg, line_height=135)
        text(draw, scene["sub"], (103, 675), 32, "#e7ece1", width=1050, light=True)
    elif kind == "duo":
        fitted(draw, scene["title"], (96, 280), 76, fg, 520)
        text(draw, scene["sub"], (100, 620), 28, MUTED, width=470, light=True)
        screenshot_card(canvas, out / "screens" / scene["screens"][0], (680, 200, 1060, 520))
        screenshot_card(canvas, out / "screens" / scene["screens"][1], (830, 465, 1030, 470))
    elif kind in {"split", "photo", "vision"}:
        fitted(draw, scene["title"], (96, 300), 72, fg, 530)
        text(draw, scene["sub"], (102, 650), 28, "#d0dfd0" if dark else MUTED, width=450, light=True)
        draw.line((102, 810, 200, 810), fill=ORANGE, width=5)
        screenshot_card(canvas, out / "screens" / scene["screens"][0], (640, 190, 1200, 720))
        if kind == "vision":
            draw = ImageDraw.Draw(canvas)
            draw.rounded_rectangle((96, 195, 410, 245), 6, fill=ORANGE)
            text(draw, "产品愿景 · 非当前承诺", (112, 205), 23, INK)
    else:
        fitted(draw, scene["title"], (96, 165), 67, fg, 1710, 1)
        text(draw, scene["sub"], (100, 260), 26, MUTED, light=True)
        screenshot_card(canvas, out / "screens" / scene["screens"][0], (170, 325, 1580, 590))
        if len(scene.get("screens", [])) > 1:
            screenshot_card(canvas, out / "screens" / scene["screens"][1], (1370, 535, 470, 280))
    footer(canvas, scene, dark)
    target = out / "render" / (scene["id"] + ".png")
    canvas.save(target)
    return target


def voice(scene, out, ffmpeg, reuse=False):
    stem = out / "render" / scene["id"]
    spoken = stem.with_suffix(".txt")
    cached = reuse and spoken.exists() and spoken.read_text(encoding="utf-8") == scene["voice"] and stem.with_suffix(".wav").exists()
    if not cached:
        spoken.write_text(scene["voice"], encoding="utf-8")
        run(["/usr/bin/say", "-v", "Tingting", "-r", "195", "-f", spoken, "-o", stem.with_suffix(".aiff")])
        run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", stem.with_suffix(".aiff"), "-ar", "48000", "-ac", "1", "-af", "loudnorm=I=-18:TP=-2:LRA=7", stem.with_suffix(".wav")])
    with wave.open(str(stem.with_suffix(".wav"))) as audio:
        duration = audio.getnframes() / audio.getframerate()
    scene["voice_seconds"] = round(duration, 3)
    scene["duration"] = math.ceil(max(scene["seconds"], duration + 1.4) * FPS) / FPS
    return scene


def encode(scene, out, ffmpeg):
    stem = out / "render" / scene["id"]
    length = scene["duration"]
    color = "0x153d35" if scene["kind"] in {"opening", "photo", "vision"} else "0xfff9ee"
    vf = f"zoompan=z='min(1.018,1+on*0.00005)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={W}x{H}:fps={FPS},fade=t=in:st=0:d=0.5:color={color},fade=t=out:st={length-.5:.3f}:d=0.5:color={color},format=yuv420p"
    run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", str(FPS), "-i", stem.with_suffix(".png"), "-i", stem.with_suffix(".wav"), "-vf", vf, "-af", f"adelay=500:all=1,apad,atrim=duration={length}", "-t", str(length), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", "2", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", stem.with_suffix(".mp4")], stem.with_suffix(".log"))
    print(f"Rendered {scene['id']} ({length:.2f}s)", flush=True)


def score(duration, target):
    """Original deterministic sparse piano-like score. No sampled recordings."""
    rate = 44100
    n = math.ceil(duration * rate)
    signal = np.zeros(n, dtype=np.float64)
    chords = [[48, 55, 59, 62, 64], [45, 52, 55, 59, 60], [41, 48, 52, 55, 57], [43, 50, 55, 57, 62]]
    for bar in range(math.ceil(duration / 8)):
        chord = chords[bar % len(chords)]
        for step in range(8):
            start = bar * 8 + step * .9
            index = int(start * rate)
            if index >= n:
                continue
            t = np.arange(min(int(3.3 * rate), n-index)) / rate
            midi = chord[step % len(chord)] + (12 if step % 3 else 0)
            frequency = 440 * 2 ** ((midi - 69) / 12)
            envelope = (1 - np.exp(-t * 80)) * np.exp(-t * 1.4)
            note = (np.sin(2*np.pi*frequency*t) + .22*np.sin(2*np.pi*frequency*2*t) + .06*np.sin(2*np.pi*frequency*3*t)) * envelope
            signal[index:index+len(t)] += .06 * note
    time = np.arange(n) / rate
    signal *= np.minimum(1, time/3) * np.minimum(1, (duration-time)/5)
    stereo = np.stack([signal, np.roll(signal, int(rate*.019))*.92], axis=1)
    pcm = (np.clip(stereo, -1, 1)*32767).astype("<i2")
    with wave.open(str(target), "wb") as wav:
        wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(rate); wav.writeframes(pcm.tobytes())


def timecode(seconds):
    ms = round(seconds * 1000)
    return f"{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}"


def contact_sheet(scenes, out):
    sheet = Image.new("RGB", (1440, math.ceil(len(scenes)/3)*300), CREAM)
    draw = ImageDraw.Draw(sheet)
    for i, scene in enumerate(scenes):
        x, y = i%3*480, i//3*300
        image = Image.open(out/"render"/(scene["id"]+".png")).resize((480,270),Image.Resampling.LANCZOS)
        sheet.paste(image,(x,y))
        draw.text((x+10,y+274),scene["id"],font=font(17,english=True),fill=INK)
    sheet.save(out/"contact-sheet.jpg",quality=92)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--out", type=Path, default=REPO/"os/artifacts/jiaho-brand-film-20261019")
    parser.add_argument("--frames-only", action="store_true")
    parser.add_argument("--reuse-audio", action="store_true")
    args = parser.parse_args()
    out = args.out.resolve()
    (out/"render").mkdir(parents=True,exist_ok=True)
    scenes = json.loads(Path(__file__).with_name("scenes.json").read_text())
    for i,scene in enumerate(scenes,1):
        scene["number"],scene["count"]=i,len(scenes)
        render_plate(scene, out)
    contact_sheet(scenes,out)
    Image.open(out/"render/15-end.png").save(out/"poster.jpg",quality=95)
    if args.frames_only:
        print(out/"contact-sheet.jpg")
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        scenes = list(pool.map(lambda scene: voice(scene,out,args.ffmpeg,args.reuse_audio),scenes))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda scene: encode(scene,out,args.ffmpeg),scenes))
    concat = out/"render/concat.txt"
    concat.write_text("\n".join(f"file '{scene['id']}.mp4'" for scene in scenes)+"\n")
    picture = out/"render/picture.mp4"
    run([args.ffmpeg,"-hide_banner","-loglevel","error","-y","-f","concat","-safe","0","-i",concat,"-c","copy",picture])
    duration=sum(scene["duration"] for scene in scenes)
    music=out/"render/original-music.wav"
    score(duration,music)
    final=out/"Jiaho-家合-东西有归处-品牌片-v1.mp4"
    run([args.ffmpeg,"-hide_banner","-loglevel","error","-y","-i",picture,"-i",music,"-filter_complex","[0:a]volume=1.0[voice];[1:a]volume=0.55[music];[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.92[audio]","-map","0:v","-map","[audio]","-c:v","copy","-c:a","aac","-b:a","192k","-t",str(duration),"-movflags","+faststart",final])
    cursor=0.; subtitles=[]
    for i,scene in enumerate(scenes,1):
        scene["start"]=round(cursor,3)
        subtitles.append(f"{i}\n{timecode(cursor+.5)} --> {timecode(cursor+.5+scene['voice_seconds'])}\n{scene['voice']}\n")
        cursor+=scene["duration"]
    (out/"旁白字幕.srt").write_text("\n".join(subtitles),encoding="utf-8")
    (out/"timeline.json").write_text(json.dumps({"width":W,"height":H,"fps":FPS,"duration":duration,"scenes":scenes,"audio":"macOS Tingting scratch narration + original synthesized score","cloud_generation":{"provider":"Xiaoyunque official API","status":"not_called_missing_credentials"},"sha256":hashlib.sha256(final.read_bytes()).hexdigest()},ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"video":str(final),"seconds":duration,"size_mb":round(final.stat().st_size/1024**2,1)},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()

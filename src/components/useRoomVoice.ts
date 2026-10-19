import { useEffect, useRef, useState } from "react";
import { voiceTranscribe } from "../api";

function encodeWav(samples: Float32Array, rate: number): string {
  const target = 16_000, count = Math.floor(samples.length * target / rate);
  const bytes = new Uint8Array(44 + count * 2), view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, target, true); view.setUint32(28, target * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const at = i * rate / target, left = Math.floor(at), fraction = at - left;
    const a = samples[Math.min(left, samples.length - 1)] ?? 0, b = samples[Math.min(left + 1, samples.length - 1)] ?? a;
    const value = Math.max(-1, Math.min(1, a + (b - a) * fraction));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Local Vosk only; keep the originating Agent when the user switches tabs. */
export default function useRoomVoice(agentId: string, onTranscript: (id: string, text: string) => void, onError: (message: string) => void) {
  const [recording, setRecording] = useState(false), [transcribing, setTranscribing] = useState(false);
  const context = useRef<AudioContext | null>(null), stream = useRef<MediaStream | null>(null), processor = useRef<ScriptProcessorNode | null>(null);
  const chunks = useRef<Float32Array[]>([]), active = useRef(false), target = useRef(agentId), timer = useRef<number>();
  const starting = useRef(false), processing = useRef(false), generation = useRef(0), mounted = useRef(true);
  const callbacks = useRef({ onTranscript, onError }); callbacks.current = { onTranscript, onError };
  const stop = async () => {
    if (!active.current) return;
    active.current = false; processing.current = true; setTranscribing(true); clearTimeout(timer.current);
    const audio = context.current, rate = audio?.sampleRate ?? 16_000, collected = chunks.current, owner = target.current;
    context.current = null;
    chunks.current = []; processor.current?.disconnect(); stream.current?.getTracks().forEach((track) => track.stop());
    setRecording(false); await audio?.close().catch(() => {});
    const length = collected.reduce((count, item) => count + item.length, 0);
    if (!length) { processing.current = false; if (mounted.current) { setTranscribing(false); callbacks.current.onError("没有收到录音，请检查麦克风后重试。"); } return; }
    const samples = new Float32Array(length); let offset = 0;
    for (const item of collected) { samples.set(item, offset); offset += item.length; }
    try {
      const transcript = await voiceTranscribe(encodeWav(samples, rate));
      if (!mounted.current) return;
      if (transcript.trim()) callbacks.current.onTranscript(owner, transcript);
      else callbacks.current.onError("没有听清，请再说一次。");
    } catch { if (mounted.current) callbacks.current.onError("本机语音识别暂不可用，请使用键盘输入。"); }
    finally { processing.current = false; if (mounted.current) setTranscribing(false); }
  };
  const start = async () => {
    if (active.current || starting.current || processing.current) return;
    if (!("__TAURI_INTERNALS__" in window)) { callbacks.current.onError("浏览器预览不录音，请在 AI-OS 内使用本机语音识别。"); return; }
    target.current = agentId;
    starting.current = true; const request = generation.current;
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (!mounted.current || request !== generation.current) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream.current = acquired;
      const audio = new AudioContext({ sampleRate: 16_000 }); context.current = audio;
      const source = audio.createMediaStreamSource(stream.current), proc = audio.createScriptProcessor(4096, 1, 1), silent = audio.createGain();
      silent.gain.value = 0; chunks.current = [];
      proc.onaudioprocess = (event) => { if (active.current) chunks.current.push(new Float32Array(event.inputBuffer.getChannelData(0))); event.outputBuffer.getChannelData(0).fill(0); };
      source.connect(proc); proc.connect(silent); silent.connect(audio.destination);
      processor.current = proc; active.current = true; setRecording(true);
      timer.current = window.setTimeout(() => void stop(), 30_000);
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop()); void context.current?.close();
      if (mounted.current) callbacks.current.onError("无法启动麦克风，请检查权限，或直接输入文字。");
    } finally { starting.current = false; }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; active.current = false; clearTimeout(timer.current); processor.current?.disconnect(); stream.current?.getTracks().forEach((track) => track.stop()); void context.current?.close(); }; }, []);
  return { recording, transcribing, start, stop };
}

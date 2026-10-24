import { useCallback, useEffect, useRef, useState } from "react";

interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;
type VoiceWindow = Window & {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
};

export function useVoice(
  demo: boolean,
  onTranscript: (text: string) => void,
  onError: (text: string) => void,
) {
  const [status, setStatus] = useState<"idle" | "listening">("idle");
  const revision = useRef(0),
    engine = useRef<Recognition | null>(null),
    timer = useRef<ReturnType<typeof setTimeout>>();
  const callbacks = useRef({ onTranscript, onError });
  callbacks.current = { onTranscript, onError };
  const cancel = useCallback(() => {
    revision.current++;
    engine.current?.abort();
    engine.current = null;
    globalThis.clearTimeout(timer.current);
    setStatus("idle");
  }, []);
  const start = useCallback(() => {
    if (engine.current || status === "listening") return;
    const generation = ++revision.current;
    if (demo) {
      setStatus("listening");
      timer.current = globalThis.setTimeout(() => {
        if (generation !== revision.current) return;
        setStatus("idle");
        callbacks.current.onTranscript("帮我准备洗衣机维修资料");
      }, 1600);
      return;
    }
    const Constructor =
      (window as VoiceWindow).SpeechRecognition ||
      (window as VoiceWindow).webkitSpeechRecognition;
    if (!window.isSecureContext || !Constructor) {
      callbacks.current.onError(
        "当前浏览器不能使用语音识别，请用键盘输入。手机语音还需要受支持的浏览器与 HTTPS。",
      );
      return;
    }
    const recognition = new Constructor();
    engine.current = recognition;
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    let delivered = false;
    recognition.onresult = (event) => {
      if (generation !== revision.current || delivered) return;
      let text = "";
      for (let i = 0; i < event.results.length; i++)
        text += event.results[i][0]?.transcript || "";
      if (text.trim()) {
        delivered = true;
        callbacks.current.onTranscript(text.trim());
      }
    };
    recognition.onerror = () => {
      if (generation === revision.current) {
        revision.current++;
        globalThis.clearTimeout(timer.current);
        engine.current = null;
        setStatus("idle");
        recognition.abort();
        callbacks.current.onError(
          "没有完成语音识别，请检查麦克风权限，或直接输入。",
        );
      }
    };
    recognition.onend = () => {
      if (generation !== revision.current) return;
      globalThis.clearTimeout(timer.current);
      engine.current = null;
      setStatus("idle");
    };
    try {
      recognition.start();
      setStatus("listening");
      timer.current = globalThis.setTimeout(() => recognition.stop(), 25000);
    } catch {
      engine.current = null;
      callbacks.current.onError("无法启动语音，请使用键盘输入。");
    }
  }, [demo, status]);
  useEffect(
    () => () => {
      revision.current++;
      engine.current?.abort();
      globalThis.clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    const hide = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [cancel]);
  return { status, start, cancel };
}

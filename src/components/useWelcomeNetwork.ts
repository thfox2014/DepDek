import { useEffect, useRef, useState } from "react";
import type { AiOsNetworkStatus } from "../api";

export interface WelcomeNetworkServices {
  aiOsNetworkStatus(): Promise<AiOsNetworkStatus>;
  aiOsOpenNetworkSettings(): Promise<void>;
}

/** Network onboarding is deliberately independent of business authentication. */
export function useWelcomeNetwork(services: WelcomeNetworkServices, enabled: boolean) {
  const [network, setNetwork] = useState<AiOsNetworkStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const autoOpened = useRef(false);
  const settingsBusy = useRef(false);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    if (!enabled) return;
    const onReturn = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onReturn);
    window.addEventListener("online", onReturn);
    window.addEventListener("offline", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("online", onReturn);
      window.removeEventListener("offline", onReturn);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setBusy(true); setError("");
    void services.aiOsNetworkStatus().then(async (value) => {
      if (!active) return;
      setNetwork(value);
      if (value.connectivity !== "online" && value.settings_available && !autoOpened.current) {
        // One attempt per welcome mount, including failures. A focus event only rechecks.
        autoOpened.current = true;
        settingsBusy.current = true;
        try { await services.aiOsOpenNetworkSettings(); }
        catch { if (active) setError("未能打开 Wi-Fi 设置，请从操作系统设置中手动连接网络。"); }
        finally { settingsBusy.current = false; }
      }
    }).catch(() => {
      if (active) { setNetwork(null); setError("暂时无法检测网络。请检查 Wi-Fi 设置后重新检测。"); }
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [services, enabled, revision]);

  const openSettings = async () => {
    if (settingsBusy.current) return;
    autoOpened.current = true; settingsBusy.current = true; setError("");
    try { await services.aiOsOpenNetworkSettings(); }
    catch { setError("未能打开 Wi-Fi 设置，请从操作系统设置中手动连接网络。"); }
    finally { settingsBusy.current = false; }
  };
  return { network, busy, error, refresh, openSettings };
}

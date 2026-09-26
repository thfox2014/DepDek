import { useCallback, useEffect, useState } from "react";
import { api, demoMode, setCsrf, type SessionInfo } from "./api";
import Login from "./components/Login";
import DesktopShell from "./desktop/DesktopShell";

type Stage = "loading" | "login" | "desktop" | "error";

export default function App() {
  const [stage, setStage] = useState<Stage>("loading");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [version, setVersion] = useState("0.2.0");
  const [bootError, setBootError] = useState("");

  const applySession = useCallback((next: SessionInfo) => {
    setSession(next);
    setVersion(next.version);
    setCsrf(next.csrf);
    setStage(next.authenticated ? "desktop" : "login");
  }, []);

  useEffect(() => {
    let active = true;
    api
      .session()
      .then((next) => active && applySession(next))
      .catch((error: unknown) => {
        if (!active) return;
        setBootError(error instanceof Error ? error.message : String(error));
        setStage("error");
      });
    return () => {
      active = false;
    };
  }, [applySession]);

  const login = useCallback(
    async (password: string) => {
      const next = await api.login(password);
      applySession(next);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Even if the server call fails the local session is dropped.
    }
    setCsrf(null);
    setSession(null);
    setStage("login");
  }, []);

  if (stage === "loading") {
    return <div className="boot">正在连接 DepDek webdesk…</div>;
  }
  if (stage === "error") {
    return (
      <div className="boot boot--error">
        <b>无法连接控制台</b>
        <p>{bootError}</p>
        <button className="primary" onClick={() => window.location.reload()}>重试</button>
      </div>
    );
  }
  if (stage === "login" || !session) {
    return (
      <Login
        version={version}
        demo={demoMode}
        insecure={false}
        tls={false}
        onLogin={login}
        onAuthenticated={() => undefined}
      />
    );
  }
  return <DesktopShell session={session} demo={demoMode} onLogout={logout} />;
}

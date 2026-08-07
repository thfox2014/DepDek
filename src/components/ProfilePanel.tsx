import { useEffect, useState } from "react";
import * as api from "../api";

// Editor for <vault root>/profile.md. A missing file (E32002) is treated as
// an empty new document.
export default function ProfilePanel() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.vaultReadFile("profile.md");
        setContent(res.content);
      } catch (e) {
        if (!String(e).includes("E32002")) {
          setError(String(e));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.vaultWriteFile("profile.md", content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-panel">
      <p className="profile-panel__hint">agent 可通过审计接口读取此文件以了解你</p>
      {loading ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          <textarea
            className="profile-panel__editor"
            value={content}
            placeholder="写点什么介绍自己…"
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="profile-panel__actions">
            <button className="primary" disabled={saving} onClick={save}>
              保存
            </button>
            {saved && <span className="profile-panel__saved">已保存 ✓</span>}
          </div>
          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </div>
  );
}

import { X } from "@phosphor-icons/react";
import "./media-viewer.css";

interface Props {
  path: string | null;
  mime?: string;
  dataUrl?: string;
  loadingPath?: string | null;
  error?: string | null;
  onClose: () => void;
}

export default function MediaViewer({ path, mime, dataUrl, loadingPath, error, onClose }: Props) {
  if (!path && !loadingPath && !error) return null;
  const currentPath = path ?? loadingPath ?? "媒体播放器";
  return (
    <div className="dd-media-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dd-media-viewer" role="dialog" aria-modal="true" aria-label="媒体播放器">
        <header><div><b title={currentPath}>{currentPath}</b><small>本地 Vault · 文件不会上传</small></div><button onClick={onClose} aria-label="关闭媒体播放器"><X size={19} /></button></header>
        <div className="dd-media-stage">
          {loadingPath && <p className="dd-media-loading">正在通过本地 Vault 安全读取…</p>}
          {error && <p className="dd-media-error">无法打开媒体：{error}</p>}
          {dataUrl && mime?.startsWith("image/") && <img className="dd-media-image" src={dataUrl} alt={currentPath} />}
          {dataUrl && mime?.startsWith("audio/") && <audio className="dd-media-audio" controls autoPlay src={dataUrl} />}
          {dataUrl && mime?.startsWith("video/") && <video className="dd-media-video" controls autoPlay src={dataUrl} />}
          {dataUrl && !mime?.startsWith("image/") && !mime?.startsWith("audio/") && !mime?.startsWith("video/") && <p className="dd-media-error">暂不支持播放该文件格式（{mime}）</p>}
        </div>
      </section>
    </div>
  );
}

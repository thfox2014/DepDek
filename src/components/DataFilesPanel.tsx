import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  File,
  FileText,
  IdentificationCard,
  Image,
  ListBullets,
  SquaresFour,
  TreeStructure,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import * as api from "../api";
import ProfilePanel from "./ProfilePanel";
import FileTree, { type FileViewMode } from "./FileTree";

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"];
const VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];
const DOCUMENT_EXT = [
  "md",
  "mdx",
  "txt",
  "rtf",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "ppt",
  "pptx",
  "pages",
  "numbers",
  "key",
  "json",
  "yaml",
  "yml",
];

export type DataTab = "files" | "documents" | "images" | "videos" | "profile";

const DATA_TABS: { key: DataTab; label: string; icon: Icon }[] = [
  { key: "files", label: "文件", icon: File },
  { key: "documents", label: "文档", icon: FileText },
  { key: "images", label: "图片", icon: Image },
  { key: "videos", label: "视频", icon: VideoCamera },
  { key: "profile", label: "个人资料", icon: IdentificationCard },
];

const VIEW_MODES: { key: FileViewMode; label: string; icon: Icon }[] = [
  { key: "tree", label: "树状", icon: TreeStructure },
  { key: "list", label: "列表", icon: ListBullets },
  { key: "preview", label: "预览", icon: SquaresFour },
];

const INDEX_CATEGORIES: Record<DataTab, api.FileCategory | undefined> = {
  files: undefined,
  documents: "documents",
  images: "photos",
  videos: "videos",
  profile: undefined,
};

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const indexErrorMessage = (error: unknown) => {
  const message = String(error);
  if (message.includes("E32006") || message.toLowerCase().includes("auth")) return "请先完成 AI-OS 登录，再建立文件索引。";
  if (message.includes("E32603")) return "索引文件已被占用、损坏或权限不安全；原文件未被修改，请关闭其他 DepDek 进程后重试。";
  if (message.includes("E32003")) return "Home 文件数量或容量超过本次扫描上限，原文件未被修改。";
  return `建立文件索引失败：${message}`;
};

interface Props {
  variant?: "sidebar" | "page";
}

/** Shared data browser used by Agent Team and the Home 文件 module. */
export default function DataFilesPanel({ variant = "sidebar" }: Props) {
  const [tab, setTab] = useState<DataTab>("files");
  const [viewMode, setViewMode] = useState<FileViewMode>("list");
  const [indexSummary, setIndexSummary] = useState<api.FileIndexSummary | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexNotice, setIndexNotice] = useState("");
  const [indexNoticeOk, setIndexNoticeOk] = useState(false);
  const [indexRevision, setIndexRevision] = useState(0);

  useEffect(() => {
    if (variant !== "page" || !isTauri()) return;
    let active = true;
    void api.fileIndexQuery({ limit: 1 }).then((result) => {
      if (active) setIndexSummary(result.summary);
    }).catch((error) => {
      if (active) { setIndexNotice(indexErrorMessage(error)); setIndexNoticeOk(false); }
    });
    return () => { active = false; };
  }, [variant]);

  const refreshIndex = async () => {
    if (!isTauri()) {
      setIndexNotice("当前是浏览器布局预览，未连接本机 Vault；请在 DepDek 原生应用中建立文件索引。");
      return;
    }
    setIndexBusy(true);
    setIndexNotice("");
    setIndexNoticeOk(false);
    try {
      const summary = await api.fileIndexRefresh();
      setIndexSummary(summary);
      setIndexRevision((value) => value + 1);
      setIndexNotice(`索引已更新：${summary.total.toLocaleString()} 个文件，跳过 ${summary.skipped.toLocaleString()} 项。`);
      setIndexNoticeOk(true);
    } catch (error) {
      setIndexNotice(indexErrorMessage(error));
    } finally {
      setIndexBusy(false);
    }
  };

  const extensionFilter =
    tab === "documents"
      ? DOCUMENT_EXT
      : tab === "images"
        ? IMAGE_EXT
        : tab === "videos"
          ? VIDEO_EXT
          : undefined;

  return (
    <div className={`data-files-panel data-files-panel--${variant}`}>
      <div className="data-files-panel__tabs">
        {DATA_TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              className={`data-files-panel__tab ${tab === item.key ? "data-files-panel__tab--active" : ""}`}
              onClick={() => setTab(item.key)}
            >
              <Icon />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="data-files-panel__content">
        {tab === "profile" ? (
          <ProfilePanel />
        ) : (
          <>
            {variant === "page" && (
              <div className="data-files-panel__toolbar">
                <div>
                  <b>{DATA_TABS.find((item) => item.key === tab)?.label}</b>
                  <span>点击文件在右侧查看内容与来源信息</span>
                </div>
                <div className="data-files-panel__index-action">
                  <div className="data-files-panel__index-status">
                    {indexSummary?.indexed_at_ms ? <CheckCircle size={14} weight="fill" /> : <span className="data-files-panel__index-dot" />}
                    <span>{indexSummary?.indexed_at_ms ? `${indexSummary.total.toLocaleString()} 个文件已索引` : "索引尚未建立"}</span>
                  </div>
                  <button className="data-files-panel__index-button" onClick={() => void refreshIndex()} disabled={indexBusy}>
                    <ArrowClockwise size={14} className={indexBusy ? "data-files-panel__index-spin" : ""} />
                    {indexBusy ? "建立中…" : "建立文件索引"}
                  </button>
                </div>
                <div className="data-files-panel__views" role="group" aria-label="文件视图">
                  {VIEW_MODES.map((item) => {
                    const ViewIcon = item.icon;
                    return (
                      <button
                        key={item.key}
                        className={viewMode === item.key ? "data-files-panel__view--active" : ""}
                        onClick={() => setViewMode(item.key)}
                        title={`${item.label}视图`}
                        aria-pressed={viewMode === item.key}
                      >
                        <ViewIcon size={16} />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {variant === "page" && indexNotice && (
              <div className={`data-files-panel__index-notice ${indexNoticeOk ? "data-files-panel__index-notice--ok" : ""}`} role="status">
                {indexNoticeOk ? <CheckCircle size={14} /> : <WarningCircle size={14} />}
                <span>{indexNotice}</span>
              </div>
            )}
            <FileTree
              key={`${tab}:${indexRevision}`}
              extFilter={extensionFilter}
              flatFiles={tab === "documents" || tab === "images" || tab === "videos"}
              indexCategory={INDEX_CATEGORIES[tab]}
              useIndex={Boolean(indexSummary?.indexed_at_ms)}
              viewMode={variant === "page" ? viewMode : "tree"}
              variant={variant}
            />
          </>
        )}
      </div>
    </div>
  );
}

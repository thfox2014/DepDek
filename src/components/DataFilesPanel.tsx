import { useState } from "react";
import {
  File,
  FileText,
  IdentificationCard,
  Image,
  ListBullets,
  SquaresFour,
  TreeStructure,
  VideoCamera,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
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

interface Props {
  variant?: "sidebar" | "page";
}

/** Shared data browser used by Agent Team and the Home 文件 module. */
export default function DataFilesPanel({ variant = "sidebar" }: Props) {
  const [tab, setTab] = useState<DataTab>("files");
  const [viewMode, setViewMode] = useState<FileViewMode>("list");

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
            <FileTree
              key={tab}
              extFilter={extensionFilter}
              viewMode={variant === "page" ? viewMode : "tree"}
              variant={variant}
            />
          </>
        )}
      </div>
    </div>
  );
}

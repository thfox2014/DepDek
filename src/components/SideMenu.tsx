import { useState } from "react";
import type { ProviderConfig } from "../api";
import type { SessionInfo } from "../App";
import SessionList from "./SessionList";
import FileTree from "./FileTree";
import ProfilePanel from "./ProfilePanel";
import MailPanel from "./MailPanel";
import {
  IconChevron,
  IconDatabase,
  IconFile,
  IconIdCard,
  IconImage,
  IconMail,
  IconTeam,
  IconVideo,
} from "./icons";

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  providers: Record<string, ProviderConfig>;
  onSelect: (id: string) => void;
  onCreate: (label: string, providerName: string) => Promise<void>;
  onClose: (id: string) => void;
  onOpenSettings: () => void;
}

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"];
const VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

type DataTab = "files" | "images" | "videos" | "profile";

const DATA_TABS: { key: DataTab; label: string; icon: typeof IconFile }[] = [
  { key: "files", label: "文件", icon: IconFile },
  { key: "images", label: "图片", icon: IconImage },
  { key: "videos", label: "视频", icon: IconVideo },
  { key: "profile", label: "个人资料", icon: IconIdCard },
];

export default function SideMenu(props: Props) {
  const [teamOpen, setTeamOpen] = useState(true);
  const [mailOpen, setMailOpen] = useState(true);
  const [dataOpen, setDataOpen] = useState(true);
  const [tab, setTab] = useState<DataTab>("files");

  return (
    <div className="side-menu">
      <div className="side-menu__group">
        <button className="side-menu__group-header" onClick={() => setTeamOpen((v) => !v)}>
          <IconTeam />
          <span>Agent团队</span>
          <IconChevron
            className={`side-menu__chevron ${teamOpen ? "side-menu__chevron--open" : ""}`}
          />
        </button>
        {teamOpen && (
          <div className="side-menu__group-body side-menu__group-body--team">
            <SessionList
              sessions={props.sessions}
              activeId={props.activeId}
              providers={props.providers}
              onSelect={props.onSelect}
              onCreate={props.onCreate}
              onClose={props.onClose}
              onOpenSettings={props.onOpenSettings}
            />
          </div>
        )}
      </div>

      <div className="side-menu__group side-menu__group--grow">
        <button className="side-menu__group-header" onClick={() => setMailOpen((v) => !v)}>
          <IconMail />
          <span>我的邮件</span>
          <IconChevron
            className={`side-menu__chevron ${mailOpen ? "side-menu__chevron--open" : ""}`}
          />
        </button>
        {mailOpen && (
          <div className="side-menu__group-body side-menu__group-body--data">
            <MailPanel />
          </div>
        )}
      </div>

      <div className="side-menu__group side-menu__group--grow">
        <button className="side-menu__group-header" onClick={() => setDataOpen((v) => !v)}>
          <IconDatabase />
          <span>我的数据</span>
          <IconChevron
            className={`side-menu__chevron ${dataOpen ? "side-menu__chevron--open" : ""}`}
          />
        </button>
        {dataOpen && (
          <div className="side-menu__group-body side-menu__group-body--data">
            <div className="side-menu__tabs">
              {DATA_TABS.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.key}
                    className={`side-menu__tab ${tab === t.key ? "side-menu__tab--active" : ""}`}
                    onClick={() => setTab(t.key)}
                  >
                    <Icon />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="side-menu__content">
              {tab === "profile" ? (
                <ProfilePanel />
              ) : (
                // key forces a remount so the tree reloads with the new filter.
                <FileTree
                  key={tab}
                  extFilter={tab === "images" ? IMAGE_EXT : tab === "videos" ? VIDEO_EXT : undefined}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

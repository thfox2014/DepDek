import { useState } from "react";
import type { ProviderConfig } from "../api";
import type { SessionInfo } from "../App";
import SessionList from "./SessionList";
import DataFilesPanel from "./DataFilesPanel";
import {
  IconChevron,
  IconDatabase,
  IconTeam,
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

export default function SideMenu(props: Props) {
  const [teamOpen, setTeamOpen] = useState(true);
  const [dataOpen, setDataOpen] = useState(true);

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
        <button className="side-menu__group-header" onClick={() => setDataOpen((v) => !v)}>
          <IconDatabase />
          <span>我的数据</span>
          <IconChevron
            className={`side-menu__chevron ${dataOpen ? "side-menu__chevron--open" : ""}`}
          />
        </button>
        {dataOpen && (
          <div className="side-menu__group-body side-menu__group-body--data">
            <DataFilesPanel variant="sidebar" />
          </div>
        )}
      </div>
    </div>
  );
}

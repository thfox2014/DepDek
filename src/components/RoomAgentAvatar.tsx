import { FileText, FilmStrip, Headphones, HouseSimple, Images, Lightbulb } from "@phosphor-icons/react";
import { ROOM_AGENT_ID } from "../lib/aiOsRoom";
import { BUILTIN_AGENT_STORE } from "../lib/roomWorkspaces";
import WukongHead from "./WukongHead";

const icons = { documents: FileText, photos: Images, family: HouseSimple, music: Headphones, videos: FilmStrip, ideas: Lightbulb };
export default function RoomAgentAvatar({ id, name, busy = false }: { id: string; name: string; busy?: boolean }) {
  const item = BUILTIN_AGENT_STORE.find((entry) => entry.id === id);
  const Icon = item ? icons[item.icon] : undefined;
  return <span className={`room-agent-avatar${id === ROOM_AGENT_ID ? " is-wukong" : ""}`} aria-hidden="true">{id === ROOM_AGENT_ID ? <WukongHead busy={busy} /> : Icon ? <Icon weight="duotone" size={30} /> : <span>{Array.from(name).slice(0, 2).join("")}</span>}{busy && <i className="room-agent-avatar__busy" />}</span>;
}

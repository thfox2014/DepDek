import type { ReactNode } from "react";
import type { ChatBlock } from "../App";
import { splitPendingAsks } from "../agentVoice";
import MarkdownText from "./MarkdownText";
import ToolProcessPanel from "./ToolProcessPanel";

interface Props {
  blocks: ChatBlock[];
  agentLabel: string;
  running: boolean;
}

/** Grok-style thread: the person speaks in plain text, the user sits in a small bubble, and a confirmation is its own card. */
export default function AgentTranscript({ blocks, agentLabel, running }: Props) {
  const rendered: ReactNode[] = [];
  let tools: Extract<ChatBlock, { kind: "tool" }>[] = [];
  const flushTools = () => {
    if (tools.length) rendered.push(<ToolProcessPanel key={`tools-${tools[0].id}`} blocks={tools} />);
    tools = [];
  };
  const visibleTail = [...blocks].reverse().find((block) => !(block.kind === "status" && block.ephemeral));
  const streamingAnswer = running && visibleTail?.kind === "assistant";

  blocks.forEach((block) => {
    if (block.kind === "tool") {
      tools.push(block);
      return;
    }
    flushTools();
    if (block.kind === "status" && block.ephemeral) return;
    if (block.kind === "user") {
      rendered.push(<div key={block.id} className="agent-turn agent-turn--me">{block.text}</div>);
      return;
    }
    if (block.kind === "assistant") {
      const { body, asks } = splitPendingAsks(block.text);
      const live = streamingAnswer && block.id === visibleTail?.id;
      rendered.push(
        <article key={block.id} className={`agent-turn agent-turn--them${live ? " is-streaming" : ""}`}>
          <div className="agent-turn__name">{agentLabel}</div>
          {body ? <MarkdownText markdown={body} /> : live ? <span className="agent-turn__wait">在写</span> : null}
          {asks.map((ask, index) => (
            <div className="agent-ask" key={`${block.id}-ask-${index}`}>
              <span>待你确认</span>
              <p>{ask}</p>
            </div>
          ))}
        </article>,
      );
      return;
    }
    if (block.kind === "error") {
      rendered.push(<div key={block.id} className="agent-turn agent-turn--error">{block.message}</div>);
      return;
    }
    rendered.push(<div key={block.id} className="agent-turn agent-turn--note">{block.text}</div>);
  });
  flushTools();
  if (running && !streamingAnswer) {
    rendered.push(<div key="agent-live" className="agent-turn agent-turn--note">{agentLabel} 在想</div>);
  }
  return <>{rendered}</>;
}

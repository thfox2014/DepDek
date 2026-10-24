import {
  CheckCircle,
  Clock,
  WarningCircle,
  ArrowRight,
  Stop,
} from "@phosphor-icons/react";
import { taskLabel } from "../lib/store";
import type { Task } from "../lib/types";

export default function TaskCard({
  task,
  demo,
  onOpen,
  onCancel,
}: {
  task: Task;
  demo: boolean;
  onOpen: () => void;
  onCancel: () => void;
}) {
  return (
    <article className={`task-card status-${task.status}`}>
      <div className="task-top">
        <span className="task-glyph">
          {task.status === "done" ? (
            <CheckCircle size={23} />
          ) : ["waiting", "error", "unknown"].includes(task.status) ? (
            <WarningCircle size={23} />
          ) : (
            <Clock
              size={23}
              className={task.status === "running" ? "turning" : ""}
            />
          )}
        </span>
        <div>
          <h3>{task.title}</h3>
          <small>
            {taskLabel(task.status)}
            {demo ? " · 示例" : ""}
          </small>
        </div>
        {((demo && task.status === "running") || task.status === "queued") && (
          <button
            className="icon-button"
            aria-label={`停止${task.title}`}
            onClick={onCancel}
          >
            <Stop size={17} />
          </button>
        )}
      </div>
      <p>{task.phase}</p>
      {task.status === "running" && demo && (
        <div className="task-progress" aria-label={`当前演示阶段 ${task.step}`}>
          <span style={{ width: `${(Math.max(1, task.step) * 100) / 3}%` }} />
        </div>
      )}
      <button className="task-open" onClick={onOpen}>
        {task.status === "waiting" ? "核对一下" : "看看进展与结果"}
        <ArrowRight size={17} />
      </button>
    </article>
  );
}

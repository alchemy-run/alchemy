/**
 * The BOARD — the kanban view over the Registry: one column per task
 * status, a task card showing its entities, group, linked thread
 * (click: into the thread), and a badge counting what needs the
 * human. The TRIAGE tray at the right lists every open entity
 * organized into nothing — the fix for invisible pull requests.
 * Drag a card between columns to move it; everything else is the
 * channel agent's job, asked for in conversation.
 */

import { Spinner } from "@/components/ui/spinner";
import {
  moveTask,
  TASK_COLUMNS,
  useBoard,
  type BoardEntity,
  type BoardTask,
  type BoardView,
  type TaskStatus,
} from "@/lib/board";
import { cn } from "@/lib/utils";
import {
  Bell,
  CircleDot,
  GitPullRequestArrow,
  MessageSquare,
  Users,
} from "lucide-react";
import { memo, useMemo, useState, type DragEvent } from "react";

const ENTITY_STATE_CLASS: Record<string, string> = {
  open: "border-moss/40 bg-moss/10 text-moss",
  draft: "border-border bg-muted text-muted-foreground",
  merged: "border-terracotta/40 bg-terracotta/10 text-terracotta",
  closed: "border-brick/40 bg-brick/10 text-brick",
};

/** One entity as a chip — ref + state color; hover carries the title. */
const EntityChip = ({
  entity,
  refName,
}: {
  entity: BoardEntity | undefined;
  /** The ref to show when the Registry has no snapshot for it. */
  refName?: string;
}) => {
  const label = entity?.ref ?? refName ?? "?";
  const short = label.split("/").pop() ?? label;
  return (
    <a
      href={`https://github.com/${label.replace("#", entity?.kind === "issue" ? "/issues/" : "/pull/")}`}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={entity === undefined ? label : `${label} — ${entity.title}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0 font-mono text-[10px] hover:underline",
        ENTITY_STATE_CLASS[entity?.state ?? ""] ??
          "border-border text-muted-foreground",
      )}
    >
      {entity?.kind === "issue" ? (
        <CircleDot className="size-2.5" />
      ) : (
        <GitPullRequestArrow className="size-2.5" />
      )}
      {short}
    </a>
  );
};

const TaskCard = memo(
  ({
    task,
    board,
    onOpenThread,
  }: {
    task: BoardTask;
    board: BoardView;
    onOpenThread: (id: string) => void;
  }) => {
    const group = board.groups.find((entry) => entry.id === task.groupId);
    const entities = new Map(
      board.entities.map((entity) => [entity.ref, entity] as const),
    );
    return (
      <div
        data-task={task.id}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("text/task", task.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onClick={
          task.threadId === undefined
            ? undefined
            : () => onOpenThread(task.threadId!)
        }
        className={cn(
          "flex flex-col gap-1.5 rounded-md border border-border bg-card px-2.5 py-2 shadow-xs",
          task.threadId !== undefined && "cursor-pointer hover:bg-accent/40",
        )}
      >
        <div className="flex items-start gap-1.5">
          <span className="min-w-0 flex-1 text-[13px] font-medium">
            {task.title}
          </span>
          {task.pendingApprovals > 0 && (
            <span
              data-badge=""
              title={`${task.pendingApprovals} awaiting you`}
              className="flex shrink-0 items-center gap-0.5 rounded-full border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-medium text-primary"
            >
              <Bell className="size-2.5" />
              {task.pendingApprovals}
            </span>
          )}
        </div>
        {task.refs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.refs.map((ref) => (
              <EntityChip key={ref} entity={entities.get(ref)} refName={ref} />
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {group !== undefined && (
            <span className="flex items-center gap-1">
              <Users className="size-3" />
              {group.name}
            </span>
          )}
          {task.threadId !== undefined && (
            <span className="flex items-center gap-1 text-mist">
              <MessageSquare className="size-3" />
              thread
            </span>
          )}
        </div>
      </div>
    );
  },
);
TaskCard.displayName = "TaskCard";

export const BoardPage = ({
  onOpenThread,
}: {
  onOpenThread: (id: string) => void;
}) => {
  const board = useBoard();
  const [over, setOver] = useState<TaskStatus | undefined>(undefined);
  // a drop moves optimistically; the socket's snapshot reconciles
  const [moved, setMoved] = useState<Record<string, TaskStatus>>({});

  const columns = useMemo(() => {
    if (board === undefined) return undefined;
    const statusOf = (task: BoardTask) => moved[task.id] ?? task.status;
    return TASK_COLUMNS.map((column) => ({
      ...column,
      tasks: board.tasks.filter((task) => statusOf(task) === column.status),
    }));
  }, [board, moved]);

  if (board === undefined || columns === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }

  const drop = (status: TaskStatus) => (event: DragEvent) => {
    event.preventDefault();
    setOver(undefined);
    const id = event.dataTransfer.getData("text/task");
    if (id.length === 0) return;
    setMoved((current) => ({ ...current, [id]: status }));
    void moveTask(id, status).catch(() => {});
  };

  return (
    <div className="flex min-h-0 flex-1 divide-x divide-border overflow-x-auto">
      {/* the TRIAGE tray — open entities organized into nothing;
          FIRST: the inbox reads before the pipeline */}
      <div
        data-column="triage"
        className="flex w-72 shrink-0 flex-col gap-2 px-3 py-3"
      >
        <div className="flex items-center gap-2 px-1">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Triage
          </span>
          <span className="text-[11px] text-muted-foreground/70">
            {board.triage.length}
          </span>
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto">
          {board.triage.length === 0 && (
            <div className="px-1 py-4 text-center text-[11px] text-muted-foreground">
              Everything is organized. Ask Control to sync if this looks
              stale.
            </div>
          )}
          {board.triage.map((entity) => (
            <div
              key={entity.ref}
              className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-accent/40"
            >
              <div className="flex items-center gap-1.5">
                <EntityChip entity={entity} />
              </div>
              <span className="truncate text-[12px]">{entity.title}</span>
            </div>
          ))}
        </div>
      </div>
      {columns.map((column) => (
        <div
          key={column.status}
          data-column={column.status}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(column.status);
          }}
          onDragLeave={() =>
            setOver((current) =>
              current === column.status ? undefined : current,
            )
          }
          onDrop={drop(column.status)}
          className={cn(
            "flex w-64 shrink-0 flex-col gap-2 px-3 py-3",
            over === column.status && "bg-accent/30",
          )}
        >
          <div className="flex items-center gap-2 px-1">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {column.label}
            </span>
            <span className="text-[11px] text-muted-foreground/70">
              {column.tasks.length}
            </span>
          </div>
          <div className="flex min-h-8 flex-col gap-2 overflow-y-auto">
            {column.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                board={board}
                onOpenThread={onOpenThread}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

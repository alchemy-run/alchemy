/**
 * The TASK LEDGER, inside the channel + thread experience — there is
 * deliberately NO separate board:
 *
 * - {@link ChannelThreads} — the channel's threads as rail items
 *   nested under the channel entry (hot set first, backlog folded).
 * - {@link TaskPanel} — a task's THREAD, the right-side panel beside
 *   the center view (a Slack thread panel, not a modal): the ledger
 *   row whole — items, assignee, workspace, notes — and, when an
 *   engineer is on it, the engineer's live session: the work itself.
 */
import { ChatView } from "@/components/chat";
import { showOverlay, showTask } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { SquareTerminal, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface TaskItem {
  readonly ref: string;
  readonly kind: "issue" | "pull" | "request";
}

type TaskStatus = "todo" | "working" | "review" | "done";

interface Task {
  readonly id: string;
  readonly title: string;
  readonly items: ReadonlyArray<TaskItem>;
  readonly status: TaskStatus;
  readonly assignee?: string;
  readonly workspace?: string;
  readonly notes: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Active work first — the ledger is a backlog plus a small hot set. */
const STATUS_ORDER: ReadonlyArray<TaskStatus> = [
  "working",
  "review",
  "todo",
  "done",
];

const STATUS_DOT: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/40",
  working: "bg-amber-500",
  review: "bg-sky-500",
  done: "bg-moss",
};

const refUrl = (ref: string): string =>
  `https://github.com/${ref.replace("#", "/issues/")}`;

/** "3m" / "2h" / "5d" — the ledger's clock is coarse. */
const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
};

const useTasks = () => {
  const [tasks, setTasks] = useState<ReadonlyArray<Task>>([]);
  const load = useCallback(() => {
    fetch("/api/tasks")
      .then(async (response) => {
        if (response.ok) {
          setTasks(((await response.json()) as { tasks: Task[] }).tasks);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [load]);
  return tasks;
};

const AssigneeChip = ({ name }: { name: string }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      showOverlay({ kind: "agent", id: `Engineer:root::${name}` });
    }}
    title={`open ${name}'s session`}
    className="flex cursor-pointer items-center gap-1 rounded border border-border/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
  >
    <UserRound className="size-2.5" />
    {name}
  </button>
);

const WorkspaceChip = ({ name }: { name: string }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      showOverlay({ kind: "workspace", name });
    }}
    title={`terminal into workspace ${name}`}
    className="flex cursor-pointer items-center gap-1 rounded border border-border/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
  >
    <SquareTerminal className="size-2.5" />
    {name}
  </button>
);

/* ── the rail — threads "under" their channel ─────────────────────── */

/** How many threads the rail shows before folding into "+N more". */
const RAIL_FOLD = 12;

/**
 * The channel's THREADS, as rail items nested under the channel entry
 * (Slack's thread list, Discord's active threads): the hot set first
 * (working, review), then the freshest of the backlog, folded behind
 * "+N more". Clicking one opens its thread panel beside the channel.
 */
export const ChannelThreads = ({ selected }: { selected?: string }) => {
  const tasks = useTasks();
  const [unfolded, setUnfolded] = useState(false);

  const sorted = [...tasks].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      b.updatedAt - a.updatedAt,
  );
  const shown = unfolded ? sorted : sorted.slice(0, RAIL_FOLD);
  const folded = sorted.length - shown.length;

  if (tasks.length === 0) return null;
  return (
    <div className="ml-4 flex flex-col gap-px border-l border-border/60 pl-1.5">
      {shown.map((task) => (
        <button
          key={task.id}
          type="button"
          data-task={task.id}
          onClick={() => showTask(task.id)}
          title={`${task.id} · ${task.status} — ${task.title}`}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[12px]",
            task.id === selected
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              STATUS_DOT[task.status],
            )}
          />
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
        </button>
      ))}
      {(folded > 0 || unfolded) && (
        <button
          type="button"
          onClick={() => setUnfolded(!unfolded)}
          className="cursor-pointer rounded px-1.5 py-0.5 text-left text-[11px] text-muted-foreground/70 hover:bg-accent/60 hover:text-foreground"
        >
          {unfolded ? "show less" : `+${folded} more`}
        </button>
      )}
    </div>
  );
};

/* ── the panel — a task's THREAD, beside the center view ──────────── */

export const TaskPanel = ({ id }: { id: string }) => {
  const [task, setTask] = useState<Task | undefined | null>(undefined);

  useEffect(() => {
    setTask(undefined);
    let live = true;
    const load = () => {
      fetch(`/api/tasks/${encodeURIComponent(id)}`)
        .then(async (response) => {
          if (!live) return;
          setTask(
            response.ok
              ? ((await response.json()) as { task: Task }).task
              : null,
          );
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id]);

  return (
    <aside
      aria-label={`task ${id}`}
      className={cn(
        "flex w-[26rem] shrink-0 flex-col border-l border-border bg-background",
        // narrow viewports: the panel OVERLAYS the center from the
        // right (Slack's phone behavior) instead of crushing it
        "max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:max-w-[85vw] max-lg:shadow-2xl",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {task != null && (
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                STATUS_DOT[task.status],
              )}
              title={task.status}
            />
          )}
          <span className="truncate font-mono text-xs text-muted-foreground">
            {id}
          </span>
          {task != null && (
            <span className="text-[11px] text-muted-foreground">
              {task.status}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => showTask(undefined)}
          aria-label="close the task panel"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-accent"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {task === undefined && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
      {task === null && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          no such task
        </div>
      )}
      {task != null && (
        <>
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2">
            <div className="text-[13px] font-medium">{task.title}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {task.items.map((item) => (
                <a
                  key={item.ref}
                  href={refUrl(item.ref)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  {item.ref}
                </a>
              ))}
              {task.assignee !== undefined && (
                <AssigneeChip name={task.assignee} />
              )}
              {task.workspace !== undefined && (
                <WorkspaceChip name={task.workspace} />
              )}
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
                updated {ago(task.updatedAt)} ago
              </span>
            </div>
            {task.notes.length > 0 && (
              <div className="flex flex-col gap-0.5 border-l-2 border-border/60 pl-2">
                {task.notes.map((note, index) => (
                  <div
                    key={index}
                    className="text-[11px] text-muted-foreground"
                  >
                    {note}
                  </div>
                ))}
              </div>
            )}
          </div>

          {task.assignee !== undefined ? (
            <ChatView
              key={task.assignee}
              id={`Engineer:root::${task.assignee}`}
              active={false}
              readOnly
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              unassigned — no thread yet; when the channel spawns an
              engineer on it, the work streams here
            </div>
          )}
        </>
      )}
    </aside>
  );
};

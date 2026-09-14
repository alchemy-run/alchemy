/**
 * The TASK LEDGER, as POSTS in a tree — everything is messaging:
 * a channel is a feed, a task is a thread (post) in it, an ask is a
 * reply that spawns a sub-thread, and every node deep-links like a
 * tweet permalink. There is deliberately NO separate board:
 *
 * - {@link ChannelThreads} — the channel's threads as rail items
 *   nested under the channel entry: the whole list, scrollable,
 *   narrowed by a text filter.
 * - {@link TaskThread} — a thread FOCUSED in the center (the
 *   tweet-permalink move): the post, then the work below it; a
 *   breadcrumb walks up to the channel.
 */
import { ChatView } from "@/components/chat";
import { showOverlay, showTask } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  Hash,
  Search,
  SquareTerminal,
  UserRound,
  X,
} from "lucide-react";
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

/** Everything a thread is findable by — one lowercase haystack. */
const haystack = (task: Task): string =>
  [
    task.id,
    task.title,
    task.status,
    task.assignee ?? "",
    task.workspace ?? "",
    ...task.items.map((item) => item.ref),
  ]
    .join("\n")
    .toLowerCase();

/**
 * The channel's THREADS, as rail items nested under the channel
 * entry: the hot set first (working, review), then the backlog — the
 * WHOLE list, scrollable, narrowed by the text filter above it (no
 * fold, no "+N more"). Clicking one focuses the thread in the center.
 */
export const ChannelThreads = ({ selected }: { selected?: string }) => {
  const tasks = useTasks();
  const [query, setQuery] = useState("");

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = tasks
    .filter(
      (task) =>
        words.length === 0 ||
        words.every((word) => haystack(task).includes(word)),
    )
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        b.updatedAt - a.updatedAt,
    );

  if (tasks.length === 0) return null;
  return (
    <div className="ml-4 flex min-h-0 flex-col gap-px border-l border-border/60 pl-1.5">
      <div className="mb-0.5 flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 focus-within:border-border">
        <Search className="size-2.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="filter threads…"
          aria-label="filter threads"
          className="w-full min-w-0 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="clear the thread filter"
            className="flex cursor-pointer items-center text-muted-foreground hover:text-foreground"
          >
            <X className="size-2.5" />
          </button>
        )}
      </div>
      {shown.length === 0 && (
        <div className="px-1.5 py-0.5 text-[11px] text-muted-foreground/60">
          nothing matches
        </div>
      )}
      {shown.map((task) => (
        <button
          key={task.id}
          type="button"
          data-task={task.id}
          onClick={() => showTask(task.id)}
          title={`${task.id} · ${task.status} — ${task.title}`}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[12px]",
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
    </div>
  );
};

/* ── the thread — a task, FOCUSED in the center ───────────────────── */

/**
 * A task's THREAD as the center focus — the tweet-permalink move:
 * clicking a thread anywhere (rail, chip, reply pill) swaps the
 * channel feed for the thread itself. The breadcrumb walks UP the
 * tree (thread → its channel); the work below walks down — the
 * assigned engineer's session, whose asks open sub-threads.
 */
export const TaskThread = ({
  id,
  channel,
  onUp,
}: {
  id: string;
  /** The channel this thread lives in — the breadcrumb's parent. */
  channel: string;
  /** Walk up: focus the channel feed again. */
  onUp: () => void;
}) => {
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
    <section
      aria-label={`thread ${id}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* walk UP the tree: thread → channel */}
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5">
        <button
          type="button"
          onClick={onUp}
          aria-label={`back to the ${channel} channel`}
          className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          <Hash className="size-3.5" />
          {channel}
        </button>
        <ChevronRight className="size-3 text-muted-foreground/50" />
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
      </header>

      {task === undefined && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
      {task === null && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          no such thread
        </div>
      )}
      {task != null && (
        <>
          {/* the POST: what this thread is about */}
          <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3">
            <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 px-4 py-3">
              <div className="text-sm font-medium">{task.title}</div>
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
          </div>

          {/* the THREAD below the post: the work itself — the
              engineer's session (its asks open sub-threads) */}
          {task.assignee !== undefined ? (
            <ChatView
              key={task.assignee}
              id={`Engineer:root::${task.assignee}`}
              active={false}
              readOnly
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              unassigned — no replies yet; when the channel spawns an
              engineer on it, the work streams here
            </div>
          )}
        </>
      )}
    </section>
  );
};

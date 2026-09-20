/**
 * The BOARD (`/tasks/:queue`) — a SIDEBAR that teaches the mental
 * model (one work stream › its agents' DESKS › TAGS as mere labels)
 * beside six columns (inbox | ready | working | review | parked |
 * done). Desks are one-per-agent standing threads; tags are area
 * labels the router assigns — filters and scheduling affinity, never
 * desks. Cards wear tag chips and click into the task page; the ⋯
 * menu is the human override (a `routed` event with actor `sam`);
 * desk rows click into the desk view.
 */
import { Avatar } from "@/components/avatar";
import { PostRef } from "@/components/post-thread";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BOARD_STATES,
  fetchBoard,
  fetchQueues,
  KNOWN_TAGS,
  parseOrigin,
  routeTask,
  setDeskWidth,
  tagColor,
  TRANSITIONS,
  type QueueSummary,
  type TaskRow,
  type TaskState,
} from "@/lib/tasks";
import { showDesk, showTasks, showWork } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  CircleDot,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";

/** A duration, compact: `4s`, `12m`, `1h 4m`. */
export const elapsedOf = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** The current second, ticking — live elapsed on working rows. */
export const useNow = (live: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
};

/** The queues, fetched once per mount — the switcher and the desk
 *  strip; re-polled with the board so working ids stay live. */
export const useQueues = (
  poll = false,
): ReadonlyArray<QueueSummary> | undefined => {
  const [queues, setQueues] = useState<
    ReadonlyArray<QueueSummary> | undefined
  >();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetchQueues()
        .then((rows) => {
          if (!alive) return;
          setQueues(rows);
          if (poll) timer = setTimeout(load, 5_000);
        })
        .catch(() => {
          if (alive && poll) timer = setTimeout(load, 10_000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [poll]);
  return queues;
};

/** The list rows' small state pill — issues.tsx's StateBadge, worn
 *  by task states. */
export const TaskStateBadge = ({ state }: { state: TaskState }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
      state === "working" && "bg-moss/15 text-moss",
      state === "ready" && "bg-moss/10 text-foreground/80",
      state === "review" && "bg-purple-500/15 text-purple-400",
      state === "parked" && "bg-amber-500/15 text-amber-500",
      state === "done" && "bg-purple-500/15 text-purple-400",
      state === "dropped" && "bg-red-500/15 text-red-400",
      state === "inbox" && "bg-muted text-muted-foreground",
    )}
  >
    {state === "working" && <Loader2 className="size-3 animate-spin" />}
    {state}
  </span>
);

/** The ORIGIN chip — `#123` opens the issue, `post:` splits the
 *  thread open as a pane, anything else is quiet prose. */
export const OriginChip = ({ origin }: { origin: string }) => {
  const parsed = parseOrigin(origin);
  if (parsed.kind === "github") {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          showWork("issues", parsed.repo, parsed.number);
        }}
        title={`open ${parsed.repo}#${parsed.number}`}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded bg-primary/15 px-1 font-mono text-[11px] font-medium text-primary hover:bg-primary/25"
      >
        <CircleDot className="size-3 shrink-0" />#{parsed.number}
      </button>
    );
  }
  if (parsed.kind === "post") return <PostRef id={parsed.id} />;
  return (
    <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
      {parsed.text}
    </span>
  );
};

/** A task's small AREA tag chip — the board card's and the task
 *  page's shared token, each tag in its own hue (lib/tasks.ts). */
export const TagChip = ({ tag }: { tag: string }) => (
  <span
    className={cn(
      "shrink-0 rounded-full px-1.5 py-px font-mono text-[10px]",
      tagColor(tag),
    )}
  >
    {tag}
  </span>
);

/** The human override — Move to… every hop the state machine allows.
 *  Park prompts for the reason it rides. */
const MoveMenu = ({
  task,
  onMoved,
}: {
  task: TaskRow;
  onMoved: () => void;
}) => {
  const targets = TRANSITIONS[task.state];
  if (targets.length === 0) return null;
  const move = (state: TaskState) => {
    const reason =
      state === "parked"
        ? (window.prompt("Park it — why?") ?? undefined)
        : undefined;
    if (state === "parked" && reason === undefined) return;
    routeTask(task.queue, task.id, state, {
      ...(reason === undefined ? {} : { data: reason }),
    })
      .then(() => onMoved())
      .catch(() => {});
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={(event) => event.stopPropagation()}
        aria-label={`move ${task.id}`}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={(event) => event.stopPropagation()}
      >
        {targets.map((state) => (
          <DropdownMenuItem
            key={state}
            className="text-xs capitalize"
            onSelect={() => move(state)}
          >
            Move to {state}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** One CARD of a column — title, id, origin, priority, the live
 *  spinner while its desk works it, the parked reason line. */
const TaskCard = ({
  task,
  now,
  onMoved,
}: {
  task: TaskRow;
  now: number;
  onMoved: () => void;
}) => (
  <div
    role="button"
    tabIndex={0}
    onClick={() => showTasks(task.queue, task.id)}
    onKeyDown={(event) => {
      if (event.key === "Enter") showTasks(task.queue, task.id);
    }}
    className="group flex w-full cursor-pointer flex-col gap-1.5 rounded-md border border-border/70 bg-background px-2.5 py-2 text-left hover:border-border hover:bg-accent/40"
  >
    <div className="flex items-start gap-1.5">
      <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug">
        {task.title}
      </span>
      <MoveMenu task={task} onMoved={onMoved} />
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {task.id}
      </span>
      {task.tags.map((tag) => (
        <TagChip key={tag} tag={tag} />
      ))}
      {task.origin !== undefined && <OriginChip origin={task.origin} />}
      {task.priority !== 2 && (
        <span
          title={`priority ${task.priority}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px]",
            task.priority < 2 ? "text-red-400" : "text-muted-foreground",
          )}
        >
          <TriangleAlert className="size-3" />
          {task.priority}
        </span>
      )}
    </div>
    {task.state === "working" && (
      <span className="flex items-center gap-1.5 text-[11px] text-primary/80">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        {task.desk ?? "desk"} · {elapsedOf(now - task.updated)}
      </span>
    )}
    {task.state === "parked" && task.parkedReason !== undefined && (
      <span className="flex min-w-0 items-center gap-1 text-[11px] text-amber-500">
        <PauseCircle className="size-3 shrink-0" />
        <span className="min-w-0 truncate" title={task.parkedReason}>
          {task.parkedReason}
        </span>
      </span>
    )}
  </div>
);

/** The desk's WIDTH stepper — the parallelism dial (− N +, 1..4):
 *  width 1 is the linear default; >1 forks clone sessions from the
 *  trunk that merge their notes home. Optimistic; the poll confirms. */
export const WidthStepper = ({
  queue,
  desk,
  width,
}: {
  queue: string;
  desk: string;
  width: number;
}) => {
  const [local, setLocal] = useState<number | undefined>();
  // the poll caught up with the optimistic value — let it own it again
  useEffect(() => {
    setLocal((current) => (current === width ? undefined : current));
  }, [width]);
  const shown = local ?? width;
  const step = (delta: number) => {
    const next = Math.min(4, Math.max(1, shown + delta));
    if (next === shown) return;
    setLocal(next);
    setDeskWidth(queue, desk, next).catch(() => setLocal(undefined));
  };
  return (
    <span
      onClick={(event) => event.stopPropagation()}
      title="desk width — how many tasks this desk works at once (extra slots fork clone sessions that merge their notes home)"
      className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
    >
      <button
        type="button"
        aria-label={`narrow ${desk}`}
        disabled={shown <= 1}
        onClick={() => step(-1)}
        className="flex size-4 cursor-pointer items-center justify-center rounded hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        −
      </button>
      <span className="w-3 text-center font-mono">{shown}</span>
      <button
        type="button"
        aria-label={`widen ${desk}`}
        disabled={shown >= 4}
        onClick={() => step(1)}
        className="flex size-4 cursor-pointer items-center justify-center rounded hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        +
      </button>
    </span>
  );
};

/** One desk of the sidebar — the agent, its width dial, and what it
 *  is working (each working task on its own clickable line). */
const DeskRow = ({
  queue,
  desk,
  now,
  sinceOf,
}: {
  queue: string;
  desk: QueueSummary["desks"][number];
  now: number;
  /** A working task's claim time, when the board knows it. */
  sinceOf: (id: string) => number | undefined;
}) => (
  <div
    role="button"
    tabIndex={0}
    onClick={() => showDesk(queue, desk.slug)}
    onKeyDown={(event) => {
      if (event.key === "Enter") showDesk(queue, desk.slug);
    }}
    title={`open the ${desk.slug} desk — its one long-lived working thread`}
    className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-accent/60"
  >
    <Avatar name={desk.slug} kind="agent" size={18} />
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono font-semibold">
          {desk.slug}
        </span>
        <WidthStepper queue={queue} desk={desk.slug} width={desk.width} />
      </span>
      {desk.working.length > 0 ? (
        <>
          <span className="flex items-center gap-1 text-[10.5px] text-primary/80">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            working {desk.working.length}/{desk.width}
          </span>
          {desk.working.map((work) => (
            <button
              key={work.id}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                showTasks(queue, work.id);
              }}
              title={`open ${work.id}`}
              className="block w-full truncate pl-4 text-left font-mono text-[10.5px] text-primary/80 hover:underline"
            >
              {work.id}
              {sinceOf(work.id) !== undefined && (
                <> · {elapsedOf(now - sinceOf(work.id)!)}</>
              )}
            </button>
          ))}
        </>
      ) : (
        <span className="block text-[10.5px] text-muted-foreground">idle</span>
      )}
    </span>
  </div>
);

/** A sidebar section's tiny caption — the mental model, in place. */
const SideNote = ({ children }: { children: string }) => (
  <p className="px-2 pb-1.5 text-[10.5px] leading-snug text-muted-foreground/80">
    {children}
  </p>
);

const SideHeading = ({ children }: { children: string }) => (
  <div className="px-2 pt-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
    {children}
  </div>
);

export const TaskBoard = ({ queue }: { queue?: string }) => {
  const queues = useQueues(true);
  const selected =
    queues === undefined
      ? undefined
      : (queues.find((candidate) => candidate.slug === queue) ?? queues[0]);

  /** The tag FILTER — undefined shows everything. */
  const [tag, setTag] = useState<string | undefined>();
  const [board, setBoard] = useState<
    Record<TaskState, ReadonlyArray<TaskRow>> | undefined
  >();
  useEffect(() => {
    if (selected === undefined) return;
    setBoard(undefined);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetchBoard(selected.slug)
        .then((next) => {
          if (!alive) return;
          setBoard(next);
          // fast while anything works — channel-feed's poll shape
          timer = setTimeout(load, next.working.length > 0 ? 1_500 : 5_000);
        })
        .catch(() => {
          if (alive) timer = setTimeout(load, 5_000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.slug]);

  const working = board?.working ?? [];
  const now = useNow(working.length > 0);
  const refresh = () => {
    if (selected !== undefined) {
      fetchBoard(selected.slug)
        .then(setBoard)
        .catch(() => {});
    }
  };

  if (queues === undefined || selected === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {queues === undefined ? "loading the queues…" : "no queues registered"}
      </div>
    );
  }

  const empty =
    board !== undefined &&
    BOARD_STATES.every((state) => (board[state] ?? []).length === 0);

  // the filter pills: every declared tag plus any tag the data wears
  const tags = [
    ...KNOWN_TAGS,
    ...(board === undefined
      ? []
      : BOARD_STATES.flatMap((state) =>
          (board[state] ?? []).flatMap((task) => task.tags),
        ).filter((candidate) => !KNOWN_TAGS.includes(candidate))),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);

  // tasks per tag, board-wide — the sidebar's filter counts
  const countOf = (candidate: string) =>
    board === undefined
      ? 0
      : BOARD_STATES.flatMap((state) => board[state] ?? []).filter((task) =>
          task.tags.includes(candidate),
        ).length;

  return (
    <section
      aria-label={`task board ${selected.slug}`}
      className="flex min-h-0 min-w-0 flex-1"
    >
      {/* the sidebar — the mental model made visible:
          one QUEUE › its agents' DESKS › TAGS as mere labels */}
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/20 px-2 pb-3">
        <SideHeading>work stream</SideHeading>
        <SideNote>a queue of tasks, staffed by the desks below</SideNote>
        <div
          className="rounded-md bg-accent px-2 py-1.5 text-[12px] font-semibold"
          title={selected.prose}
        >
          {selected.name}
        </div>

        <SideHeading>desks</SideHeading>
        <SideNote>
          one per agent — every task this stream assigns an agent runs
          through its single long-lived thread
        </SideNote>
        {selected.desks.map((desk) => (
          <DeskRow
            key={desk.slug}
            queue={selected.slug}
            desk={desk}
            now={now}
            sinceOf={(id) => working.find((task) => task.id === id)?.updated}
          />
        ))}

        <SideHeading>tags</SideHeading>
        <SideNote>
          area labels the router assigns — they filter and steer
          scheduling; tags do not have desks
        </SideNote>
        <button
          type="button"
          onClick={() => setTag(undefined)}
          className={cn(
            "flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1 text-left text-xs",
            tag === undefined
              ? "bg-accent font-semibold"
              : "text-muted-foreground hover:bg-accent/60",
          )}
        >
          All
        </button>
        {tags.map((candidate) => (
          <button
            key={candidate}
            type="button"
            title={`show only ${candidate} tasks`}
            onClick={() => setTag(candidate === tag ? undefined : candidate)}
            className={cn(
              "flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1 text-left",
              candidate === tag ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            <span
              className={cn(
                "rounded-full px-1.5 py-px font-mono text-[11px]",
                tagColor(candidate),
                candidate === tag ? "font-semibold" : "opacity-80",
              )}
            >
              {candidate}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {countOf(candidate) || ""}
            </span>
          </button>
        ))}
      </aside>

      {/* the six columns */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 py-3">
          {board === undefined ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            loading the board…
          </div>
        ) : (
          BOARD_STATES.map((state) => {
            const rows = (board[state] ?? []).filter(
              (task) => tag === undefined || task.tags.includes(tag),
            );
            // done keeps its count; the column shows the last 5
            const shown =
              state === "done"
                ? [...rows]
                    .sort((left, right) => right.updated - left.updated)
                    .slice(0, 5)
                : rows;
            return (
              <div
                key={state}
                className="flex min-h-0 w-56 min-w-52 flex-1 flex-col rounded-md border border-border/50 bg-muted/20"
              >
                <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {state}
                  <span className="font-mono">{rows.length}</span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-2">
                  {shown.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      now={now}
                      onMoved={refresh}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
        </div>
        {empty && (
          <div className="shrink-0 px-4 pb-4 text-center text-[12px] text-muted-foreground">
            nothing in the {selected.name} stream yet — file a task and the
            router places it
          </div>
        )}
      </div>
    </section>
  );
};

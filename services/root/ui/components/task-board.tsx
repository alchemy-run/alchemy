/**
 * The BOARD (`/tasks/:queue`) — the ONE work stream, six columns
 * (inbox | ready | working | review | parked | done), TAG filter
 * pills (All + every known/seen area tag), and the DESK STRIP: each
 * desk's agent with the task it is working (live elapsed) or "idle".
 * Cards wear small tag chips and click into the task page; the ⋯
 * menu is the human override (a `routed` event with actor `sam`);
 * desk entries click into the desk view.
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

/** One desk of the strip — the agent, and what it is working. */
const DeskChip = ({
  queue,
  desk,
  now,
  workingSince,
}: {
  queue: string;
  desk: QueueSummary["desks"][number];
  now: number;
  /** The working task's claim time, when the board knows it. */
  workingSince?: number;
}) => (
  <button
    type="button"
    onClick={() => showDesk(queue, desk.slug)}
    title={`open the ${desk.slug} desk`}
    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent"
  >
    <Avatar name={desk.slug} kind="agent" size={16} />
    <span className="font-mono font-semibold">{desk.slug}</span>
    {desk.working !== undefined ? (
      <span className="flex items-center gap-1 text-primary/80">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        {desk.working}
        {workingSince !== undefined && (
          <> · {elapsedOf(now - workingSince)}</>
        )}
      </span>
    ) : (
      <span className="text-muted-foreground">idle</span>
    )}
  </button>
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

  return (
    <section
      aria-label={`task board ${selected.slug}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* the tag filter pills + the desk strip */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setTag(undefined)}
            className={cn(
              "cursor-pointer rounded-md px-2 py-0.5 text-xs",
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
              onClick={() =>
                setTag(candidate === tag ? undefined : candidate)
              }
              className={cn(
                "cursor-pointer rounded-md px-2 py-0.5 font-mono text-xs",
                tagColor(candidate),
                candidate === tag
                  ? "font-semibold ring-1 ring-current"
                  : "opacity-70 hover:opacity-100",
              )}
            >
              {candidate}
            </button>
          ))}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            desks
          </span>
          {selected.desks.map((desk) => (
            <DeskChip
              key={desk.slug}
              queue={selected.slug}
              desk={desk}
              now={now}
              workingSince={
                working.find((task) => task.id === desk.working)?.updated
              }
            />
          ))}
        </div>
      </header>

      {/* the six columns */}
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
    </section>
  );
};

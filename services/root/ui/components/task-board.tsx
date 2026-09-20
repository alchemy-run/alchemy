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
import { Avatar, hueOf } from "@/components/avatar";
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
  fetchWalks,
  KNOWN_TAGS,
  parseOrigin,
  readyOrder,
  reorderTask,
  routeTask,
  setDeskWidth,
  tagColor,
  TRANSITIONS,
  type QueueSummary,
  type TaskRow,
  type TaskState,
  type WalkRound,
  type WalkStep,
} from "@/lib/tasks";
import { showDesk, showTasks, showWork } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  CircleDot,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** An agent's accent, from its avatar hue — `light-dark()` keeps
 *  both themes readable off the same mapping. */
const agentText = (agent: string): string => {
  const hue = hueOf(agent);
  return `light-dark(hsl(${hue} 55% 32%), hsl(${hue} 60% 74%))`;
};
const agentBorder = (agent: string, soft: boolean): string => {
  const hue = hueOf(agent);
  return soft
    ? `light-dark(hsl(${hue} 55% 45% / 0.55), hsl(${hue} 55% 60% / 0.55))`
    : `light-dark(hsl(${hue} 55% 40%), hsl(${hue} 55% 58%))`;
};
const agentTint = (agent: string): string =>
  `hsl(${hueOf(agent)} 55% 50% / 0.14)`;

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
 *  spinner while its desk works it, the parked reason line. READY
 *  cards drag up/down (the code-browser tab pattern) to write a soft
 *  hint, and wear the scheduler's why line: plain muted prose for a
 *  rank that follows your order, a `judge:` badge when it deviates —
 *  the transparency is the feature. The FOCUS MAP rides the border:
 *  a WORKING card wears its agent's solid accent, a NEXT card (the
 *  walk's top pick for a desk) the same hue lighter plus the
 *  `NEXT · <agent>` chip, and a card the walk drilled into this
 *  round carries a tiny magnifier. Clicking the why line opens the
 *  pick's full walk trace. */
const TaskCard = ({
  task,
  now,
  onMoved,
  drag,
  examined,
  onTrace,
  cardRef,
}: {
  task: TaskRow;
  now: number;
  onMoved: () => void;
  /** READY-column drag wiring (HTML5, like the code-browser tabs). */
  drag?: {
    onDragStart: () => void;
    onDragOver: () => void;
    onDragEnd: () => void;
  };
  /** The walk drilled into this card's hidden content this round. */
  examined?: boolean;
  /** Open the scheduler's walk trace for this card. */
  onTrace?: () => void;
  /** The board's FLIP registry — ready cards animate reorders. */
  cardRef?: (element: HTMLDivElement | null) => void;
}) => {
  const workingAgent = task.state === "working" ? task.desk : undefined;
  const nextAgent = task.state === "ready" ? task.nextFor : undefined;
  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      onClick={() => showTasks(task.queue, task.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") showTasks(task.queue, task.id);
      }}
      {...(drag === undefined
        ? {}
        : {
            draggable: true,
            onDragStart: drag.onDragStart,
            onDragEnd: drag.onDragEnd,
            onDragOver: (event: React.DragEvent) => {
              event.preventDefault();
              drag.onDragOver();
            },
          })}
      style={
        workingAgent !== undefined
          ? { borderColor: agentBorder(workingAgent, false) }
          : nextAgent !== undefined
            ? { borderColor: agentBorder(nextAgent, true) }
            : undefined
      }
      className="group flex w-full cursor-pointer flex-col gap-1.5 rounded-md border border-border/70 bg-background px-2.5 py-2 text-left hover:border-border hover:bg-accent/40"
    >
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug">
          {task.title}
        </span>
        {drag !== undefined && (
          <span
            aria-hidden
            title="drag to reorder — your order is a suggestion the scheduler weighs"
            className="shrink-0 cursor-grab font-mono text-[11px] text-muted-foreground opacity-0 group-hover:opacity-60"
          >
            ↕
          </span>
        )}
        <MoveMenu task={task} onMoved={onMoved} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {nextAgent !== undefined && (
          <span
            title={`the scheduler's next pick for the ${nextAgent} desk`}
            style={{
              background: agentTint(nextAgent),
              color: agentText(nextAgent),
            }}
            className="shrink-0 rounded-full px-1.5 py-px font-mono text-[10px] font-semibold tracking-wide"
          >
            NEXT · {nextAgent}
          </span>
        )}
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
        {examined === true && (
          <span
            title="examined by the scheduler this round — the walk drilled into this card"
            className="inline-flex shrink-0 items-center text-muted-foreground"
          >
            <Search className="size-3" />
          </span>
        )}
      </div>
      {task.state === "ready" && task.rankWhy !== undefined && (
        <span className="flex min-w-0 items-center">
          {task.rankWhy.startsWith("judge:") ? (
            <button
              type="button"
              title="the judge ranked this against your dragged order — click for the walk trace"
              onClick={(event) => {
                if (onTrace === undefined) return;
                event.stopPropagation();
                onTrace();
              }}
              className="min-w-0 cursor-pointer truncate rounded bg-purple-500/15 px-1 py-px text-left font-mono text-[10px] text-purple-700 hover:bg-purple-500/25 dark:text-purple-400"
            >
              {task.rankWhy}
            </button>
          ) : (
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate text-left text-[10px] leading-tight text-muted-foreground/70 hover:text-muted-foreground hover:underline"
              title={`${task.rankWhy} — click for the walk trace`}
              onClick={(event) => {
                if (onTrace === undefined) return;
                event.stopPropagation();
                onTrace();
              }}
            >
              {task.rankWhy}
            </button>
          )}
        </span>
      )}
      {task.state === "working" && (
        <span
          style={
            workingAgent === undefined
              ? undefined
              : { color: agentText(workingAgent) }
          }
          className="flex items-center gap-1.5 text-[11px] text-primary/80"
        >
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
};

/** The WALK TRACE pane — one pick's decision chain, step by step:
 *  the question, the answer, a conviction bar, what was drilled. */
const WalkTracePanel = ({
  task,
  trace,
  onClose,
}: {
  task: TaskRow;
  trace: ReadonlyArray<WalkStep> | undefined;
  onClose: () => void;
}) => (
  <aside
    aria-label={`walk trace ${task.id}`}
    className="flex w-72 shrink-0 flex-col overflow-hidden border-l border-border bg-muted/20"
  >
    <div className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          walk trace
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {task.id}
        </div>
        <div className="truncate text-[12px] font-medium">{task.title}</div>
      </div>
      <button
        type="button"
        aria-label="close the walk trace"
        onClick={onClose}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {trace === undefined || trace.length === 0 ? (
        <p className="px-3 py-3 text-[11px] leading-snug text-muted-foreground">
          no walk recorded for this card this round — its rank came from
          the human order (hint-then-FIFO), not a judged pick.
        </p>
      ) : (
        trace.map((step, index) => (
          <div
            key={index}
            className="border-b border-border/40 px-3 py-2"
          >
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="font-mono font-semibold">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate" title={step.question}>
                {step.question}
              </span>
              <span className="shrink-0 font-mono">{step.elapsedMs}ms</span>
            </div>
            <div className="mt-0.5 text-[12px] leading-snug">
              → {step.answer}
            </div>
            <div
              className="mt-1 flex items-center gap-1.5"
              title={`conviction ${(step.conviction * 100).toFixed(0)}%`}
            >
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded bg-border/60">
                <div
                  className="h-1 rounded bg-purple-500/70"
                  style={{
                    width: `${Math.round(Math.min(1, Math.max(0, step.conviction)) * 100)}%`,
                  }}
                />
              </div>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {(step.conviction * 100).toFixed(0)}%
              </span>
            </div>
            {step.expanded.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {step.expanded.map((id) => (
                  <span
                    key={id}
                    title={`the walk drilled into ${id} at this step`}
                    className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground"
                  >
                    <Search className="size-2.5" />
                    {id}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
    <p className="shrink-0 px-3 py-2 text-[10px] leading-snug text-muted-foreground/80">
      the scheduler re-walks the whole board on every event — each step
      is one System One judgment; drills open bodies and threads.
    </p>
  </aside>
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
  /** The latest rank round's walk traces — the trace panel and the
   *  "examined this round" magnifiers; polled beside the board. */
  const [walks, setWalks] = useState<WalkRound | undefined>();
  /** The card whose walk trace pane is open. */
  const [traceTask, setTraceTask] = useState<string | undefined>();
  useEffect(() => {
    if (selected === undefined) return;
    setBoard(undefined);
    setWalks(undefined);
    setTraceTask(undefined);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetchWalks(selected.slug)
        .then((round) => {
          if (alive) setWalks(round);
        })
        .catch(() => {});
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
      fetchWalks(selected.slug)
        .then(setWalks)
        .catch(() => {});
    }
  };

  /** Every card the latest walk round drilled into — the magnifier. */
  const examined = useMemo(() => {
    const set = new Set<string>();
    for (const row of walks?.walks ?? []) {
      for (const step of row.trace) {
        for (const id of step.expanded) set.add(id);
      }
    }
    return set;
  }, [walks]);

  // ── READY drag reorder (the code-browser tab pattern) ──────────
  // While a drag is live (and until its reorder lands) `dragOrder`
  // owns the ready column's order — the poll can keep painting
  // without snapping the card back mid-drag.
  const [dragging, setDragging] = useState<string | undefined>();
  const [dragOrder, setDragOrder] = useState<
    ReadonlyArray<string> | undefined
  >();

  // ── FLIP: ready cards SLIDE to their new rank, never teleport ──
  // Refs of the ready cards' DOM nodes; after every render, any card
  // whose rect moved animates from its previous position to rest,
  // and a card whose RANK changed flashes a brief judge-purple glow.
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const prevRanks = useRef(new Map<string, number | undefined>());
  useLayoutEffect(() => {
    const ranks = new Map<string, number | undefined>();
    for (const row of board?.ready ?? []) ranks.set(row.id, row.rank);
    for (const [id, element] of cardRefs.current) {
      if (!element.isConnected) {
        cardRefs.current.delete(id);
        prevRects.current.delete(id);
        continue;
      }
      const rect = element.getBoundingClientRect();
      const prev = prevRects.current.get(id);
      // a live drag owns the motion — FLIP only animates poll moves
      if (prev !== undefined && dragging === undefined) {
        const dx = prev.left - rect.left;
        const dy = prev.top - rect.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          element.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: "none" },
            ],
            { duration: 320, easing: "cubic-bezier(0.2, 0, 0.2, 1)" },
          );
        }
      }
      prevRects.current.set(id, rect);
      const hadRank = prevRanks.current.has(id);
      const prevRank = prevRanks.current.get(id);
      const rank = ranks.get(id);
      if (hadRank && rank !== undefined && prevRank !== rank) {
        element.animate(
          [
            { boxShadow: "0 0 0 2px hsl(270 60% 60% / 0.55)" },
            { boxShadow: "0 0 0 2px hsl(270 60% 60% / 0)" },
          ],
          { duration: 900, easing: "ease-out" },
        );
      }
    }
    prevRanks.current = ranks;
  });
  const readyRows = (rows: ReadonlyArray<TaskRow>): ReadonlyArray<TaskRow> => {
    const sorted = [...rows].sort(readyOrder);
    if (dragOrder === undefined) return sorted;
    const indexOf = (id: string) => {
      const index = dragOrder.indexOf(id);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...sorted].sort((a, b) => indexOf(a.id) - indexOf(b.id));
  };
  const moveCard = (from: string, to: string) =>
    setDragOrder((current) => {
      if (current === undefined) return current;
      const next = [...current];
      const fromIndex = next.indexOf(from);
      const toIndex = next.indexOf(to);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return current;
      }
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, from);
      return next;
    });
  const commitDrag = (order: ReadonlyArray<string> | undefined) => {
    const id = dragging;
    setDragging(undefined);
    if (id === undefined || order === undefined || selected === undefined) {
      setDragOrder(undefined);
      return;
    }
    const index = order.indexOf(id);
    // anchor on the neighbor the card landed against — one drag, one row
    const anchor =
      index + 1 < order.length
        ? { before: order[index + 1]! }
        : index > 0
          ? { after: order[index - 1]! }
          : undefined;
    if (anchor === undefined) {
      setDragOrder(undefined);
      return;
    }
    reorderTask(selected.slug, id, anchor)
      .then(() => refresh())
      .catch(() => {})
      .finally(() => setDragOrder(undefined));
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
            // done keeps its count; the column shows the last 5.
            // ready renders in RANK order (hint-then-age below it)
            const shown =
              state === "done"
                ? [...rows]
                    .sort((left, right) => right.updated - left.updated)
                    .slice(0, 5)
                : state === "ready"
                  ? readyRows(rows)
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
                      {...(state === "ready"
                        ? {
                            examined: examined.has(task.id),
                            onTrace: () =>
                              setTraceTask((current) =>
                                current === task.id ? undefined : task.id,
                              ),
                            cardRef: (element: HTMLDivElement | null) => {
                              if (element === null) {
                                cardRefs.current.delete(task.id);
                              } else {
                                cardRefs.current.set(task.id, element);
                              }
                            },
                          }
                        : {})}
                      {...(state === "ready" && tag === undefined
                        ? {
                            drag: {
                              onDragStart: () => {
                                setDragging(task.id);
                                setDragOrder(
                                  readyRows(rows).map((row) => row.id),
                                );
                              },
                              onDragOver: () => {
                                if (
                                  dragging !== undefined &&
                                  dragging !== task.id
                                ) {
                                  moveCard(dragging, task.id);
                                }
                              },
                              onDragEnd: () => commitDrag(dragOrder),
                            },
                          }
                        : {})}
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

      {/* the walk trace pane — one pick's decision chain, opened by
          a ready card's why line */}
      {(() => {
        if (traceTask === undefined || board === undefined) return null;
        const traced = BOARD_STATES.flatMap(
          (state) => board[state] ?? [],
        ).find((task) => task.id === traceTask);
        if (traced === undefined) return null;
        return (
          <WalkTracePanel
            task={traced}
            trace={
              walks?.walks.find((row) => row.task === traced.id)?.trace
            }
            onClose={() => setTraceTask(undefined)}
          />
        );
      })()}
    </section>
  );
};

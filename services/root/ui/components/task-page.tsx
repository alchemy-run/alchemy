/**
 * The TASK PAGE (`/tasks/:queue/:id`) — issue-shaped (issues.tsx's
 * layout): the big title with its state pill, a TIMELINE of the
 * task's lifecycle events (circled icons on the gutter line)
 * interleaved chronologically with the task's CONVERSATION (the
 * thread under `root_post` in the `tasks:<queue>` channel), a
 * metadata sidebar with the human's state actions, and the comment
 * box. An agent reply wears a "Worked for Xm ▸" chip that splits the
 * DESK session open as a pane (`?panes=a:<Term>:<deskKey>`).
 */
import { Avatar, HUMAN } from "@/components/avatar";
import { MarkdownText } from "@/components/chat";
import { type Post } from "@/components/post-thread";
import {
  elapsedOf,
  OriginChip,
  TagChip,
  TaskStateBadge,
  useQueues,
} from "@/components/task-board";
import {
  commentTask,
  deskSessionId,
  fetchTask,
  KNOWN_TAGS,
  retagTask,
  routeTask,
  TRANSITIONS,
  type TaskEventRow,
  type TaskRow,
  type TaskState,
} from "@/lib/tasks";
import { openPane, showDesk, showTasks } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ArrowRightLeft,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Eye,
  Loader2,
  PauseCircle,
  Play,
  Tag,
  UserPlus,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const PROSE =
  "text-[14px] leading-relaxed [&_p]:my-2.5 [&_p:first-child]:mt-0 " +
  "[&_p:last-child]:mb-0 [&_ul]:my-2 [&_li]:my-0.5 [&_pre]:my-3";

const age = (at: number): string => {
  const ms = Date.now() - at;
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  return hours > 0 ? `${hours}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
};

const kindOf = (author: string) =>
  author === HUMAN.name ? ("human" as const) : ("agent" as const);

/** A small EVENT on the timeline — issues.tsx's EventRow: the icon
 *  in a circle on the gutter line, one line of muted text. */
const EventRow = ({
  icon: Icon,
  tone = "muted",
  when,
  children,
}: {
  icon: typeof Play;
  tone?: "muted" | "merged" | "closed" | "open";
  when?: number;
  children: React.ReactNode;
}) => (
  <div className="relative flex items-center gap-3 py-0.5">
    <span
      className={cn(
        "z-[1] flex size-8 shrink-0 items-center justify-center rounded-full border",
        tone === "merged" && "border-transparent bg-purple-600 text-white",
        tone === "closed" && "border-transparent bg-red-700 text-white",
        tone === "open" && "border-transparent bg-green-700 text-white",
        tone === "muted" && "border-border bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-4" />
    </span>
    <span className="min-w-0 text-[13px] text-muted-foreground">
      {children}
      {when !== undefined && <> · {age(when)} ago</>}
    </span>
  </div>
);

/** One comment card — issues.tsx's TimelineComment shape. */
const CommentCard = ({
  author,
  when,
  chip,
  children,
}: {
  author: string;
  when: number;
  /** The header's trailing widget — the "Worked for Xm ▸" chip. */
  chip?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="relative flex gap-3">
    <div className="z-[1] shrink-0 pt-0.5">
      <Avatar name={author} kind={kindOf(author)} size={32} />
    </div>
    <div className="min-w-0 flex-1 rounded-md border border-border">
      <div className="flex items-center gap-2 rounded-t-md border-b border-border/70 bg-muted/40 px-3 py-1.5 text-xs">
        <span className="font-semibold">{author}</span>
        <span className="text-muted-foreground">
          commented {age(when)} ago
        </span>
        {chip !== undefined && <span className="ml-auto">{chip}</span>}
      </div>
      <div className={cn("px-3.5 py-3", PROSE)}>{children}</div>
    </div>
  </div>
);

const b = (text: string) => <b className="text-foreground">{text}</b>;

const dataOf = (event: TaskEventRow): Record<string, unknown> | string => {
  if (event.data === undefined) return {};
  try {
    return JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return event.data;
  }
};

const noteOf = (event: TaskEventRow): string | undefined => {
  const data = dataOf(event);
  return typeof data === "string" && data.length > 0 ? data : undefined;
};

/** One lifecycle event → its circled icon + line. `posted` events
 *  are skipped (the post itself is the card) and `filed` is the
 *  header's story. */
const TaskEvent = ({ event }: { event: TaskEventRow }) => {
  switch (event.kind) {
    case "routed": {
      const note = noteOf(event);
      return (
        <EventRow icon={ArrowRightLeft} when={event.at}>
          {b(event.actor)} routed this{note !== undefined && <> — {note}</>}
        </EventRow>
      );
    }
    case "assigned": {
      const data = dataOf(event);
      const desk = typeof data === "object" ? String(data.desk ?? "") : "";
      return (
        <EventRow icon={UserPlus} when={event.at}>
          {b(event.actor)} assigned {desk.length > 0 ? b(desk) : "a desk"}
        </EventRow>
      );
    }
    case "started":
      return (
        <EventRow icon={Play} when={event.at}>
          {b(event.actor)} started working
        </EventRow>
      );
    case "parked": {
      const note = noteOf(event);
      return (
        <EventRow icon={PauseCircle} when={event.at}>
          {b(event.actor)} parked this{note !== undefined && <> — {note}</>}
        </EventRow>
      );
    }
    case "tagged": {
      const data = dataOf(event);
      const tags =
        typeof data === "object" && Array.isArray(data.tags)
          ? data.tags.map(String)
          : [];
      return (
        <EventRow icon={Tag} when={event.at}>
          {b(event.actor)} retagged this
          {tags.length > 0 && (
            <>
              {" — "}
              <span className="inline-flex flex-wrap items-center gap-1 align-middle">
                {tags.map((candidate) => (
                  <TagChip key={candidate} tag={candidate} />
                ))}
              </span>
            </>
          )}
        </EventRow>
      );
    }
    case "review_requested":
      return (
        <EventRow icon={Eye} when={event.at}>
          {b(event.actor)} requested review
        </EventRow>
      );
    case "changes_requested":
      return (
        <EventRow icon={Eye} when={event.at}>
          {b(event.actor)} requested changes — back to the desk
        </EventRow>
      );
    case "approved":
      return (
        <EventRow icon={CheckCircle2} tone="open" when={event.at}>
          {b(event.actor)} approved
        </EventRow>
      );
    case "done":
      return (
        <EventRow icon={CheckCircle2} tone="merged" when={event.at}>
          {b(event.actor)} closed this as done
        </EventRow>
      );
    case "dropped":
      return (
        <EventRow icon={CircleSlash} tone="closed" when={event.at}>
          {b(event.actor)} dropped this
        </EventRow>
      );
    default:
      return null;
  }
};

/** The desk's own narration posts (`Picked up t-… at desk …`) draw
 *  as timeline events, not comment cards. */
const PICKUP_RE = /^(Picked up|Reviewing) \S+ at desk \S+\.$/;

/** One thing to draw, in time order. */
type Item =
  | { kind: "event"; key: string; at: number; event: TaskEventRow }
  | { kind: "pickup"; key: string; at: number; post: Post }
  | {
      kind: "comment";
      key: string;
      at: number;
      post: Post;
      /** The desk session behind an agent reply + how long it worked. */
      worked?: { session: string; span: number };
    };

export const TaskPage = ({ queue, id }: { queue: string; id: string }) => {
  const queues = useQueues();
  const [view, setView] = useState<
    { task: TaskRow; events: ReadonlyArray<TaskEventRow> } | undefined
  >();
  const [posts, setPosts] = useState<ReadonlyArray<Post>>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const desks = queues?.find((candidate) => candidate.slug === queue)?.desks;

  // the board row + timeline, polled — fast while the desk works it
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetchTask(queue, id)
        .then((next) => {
          if (!alive) return;
          setView(next);
          timer = setTimeout(
            load,
            next.task.state === "working" ? 2_000 : 6_000,
          );
        })
        .catch(() => {
          if (alive) timer = setTimeout(load, 6_000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [queue, id]);

  // the conversation — the thread under root_post (chat machinery)
  const rootPost = view?.task.rootPost;
  useEffect(() => {
    if (rootPost === undefined) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/posts/${encodeURIComponent(rootPost)}`)
        .then(async (response) => {
          if (!alive || !response.ok) return;
          const body = (await response.json()) as {
            post: Post;
            replies: ReadonlyArray<Post>;
          };
          setPosts(body.replies);
          timer = setTimeout(load, 4_000);
        })
        .catch(() => {
          if (alive) timer = setTimeout(load, 8_000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [rootPost]);

  const items = useMemo((): ReadonlyArray<Item> => {
    if (view === undefined) return [];
    const rows: Array<Item> = [];
    for (const event of view.events) {
      if (event.kind === "posted" || event.kind === "filed") continue;
      rows.push({ kind: "event", key: `e-${event.id}`, at: event.at, event });
    }
    // pickups mark where a desk round began — the reply that follows
    // one (same author) carries "Worked for <span>" back to its desk
    const lastPickup = new Map<string, Post>();
    for (const post of posts) {
      if (PICKUP_RE.test(post.text.trim())) {
        lastPickup.set(post.author, post);
        rows.push({ kind: "pickup", key: post.id, at: post.at, post });
        continue;
      }
      const pickup = lastPickup.get(post.author);
      const desk = desks?.find((candidate) => candidate.slug === post.author);
      rows.push({
        kind: "comment",
        key: post.id,
        at: post.at,
        post,
        ...(pickup !== undefined && desk !== undefined
          ? {
              worked: {
                session: deskSessionId(desk),
                span: post.at - pickup.at,
              },
            }
          : {}),
      });
      lastPickup.delete(post.author);
    }
    return rows.sort((left, right) => left.at - right.at);
  }, [view, posts, desks]);

  if (view === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        loading {id}…
      </div>
    );
  }
  const { task, events } = view;
  const filed = events.find((event) => event.kind === "filed");
  const desk = desks?.find((candidate) => candidate.slug === task.desk);
  const move = (state: TaskState, data?: string) => {
    setBusy(true);
    routeTask(queue, id, state, data === undefined ? {} : { data })
      .then(() => fetchTask(queue, id).then(setView))
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const submit = () => {
    setBusy(true);
    commentTask(queue, id, draft)
      .then(() => setDraft(""))
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const allowed = TRANSITIONS[task.state];

  return (
    <section
      aria-label={`task ${id}`}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
    >
      {/* the header — title, state, the filing line */}
      <div className="border-b border-border">
        <div className="mx-auto w-full max-w-6xl px-6 pb-4 pt-5">
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={() => showTasks(queue)}
              aria-label="back to the board"
              className="mt-1.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-accent"
            >
              <ArrowLeft className="size-4" />
            </button>
            <h1 className="min-w-0 text-[26px] font-normal leading-snug">
              {task.title}{" "}
              <span className="font-mono text-[15px] font-light text-muted-foreground">
                {task.id}
              </span>
            </h1>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-9 text-sm text-muted-foreground">
            <TaskStateBadge state={task.state} />
            <span>
              filed by{" "}
              <span className="font-semibold text-foreground">
                {filed?.actor ?? "unknown"}
              </span>{" "}
              {age(task.at)} ago · queue{" "}
              <span className="font-mono text-xs">{task.queue}</span>
            </span>
            {task.origin !== undefined && <OriginChip origin={task.origin} />}
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-6xl items-start gap-8 px-6 py-5">
        {/* the timeline: the body first, then events + conversation
            interleaved on the gutter line */}
        <div className="relative min-w-0 flex-1 before:absolute before:bottom-0 before:left-4 before:top-2 before:w-px before:bg-border">
          <div className="flex flex-col gap-4">
            <CommentCard author={filed?.actor ?? "unknown"} when={task.at}>
              <MarkdownText
                text={
                  task.body.length > 0 ? task.body : "*No description provided.*"
                }
              />
            </CommentCard>
            {items.map((item) =>
              item.kind === "event" ? (
                <TaskEvent key={item.key} event={item.event} />
              ) : item.kind === "pickup" ? (
                <EventRow key={item.key} icon={Play} when={item.at}>
                  {b(item.post.author)}{" "}
                  {item.post.text.startsWith("Reviewing")
                    ? "began the review"
                    : "picked this up"}
                </EventRow>
              ) : (
                <CommentCard
                  key={item.key}
                  author={item.post.author}
                  when={item.at}
                  chip={
                    item.worked === undefined ? undefined : (
                      <button
                        type="button"
                        onClick={() =>
                          openPane({
                            kind: "agent",
                            id: item.worked!.session,
                          })
                        }
                        title="open the desk session that did this work"
                        className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <Wrench className="size-3 shrink-0" />
                        Worked for {elapsedOf(item.worked.span)}
                        <ChevronRight className="size-3 shrink-0" />
                      </button>
                    )
                  }
                >
                  <MarkdownText text={item.post.text} />
                </CommentCard>
              ),
            )}
            {task.state === "working" && (
              <EventRow icon={Loader2} when={task.updated}>
                <button
                  type="button"
                  disabled={desk === undefined}
                  onClick={() =>
                    desk !== undefined &&
                    openPane({ kind: "agent", id: deskSessionId(desk) })
                  }
                  title="watch the desk session working this task"
                  className="group/working flex cursor-pointer items-center gap-1.5 disabled:cursor-default"
                >
                  {b(task.desk ?? "the desk")} is working
                  <Loader2 className="size-3 animate-spin text-primary/70" />
                  <ChevronRight className="size-3 shrink-0 opacity-0 transition-opacity group-hover/working:opacity-100" />
                </button>
              </EventRow>
            )}

            {/* the comment box — into the task's thread */}
            <div className="relative flex gap-3 pt-2">
              <div className="z-[1] shrink-0 pt-0.5">
                <Avatar name={HUMAN.name} kind="human" size={32} />
              </div>
              <div className="min-w-0 flex-1 rounded-md border border-border">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Add your comment here…"
                  rows={3}
                  className="w-full resize-y bg-transparent px-3.5 py-2.5 text-sm outline-none"
                />
                <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2">
                  <button
                    type="button"
                    disabled={busy || draft.trim().length === 0}
                    onClick={submit}
                    className="cursor-pointer rounded-md bg-green-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-600 disabled:opacity-50"
                  >
                    Comment
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* the sidebar — queue, desk, origin, the human's overrides */}
        <aside className="sticky top-4 hidden w-60 shrink-0 flex-col gap-5 text-xs lg:flex">
          <div>
            <div className="pb-1.5 font-semibold text-muted-foreground">
              Queue
            </div>
            <button
              type="button"
              onClick={() => showTasks(queue)}
              className="cursor-pointer font-mono text-[12px] hover:underline"
            >
              {task.queue}
            </button>
          </div>
          <div>
            <div className="pb-1.5 font-semibold text-muted-foreground">
              Tags
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {task.tags.length === 0 ? (
                <span className="text-muted-foreground">untagged</span>
              ) : (
                task.tags.map((candidate) => (
                  <TagChip key={candidate} tag={candidate} />
                ))
              )}
              <button
                type="button"
                disabled={busy}
                title={`retag — comma-separated (${KNOWN_TAGS.join(", ")})`}
                onClick={() => {
                  const raw = window.prompt(
                    `Tags, comma-separated (${KNOWN_TAGS.join(", ")}):`,
                    task.tags.join(", "),
                  );
                  if (raw === null) return;
                  const tags = raw
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0);
                  setBusy(true);
                  retagTask(queue, id, tags)
                    .then(() => fetchTask(queue, id).then(setView))
                    .catch(() => {})
                    .finally(() => setBusy(false));
                }}
                className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <Tag className="size-3" />
                retag
              </button>
            </div>
          </div>
          <div>
            <div className="pb-1.5 font-semibold text-muted-foreground">
              Desk
            </div>
            {task.desk === undefined ? (
              <span className="text-muted-foreground">not assigned yet</span>
            ) : (
              <button
                type="button"
                onClick={() => showDesk(queue, task.desk!)}
                className="flex cursor-pointer items-center gap-1.5 font-mono text-[12px] hover:underline"
              >
                <Avatar name={task.desk} kind="agent" size={18} />
                {task.desk}
                {desk?.working === task.id && (
                  <Loader2 className="size-3 animate-spin text-primary/70" />
                )}
              </button>
            )}
          </div>
          <div>
            <div className="pb-1.5 font-semibold text-muted-foreground">
              Origin
            </div>
            {task.origin === undefined ? (
              <span className="text-muted-foreground">filed directly</span>
            ) : (
              <OriginChip origin={task.origin} />
            )}
          </div>
          {task.parkedReason !== undefined && (
            <div>
              <div className="pb-1.5 font-semibold text-muted-foreground">
                Parked
              </div>
              <span className="text-amber-500">{task.parkedReason}</span>
            </div>
          )}
          {allowed.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="font-semibold text-muted-foreground">
                Actions
              </div>
              {allowed.includes("parked") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt("Park it — why?");
                    if (reason !== null) move("parked", reason);
                  }}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                >
                  <PauseCircle className="size-3.5 text-amber-500" />
                  Park…
                </button>
              )}
              {allowed.includes("inbox") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => move("inbox")}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                >
                  <ArrowRightLeft className="size-3.5" />
                  Reroute to inbox
                </button>
              )}
              {allowed.includes("ready") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => move("ready")}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                >
                  <Play className="size-3.5 text-moss" />
                  Mark ready
                </button>
              )}
              {allowed.includes("dropped") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => move("dropped")}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                >
                  <CircleSlash className="size-3.5 text-red-400" />
                  Close as dropped
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
};

/**
 * The conversation — a channel is a stream of THREADS.
 *
 * Storage stays a FLAT list of {@link Post}s; the thread is DERIVED:
 * a message's thread is found by walking its `replyTo` chain to the
 * message that started it (the human's channel message). The channel
 * renders one collapsible {@link ThreadBlock} per root — the root
 * message on the outside, the whole conversation it caused (asks,
 * answers, the agent's conclusion) flat and chronological inside.
 *
 * Structure inside a thread is never drawn as shape — a message that
 * answers another carries `replyTo`, and the renderer shows a
 * discord-style REPLY REFERENCE (tiny avatar, name, first line;
 * click scrolls to the referenced message) only when the answered
 * message is NOT the row directly above (linear flow needs no
 * reference):
 *
 * ```
 * sam: Ask the reviewer to say hello.        ← thread root
 * │ manager:  @reviewer say hello…           ← inside the thread
 * │ reviewer: Hello!
 * │ ╭─ sam: Ask the reviewer to say hello.
 * │ manager:  Done.
 * ```
 */
import { Avatar, HUMAN, sessionOf } from "@/components/avatar";
import { formatAt, MarkdownText } from "@/components/chat";
import { PaneContext } from "@/components/pane-context";
import { openPane, showOverlay, showThread } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  FolderPlus,
  FolderTree,
  Loader2,
  MessageSquare,
  Wrench,
} from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";

/** The MESSAGE a rendered element belongs to. Worker roles answer
 *  each message in its own session, so: the AUTHOR of a reply is
 *  opened at the message's `replyTo` (the invocation that produced
 *  it), while an `@mention` inside a message is opened at the
 *  message's own id (the invocation that ask created). */
export const MessageContext = createContext<
  { readonly id: string; readonly replyTo?: string } | undefined
>(undefined);

export interface Post {
  readonly id: string;
  /** The message this one answers — a reference, not a tree edge. */
  readonly replyTo?: string;
  readonly channel?: string;
  readonly author: string;
  /** `ask` delegates via its `@mentions`; `message` is an answer or
   *  a plain statement. */
  readonly kind: "message" | "ask";
  readonly text: string;
  readonly status: "running" | "settled" | "failed";
  /** While running, the agent this message is waiting on. */
  readonly answering?: string;
  /** How the gate routed it — `thread` opens a shell immediately. */
  readonly mode?: "thread" | "inline";
  readonly at: number;
}

const firstLineOf = (text: string, max = 80): string => {
  // a one-line PLAIN preview — drop markdown emphasis/heading markers
  const line = (text.split("\n", 1)[0] ?? "").replace(/[*_`#]/g, "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const kindOf = (name: string) => (name === HUMAN.name ? "human" : "agent");

/** An author's avatar — clicking it (like the name) opens the
 *  agent's session: the thread's, for worker roles inside a thread. */
export const AuthorAvatar = ({
  name,
  size = 24,
}: {
  name: string;
  size?: number;
}) => {
  const message = useContext(MessageContext);
  const session = sessionOf(name, message?.replyTo);
  const avatar = <Avatar name={name} kind={kindOf(name)} size={size} />;
  return session === undefined ? (
    avatar
  ) : (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        showOverlay({ kind: "agent", id: session });
      }}
      title={`open ${name}'s session`}
      className="shrink-0 cursor-pointer rounded-full hover:ring-2 hover:ring-primary/50"
    >
      {avatar}
    </button>
  );
};

/** An author's name — clicking opens the session that produced this
 *  message (the invocation it answers, for worker roles). */
const Name = ({ name }: { name: string }) => {
  const message = useContext(MessageContext);
  const session = sessionOf(name, message?.replyTo);
  return session === undefined ? (
    <span className="font-mono text-[12px] font-semibold">{name}</span>
  ) : (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        showOverlay({ kind: "agent", id: session });
      }}
      title={`open ${name}'s session`}
      className="cursor-pointer font-mono text-[12px] font-semibold hover:underline"
    >
      {name}
    </button>
  );
};

/** A mention chip — how the text itself addresses someone: the
 *  session it opens is the one THIS message's ask created. */
export const Mention = ({ name }: { name: string }) => {
  const message = useContext(MessageContext);
  const session = sessionOf(name, message?.id);
  return (
    <button
      type="button"
      disabled={session === undefined}
      onClick={
        session === undefined
          ? undefined
          : (event) => {
              event.stopPropagation();
              showOverlay({ kind: "agent", id: session });
            }
      }
      title={session === undefined ? undefined : `open ${name}'s session`}
      className={cn(
        "shrink-0 rounded bg-primary/15 px-1 font-mono text-[11px] font-medium text-primary",
        session !== undefined && "cursor-pointer hover:bg-primary/25",
      )}
    >
      @{name}
    </button>
  );
};

/** Ask every thread to reveal `id` — the block containing it expands
 *  and scrolls it into view. Unclaimed reveals retry briefly, so a
 *  reveal fired across a channel navigation lands once the feed
 *  mounts. */
export const revealPost = (id: string, tries = 8) => {
  const event = new CustomEvent("reveal-post", {
    detail: { id },
    cancelable: true,
  });
  window.dispatchEvent(event);
  if (!event.defaultPrevented && tries > 0) {
    setTimeout(() => revealPost(id, tries - 1), 300);
  }
};

/** Discord's reply header — the message this one answers: ╭─
 *  connector, tiny avatar, name, first line. Clicking reveals the
 *  referenced message. */
const ReplyRef = ({ target }: { target: Post }) => (
  <button
    type="button"
    onClick={() => revealPost(target.id)}
    title="jump to the message this replies to"
    className="relative mb-0.5 flex min-w-0 cursor-pointer items-center gap-1.5 pl-8 text-[11px] text-muted-foreground hover:text-foreground"
  >
    {/* the connector: down-left toward the avatar underneath */}
    <span
      aria-hidden
      className="pointer-events-none absolute -bottom-0.5 left-3 top-[7px] w-4 rounded-tl-[6px] border-l border-t border-muted-foreground/40"
    />
    <Avatar name={target.author} kind={kindOf(target.author)} size={16} />
    <span className="shrink-0 font-mono font-semibold">{target.author}</span>
    <span className="min-w-0 truncate">{firstLineOf(target.text)}</span>
  </button>
);

/** A `#<message-id>` reference in text — a chip like the `@mention`
 *  (message icon, author, first words). Clicking NEVER replaces the
 *  view: the referenced thread opens as a pane RIGHT-ADJACENT to
 *  wherever the click happened (the stack's end from the feed or the
 *  center thread; right of the source pane from inside the stack),
 *  and the message scrolls into view there. The chain only grows. */
export const PostRef = ({ id }: { id: string }) => {
  const source = useContext(PaneContext);
  const [target, setTarget] = useState<
    { post: Post; thread: string } | undefined
  >(undefined);
  useEffect(() => {
    let live = true;
    fetch(`/api/posts/${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (!live || !response.ok) return;
        const body = (await response.json()) as {
          post: Post;
          thread?: string;
        };
        setTarget({ post: body.post, thread: body.thread ?? body.post.id });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        // the message lives in a thread — split it open beside the
        // click, then ask the pane to scroll it into view
        if (target !== undefined) {
          openPane(
            {
              kind: "post",
              channel: target.post.channel ?? "root",
              id: target.thread,
            },
            { after: source },
          );
        }
        revealPost(id);
      }}
      title="jump to this message"
      className="inline-flex max-w-64 cursor-pointer items-center gap-1 rounded bg-primary/15 px-1 align-text-bottom font-mono text-[11px] font-medium text-primary hover:bg-primary/25"
    >
      <MessageSquare className="size-3 shrink-0" />
      {target === undefined ? (
        <span className="min-w-0 truncate">#{id}</span>
      ) : (
        <>
          <span className="shrink-0 font-semibold">{target.post.author}</span>
          <span className="min-w-0 truncate font-sans font-normal">
            {firstLineOf(target.post.text, 48)}
          </span>
        </>
      )}
    </button>
  );
};

/**
 * Who a running message is waiting on. The gate routes each message to
 * whoever is closest to it, so the answer can come from someone other
 * than the channel's usual voice — naming them is the difference
 * between "something is happening" and "the engineer picked this up".
 * Falls back to a bare spinner for messages written before routing.
 */
export const Typing = ({ name }: { readonly name?: string }) =>
  name === undefined ? (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/80">
      <Loader2 className="size-3 shrink-0 animate-spin" />
      <span>routing</span>
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-primary/80">
      <span className="font-medium">{name}</span>
      <span>is typing</span>
      <span className="inline-flex items-end gap-[2px] pb-[2px]">
        {[0, 160, 320].map((delay) => (
          <span
            key={delay}
            className="size-[3px] animate-bounce rounded-full bg-current"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
    </span>
  );

/** In-flight exchanges older than this render nothing: a fiber that
 *  died in a reload never settles its post, and a pill that types
 *  forever is a lie. */
const TYPING_STALE_MS = 10 * 60_000;

/**
 * The typing indicator as an INCOMING message — the agent's own row
 * forming under the human's message, never a badge on the human's
 * header.
 */
export const TypingRow = ({
  post,
  indent = true,
}: {
  readonly post: Post;
  readonly indent?: boolean;
}) => {
  if (post.status !== "running") return null;
  if (Date.now() - post.at > TYPING_STALE_MS) return null;
  return (
    <div className={cn("mt-1.5 flex items-center gap-1.5", indent && "ml-8")}>
      {post.answering !== undefined && (
        <Avatar name={post.answering} kind="agent" size={16} />
      )}
      <span className="flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5">
        <Typing name={post.answering} />
      </span>
    </div>
  );
};

/** One message of the stream. */
export const PostRow = ({
  post,
  reference,
  header = true,
  refHidden = false,
}: {
  post: Post;
  /** The message this one answers, when it should be shown. */
  reference?: Post;
  /** Show the author header (off when the enclosing context already
   *  named the author). */
  header?: boolean;
  /** Hide the reply-reference arc (the referenced message is the
   *  thread's ROOT, pinned right above the stream). */
  refHidden?: boolean;
}) => (
  <MessageContext.Provider
    value={{
      id: post.id,
      ...(post.replyTo !== undefined ? { replyTo: post.replyTo } : {}),
    }}
  >
    <div data-post-id={post.id} className="min-w-0">
      {reference !== undefined && !refHidden && <ReplyRef target={reference} />}
      {header && (
        <div className="flex items-center gap-2">
          <AuthorAvatar name={post.author} />
          <Name name={post.author} />
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {formatAt(post.at)}
          </span>
          {post.status === "failed" && (
            <span className="shrink-0 text-[11px] text-destructive">
              failed
            </span>
          )}
        </div>
      )}
      {post.text.length > 0 && (
        <div className={cn("min-w-0 text-[13px]", header && "ml-8")}>
          <MarkdownText text={post.text} />
        </div>
      )}
      <Working post={post} parent={reference} />
      <TypingRow post={post} />
    </div>
  </MessageContext.Provider>
);

/** One step of an agent's working — a thought or a tool call. */
/** A duration, compact: `4s`, `1m 32s`, `1h 4m`. */
const spanOf = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** The current second, ticking — for live "Working for …" rows. */
const useNow = (live: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
};

/** One clickable working row — opens the session doing the work. */
const WorkRow = ({
  session,
  live,
  label,
  bare = false,
}: {
  session: string;
  live: boolean;
  label: string;
  /** Inside a wrapper that owns the margins (the pills row). */
  bare?: boolean;
}) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      showOverlay({ kind: "agent", id: session });
    }}
    title="open the working"
    className={cn(
      "flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground",
      !bare && "ml-8 mt-1",
    )}
  >
    {live ? (
      <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
    ) : (
      <Wrench className="size-3 shrink-0" />
    )}
    <span className={cn(live && "animate-pulse")}>{label}</span>
    <ChevronRight className="size-3 shrink-0" />
  </button>
);

/**
 * The WORK behind a message — a clickable duration, not a wall of
 * chips. The THREAD is the record of the conversation; a settled
 * reply gets a "Worked for 42s" row ONLY when its session did
 * something beyond conversing (real tool calls — reading files,
 * running commands, making workspaces). A reply whose round was
 * think-and-talk shows nothing: everything it did is the thread.
 * While an ask's targets are still answering, each shows a live
 * "working for 12s…" spinner. Clicking either opens the session.
 */
const Working = ({
  post,
  parent,
}: {
  post: Post;
  /** The message `post` answers, when the list knows it. */
  parent?: Post;
}) => {
  const running = post.kind === "ask" && post.status === "running";
  const now = useNow(running);
  const session = sessionOf(post.author, post.replyTo);
  const eligible =
    !running &&
    post.kind === "message" &&
    session !== undefined &&
    parent !== undefined;
  // did the round DO anything nonpublic? Conversing (ask/tell) is
  // the thread's record — only other tool calls count as working.
  // The same pass collects the round's WORKSPACES: the ones it
  // CREATED (the workspace tool) and the ones it WORKED IN (every
  // `@name/…` a tool input addressed).
  const [work, setWork] = useState<
    | {
        readonly worked: boolean;
        readonly created: ReadonlyArray<string>;
        readonly touched: ReadonlyArray<string>;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (!eligible || session === undefined) return;
    let live = true;
    fetch(`/api/chats/${encodeURIComponent(session)}/messages`)
      .then(async (response) => {
        if (!live || !response.ok) return;
        const messages = (await response.json()) as Array<{
          parts?: Array<{
            type: string;
            toolName?: string;
            input?: unknown;
            output?: unknown;
          }>;
        }>;
        let worked = false;
        // CONVERSING and finding one's footing are the thread's
        // record (asks are posts, workspaces are pills) — only tools
        // beyond them make a round "worked": reading code, running
        // commands, editing, pushing
        const FOOTING = new Set([
          "ask",
          "tell",
          "explore",
          "workspace",
          "list_workspaces",
        ]);
        const created = new Set<string>();
        const touched = new Set<string>();
        for (const message of messages) {
          for (const part of message.parts ?? []) {
            if (part.type !== "dynamic-tool") continue;
            const name = part.toolName ?? "";
            if (name === "ask" || name === "tell") continue;
            if (!FOOTING.has(name)) worked = true;
            if (name === "workspace") {
              const output =
                typeof part.output === "string"
                  ? (() => {
                      try {
                        return JSON.parse(part.output) as {
                          name?: unknown;
                        };
                      } catch {
                        return undefined;
                      }
                    })()
                  : (part.output as { name?: unknown } | undefined);
              const made =
                typeof output?.name === "string"
                  ? output.name
                  : typeof (part.input as { name?: unknown } | undefined)
                        ?.name === "string"
                    ? (part.input as { name: string }).name
                    : undefined;
              if (made !== undefined) created.add(made);
              continue;
            }
            if (name === "list_workspaces") continue;
            // every `@name/…` (or bare `@name`) a tool input
            // addressed — the workspaces this round worked in
            for (const match of JSON.stringify(part.input ?? {}).matchAll(
              /@([a-zA-Z0-9._-]+)(?=\/|["\s])/g,
            )) {
              touched.add(match[1]!);
            }
          }
        }
        for (const name of created) touched.delete(name);
        setWork({
          worked,
          created: [...created],
          touched: [...touched],
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [eligible, session, post.id]);
  // an ask still being answered: one live row per mentioned worker,
  // each opening the session that ask created
  if (running) {
    const workers = mentionsOf(post.text)
      .map((name) => ({ name, session: sessionOf(name, post.id) }))
      .filter(
        (worker): worker is { name: string; session: string } =>
          worker.session !== undefined,
      );
    return (
      <>
        {workers.map((worker) => (
          <WorkRow
            key={worker.name}
            session={worker.session}
            live
            label={`${worker.name} — working for ${spanOf(now - post.at)}…`}
          />
        ))}
      </>
    );
  }
  if (
    !eligible ||
    session === undefined ||
    parent === undefined ||
    work === undefined ||
    (!work.worked && work.created.length === 0 && work.touched.length === 0)
  ) {
    return null;
  }
  return (
    <div className="ml-8 mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      {work.worked && (
        <WorkRow
          session={session}
          live={false}
          label={`Worked for ${spanOf(post.at - parent.at)}`}
          bare
        />
      )}
      {work.created.map((name) => (
        <WorkspacePill key={`c-${name}`} name={name} created />
      ))}
      {work.touched.map((name) => (
        <WorkspacePill key={`t-${name}`} name={name} />
      ))}
    </div>
  );
};

/** A workspace the round CREATED (folder+) or WORKED IN (folder) —
 *  a pill opening the workspace's terminal overlay. */
const WorkspacePill = ({
  name,
  created = false,
}: {
  name: string;
  created?: boolean;
}) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      showOverlay({ kind: "workspace", name });
    }}
    title={
      created
        ? `workspace "${name}" — created by this work`
        : `workspace "${name}" — worked in`
    }
    // the AGENT badge's green (the theme primary) — a workspace is
    // where the work lives; it must stand out from the prose
    className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-primary/40 bg-primary/15 px-1.5 py-px font-mono text-[10px] font-medium text-primary hover:border-primary/70 hover:bg-primary/25"
  >
    {created ? (
      <FolderPlus className="size-3 shrink-0" />
    ) : (
      <FolderTree className="size-3 shrink-0" />
    )}
    {name}
  </button>
);

/**
 * The stream — flat, chronological, every message its own row. A
 * message with `replyTo` draws its reply reference whenever the
 * target is known (`context` supplies targets outside the list, e.g.
 * the thread's root) — the reply graph stays visible over the linear
 * sequence.
 */
export const PostList = ({
  posts,
  context = [],
  suppressRef,
}: {
  posts: ReadonlyArray<Post>;
  /** Messages a reference may point at that aren't rows of the list. */
  context?: ReadonlyArray<Post>;
  /** No ARC for replies to this message (the thread's root — pinned
   *  above the stream, referencing it is noise). */
  suppressRef?: string;
}) => {
  const byId = new Map(
    [...context, ...posts].map((post) => [post.id, post] as const),
  );
  return (
    <div className="min-w-0">
      {posts.map((post, index) => {
        const reference =
          post.replyTo === undefined ? undefined : byId.get(post.replyTo);
        return (
          <div key={post.id} className={cn("min-w-0", index > 0 && "mt-3")}>
            <PostRow
              post={post}
              reference={reference}
              refHidden={
                reference !== undefined && reference.id === suppressRef
              }
            />
          </div>
        );
      })}
    </div>
  );
};

/** A thread of the channel: the message that started it + everything
 *  it caused, chronological. */
export interface Thread {
  readonly root: Post;
  readonly posts: ReadonlyArray<Post>;
}

/**
 * Group a channel's flat stream into threads: each message's root is
 * found by walking its `replyTo` chain; a message whose chain doesn't
 * resolve (reference outside the channel, or none) starts its own
 * thread. Threads are ordered by their root; posts inside stay in
 * stream order.
 */
export const threadsOf = (
  posts: ReadonlyArray<Post>,
): ReadonlyArray<Thread> => {
  const byId = new Map(posts.map((post) => [post.id, post] as const));
  const rootOf = (post: Post): Post => {
    let current = post;
    const seen = new Set<string>([current.id]);
    while (current.replyTo !== undefined) {
      const parent = byId.get(current.replyTo);
      if (parent === undefined || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, { root: Post; posts: Post[] }>();
  for (const post of posts) {
    const root = rootOf(post);
    const thread = threads.get(root.id);
    if (thread === undefined) {
      threads.set(root.id, { root, posts: [post] });
    } else {
      thread.posts.push(post);
    }
  }
  return [...threads.values()];
};

/**
 * One thread of the FEED — the root message, and (discord's move) an
 * ELBOW into a compact card naming the conversation it caused:
 * message count, a preview of the latest message, a live spinner
 * while agents work. Threads are CLICKED INTO — the card opens the
 * thread as the main view; nothing expands inline.
 */
export const ThreadCard = ({ thread }: { thread: Thread }) => {
  const replies = thread.posts.filter((post) => post.id !== thread.root.id);
  const live = thread.posts.some((post) => post.status === "running");
  const last = replies[replies.length - 1];
  const open = () => showThread(thread.root.channel ?? "root", thread.root.id);
  return (
    <MessageContext.Provider value={{ id: thread.root.id }}>
      <div className="relative min-w-0">
        <div data-post-id={thread.root.id} className="flex items-center gap-2">
          <AuthorAvatar name={thread.root.author} />
          <Name name={thread.root.author} />
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {formatAt(thread.root.at)}
          </span>
          {thread.root.status === "failed" && (
            <span className="shrink-0 text-[11px] text-destructive">
              failed
            </span>
          )}
        </div>
        {thread.root.text.length > 0 && (
          <div className="ml-8 min-w-0 text-[13px]">
            <MarkdownText text={thread.root.text} />
          </div>
        )}
        {replies.length === 0 && thread.root.mode !== "thread" && (
          <TypingRow post={thread.root} />
        )}
        {(replies.length > 0 ||
          (thread.root.mode === "thread" &&
            thread.root.status === "running")) && (
          <div className="relative ml-8 mt-1.5 min-w-0">
            {/* the elbow — from under the root's avatar into the card */}
            <span
              aria-hidden
              className="pointer-events-none absolute -left-[12.5px] -top-1 bottom-[55%] w-4 rounded-bl-[8px] border-b border-l border-muted-foreground/40"
            />
            <button
              type="button"
              onClick={open}
              title="open this thread"
              className="flex min-w-0 max-w-xl cursor-pointer flex-col gap-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-left hover:border-border hover:bg-muted/50"
            >
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-primary">
                {replies.length === 0
                  ? "thread"
                  : `${replies.length} ${replies.length === 1 ? "message" : "messages"}`}
                <ChevronRight className="size-3 shrink-0" />
                {live && replies.length > 0 && (
                  <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
                )}
              </span>
              {replies.length === 0 && (
                <TypingRow post={thread.root} indent={false} />
              )}
              {last !== undefined && (
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Avatar
                    name={last.author}
                    kind={kindOf(last.author)}
                    size={16}
                  />
                  <span className="shrink-0 font-mono font-semibold">
                    {last.author}
                  </span>
                  <span className="min-w-0 truncate">
                    {firstLineOf(last.text) || "…"}
                  </span>
                </span>
              )}
            </button>
          </div>
        )}
      </div>
    </MessageContext.Provider>
  );
};

/** A message and its direct replies — live while anything runs. The
 *  transcript drill-down's ask card. */
export const PostThread = ({
  id,
  speaker,
}: {
  id: string;
  /** The author already named by the enclosing message. */
  speaker?: string;
}) => {
  const [thread, setThread] = useState<
    { post: Post; replies: ReadonlyArray<Post> } | undefined
  >(undefined);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/posts/${encodeURIComponent(id)}`)
        .then(async (response) => {
          if (!live || !response.ok) return;
          const next = (await response.json()) as {
            post: Post;
            replies: ReadonlyArray<Post>;
          };
          setThread(next);
          const running =
            next.post.status === "running" ||
            next.replies.some((reply) => reply.status === "running");
          if (running) timer = setTimeout(load, 2_000);
        })
        .catch(() => {
          if (live) timer = setTimeout(load, 5_000);
        });
    };
    load();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [id]);

  if (thread === undefined) {
    return (
      <div className="text-[11px] text-muted-foreground">
        loading the thread…
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <PostRow post={thread.post} header={thread.post.author !== speaker} />
      {thread.replies.map((reply) => (
        <div key={reply.id} className="mt-3 min-w-0">
          <PostRow post={reply} />
        </div>
      ))}
    </div>
  );
};

/**
 * A post still being written — the mentioned agents stand in as
 * pending rows until their posts land.
 */
export const PendingPost = ({
  text,
  agents,
  stopped,
}: {
  text: string;
  agents: ReadonlyArray<string>;
  stopped: boolean;
}) => (
  <div className="min-w-0">
    <div className="min-w-0 text-[13px]">
      <MarkdownText text={text} />
    </div>
    {agents.map((agent) => (
      <div
        key={agent}
        className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"
      >
        <Avatar name={agent} kind="agent" size={24} />
        <span className="font-mono text-[12px] font-semibold">{agent}</span>
        {stopped ? (
          <span className="text-destructive">
            stopped — the round ended before this answer
          </span>
        ) : (
          <>
            <Loader2 className="size-3 animate-spin" />
            <span className="animate-pulse">is answering…</span>
          </>
        )}
      </div>
    ))}
  </div>
);

/** How agents address each other in text — mirrors chat/Ask.ts. */
export const MENTION_RE = /(?<![\w@.])@([a-z][a-z0-9-]{0,40})\b/g;

export const mentionsOf = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(MENTION_RE)].map((match) => match[1]!)),
];

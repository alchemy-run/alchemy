/**
 * A CHANNEL — a stream of THREADS, clicked into like discord's.
 *
 * The feed is `GET /api/posts?channel=`: a flat, chronological list
 * of every stored message, grouped into threads at render time
 * ({@link threadsOf} walks each message's `replyTo` chain to the
 * human message that started it). The feed shows one {@link
 * ThreadCard} per root — the root message and a compact card naming
 * the conversation; the card OPENS the thread ({@link ThreadView},
 * discord's side panel), where the composer speaks INTO the thread.
 * Thinking and tool execution live in the agent's drill-down
 * (`?agent=`), not in the feed.
 */
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { InputGroupAddon } from "@/components/ui/input-group";
import {
  AuthorAvatar,
  PostList,
  ThreadCard,
  MessageContext,
  threadsOf,
  Typing,
  TypingRow,
  type Post,
} from "@/components/post-thread";
import { formatAt, MarkdownText } from "@/components/chat";
import { interruptChat } from "@/lib/channel";
import { cn } from "@/lib/utils";
import { showChannel, showOverlay } from "@/lib/routes";
import {
  ChevronDown,
  ChevronRight,
  FolderTree,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const isLive = (post: Post): boolean => post.status === "running";

/** The channel's stored stream, polled — fast while anything runs. */
export interface Association {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly confidence: number;
  readonly provenance: string;
}

const useChannelPosts = (channel: string) => {
  const [posts, setPosts] = useState<ReadonlyArray<Post> | undefined>(
    undefined,
  );
  const [edges, setEdges] = useState<ReadonlyArray<Association>>([]);
  useEffect(() => {
    let open = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/posts?channel=${encodeURIComponent(channel)}`)
        .then(async (response) => {
          if (!open || !response.ok) return;
          const body = (await response.json()) as { posts: Post[] };
          setPosts(body.posts);
          fetch(`/api/edges?channel=${encodeURIComponent(channel)}`)
            .then(async (r) => {
              if (open && r.ok) setEdges((await r.json()) as Association[]);
            })
            .catch(() => {});
          timer = setTimeout(load, body.posts.some(isLive) ? 1_500 : 5_000);
        })
        .catch(() => {
          if (open) timer = setTimeout(load, 5_000);
        });
    };
    load();
    return () => {
      open = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [channel]);
  const refresh = () => {
    fetch(`/api/posts?channel=${encodeURIComponent(channel)}`)
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { posts: Post[] };
        setPosts(body.posts);
      })
      .catch(() => {});
  };
  return { posts, edges, refresh };
};

/** The message box — a new thread root, or (with `replyTo`) a
 *  message INTO a thread. */
const Composer = ({
  channel,
  chat,
  replyTo,
  placeholder,
  live,
  onSent,
}: {
  channel: string;
  chat: string;
  replyTo?: string;
  placeholder: string;
  live: boolean;
  onSent: () => void;
}) => {
  const send = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text) return;
    void fetch(`/api/channels/${encodeURIComponent(channel)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        ...(replyTo !== undefined ? { replyTo } : {}),
      }),
    })
      .then((response) => {
        // the server stored the message before answering — one
        // refetch shows the real stored row
        if (response.ok) onSent();
      })
      .catch(() => {});
  };
  return (
    <div className="w-full px-4 pb-4 pt-2">
      <PromptInput onSubmit={send}>
        <PromptInputBody>
          <PromptInputTextarea
            className="min-h-0 min-w-0 basis-0 py-2.5"
            placeholder={placeholder}
          />
        </PromptInputBody>
        <InputGroupAddon align="inline-end" className="gap-0.5 self-end py-1.5">
          <PromptInputSubmit
            status={live ? "streaming" : undefined}
            onStop={() => {
              void interruptChat(chat).catch(() => {});
            }}
            variant="ghost"
            className="text-muted-foreground"
          />
        </InputGroupAddon>
      </PromptInput>
    </div>
  );
};

export const ChannelFeed = ({
  channel,
  chat,
  placeholder,
  filter,
  dm = false,
}: {
  /** The channel's name (`root`, `engineering`) — the feed's scope. */
  channel: string;
  /** The channel agent's session id — the model select + stop. */
  chat: string;
  placeholder?: string;
  /** The header's search box — filters whole threads by text. */
  filter?: string;
  /** A DM — the empty state speaks to the agent, not a room. */
  dm?: boolean;
}) => {
  const { posts, edges, refresh } = useChannelPosts(channel);
  const live = posts !== undefined && posts.some(isLive);
  const logRef = useRef<HTMLDivElement | null>(null);
  // pin-to-bottom: follow new rows unless the reader scrolled up
  const pinnedRef = useRef(true);

  useEffect(() => {
    const log = logRef.current;
    if (log === null || !pinnedRef.current) return;
    log.scrollTop = log.scrollHeight;
  }, [posts]);

  const needle = filter?.trim().toLowerCase() ?? "";
  const threads = posts === undefined ? undefined : threadsOf(posts);
  // the search keeps WHOLE threads — a thread matches when any of
  // its messages does
  const shown =
    threads === undefined
      ? undefined
      : needle.length === 0
        ? threads
        : threads.filter((thread) =>
            thread.posts.some((post) =>
              `${post.author}\n${post.text}`.toLowerCase().includes(needle),
            ),
          );
  const byId = new Map((posts ?? []).map((post) => [post.id, post]));

  return (
    <>
      <div
        ref={logRef}
        role="log"
        onScroll={() => {
          const log = logRef.current;
          if (log === null) return;
          pinnedRef.current =
            log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {shown === undefined ? (
          <div className="px-2 py-6 text-[12px] text-muted-foreground">
            loading the channel…
          </div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-6 text-[12px] text-muted-foreground">
            {needle.length > 0
              ? "nothing matches the search"
              : dm
                ? `nothing here yet — say something to @${channel}`
                : `nothing here yet — say something in #${channel}`}
          </div>
        ) : (
          <div className="space-y-6 py-3">
            {shown.map((thread) => (
              <ThreadCard
                key={thread.root.id}
                thread={thread}
                judgedRef={(() => {
                  // an inferred reply, or an `about` edge that points
                  // at another MESSAGE (evidence refs post ids as
                  // `#p-…`) — both are arcs a reader wants
                  const edge = edges.find(
                    (candidate) =>
                      candidate.from === thread.root.id &&
                      (candidate.label === "answers" ||
                        (candidate.label === "about" &&
                          candidate.to.startsWith("#p-"))),
                  );
                  return edge === undefined
                    ? undefined
                    : byId.get(edge.to.replace(/^#/, ""));
                })()}
              />
            ))}
          </div>
        )}
      </div>
      <Composer
        channel={channel}
        chat={chat}
        placeholder={placeholder ?? "Say something…"}
        live={live}
        onSent={() => {
          pinnedRef.current = true;
          refresh();
        }}
      />
    </>
  );
};

/**
 * A THREAD, opened — discord's side panel: the root message pinned
 * at the top ("Started by …"), the conversation flat underneath, and
 * a composer that speaks INTO the thread (the human's message
 * references the root; the channel agent answers in context).
 */
/**
 * The workspaces ACTIVE in a thread — a collapsible strip above the
 * composer (cursor's files list): collapsed, a count; expanded, one
 * row per workspace opening its terminal.
 */
const ThreadWorkspaces = ({
  thread,
  live,
}: {
  thread: string;
  /** Poll faster while the thread runs — workspaces appear mid-round. */
  live: boolean;
}) => {
  const [names, setNames] = useState<ReadonlyArray<string>>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/posts/${encodeURIComponent(thread)}/workspaces`)
        .then(async (response) => {
          if (!alive || !response.ok) return;
          const body = (await response.json()) as { workspaces: string[] };
          setNames(body.workspaces);
          timer = setTimeout(load, live ? 3_000 : 15_000);
        })
        .catch(() => {
          if (alive) timer = setTimeout(load, 15_000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [thread, live]);
  if (names.length === 0) return null;
  return (
    <div className="mx-4 mb-1 shrink-0 rounded-md border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span>
          {names.length} {names.length === 1 ? "workspace" : "workspaces"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/60 px-2.5 py-1.5">
          {names.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => showOverlay({ kind: "workspace", name })}
              title={`open a terminal in ${name}`}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <FolderTree className="size-3.5 shrink-0" />
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const ThreadView = ({
  channel,
  chat,
  id,
  active = true,
  weight,
  onClose,
}: {
  channel: string;
  chat: string;
  /** The thread — its root post id (any member id resolves). */
  id: string;
  /** Shown, or kept MOUNTED but hidden (the panel cache): a hidden
   *  panel keeps its state — reshowing restores the exact scroll
   *  position, instantly, no animation. */
  active?: boolean;
  /** The column's proportional share — dragged at the divider. */
  weight?: number;
  /** The X — the center thread returns to its channel; a PANE in the
   *  reference chain closes just itself. */
  onClose?: () => void;
}) => {
  const { posts, refresh } = useChannelPosts(channel);
  const logRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  // the reader's place, tracked on every scroll — `display: none`
  // zeroes a scroller, so reshowing restores from here
  const placeRef = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const log = logRef.current;
    if (!active || log === null || placeRef.current === undefined) return;
    log.scrollTop = placeRef.current;
  }, [active]);

  const thread =
    posts === undefined
      ? undefined
      : (threadsOf(posts).find((candidate) =>
          candidate.posts.some((post) => post.id === id),
        ) ?? null);

  const live =
    thread !== undefined && thread !== null && thread.posts.some(isLive);

  useEffect(() => {
    const log = logRef.current;
    if (log === null || !pinnedRef.current) return;
    log.scrollTop = log.scrollHeight;
  }, [posts]);

  // `#id` chips and reply references reveal messages — this panel
  // claims ids in its thread and scrolls to them
  useEffect(() => {
    const onReveal = (event: Event) => {
      const target = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (
        !active ||
        target === undefined ||
        thread === undefined ||
        thread === null
      ) {
        return;
      }
      if (!thread.posts.some((post) => post.id === target)) return;
      event.preventDefault();
      pinnedRef.current = false;
      const row = () =>
        logRef.current?.querySelector(`[data-post-id="${CSS.escape(target)}"]`);
      const scroll = () =>
        row()?.scrollIntoView({ behavior: "smooth", block: "center" });
      // FLASH immediately — the wash outlives the smooth scroll, so
      // the eye tracks the highlighted row as it arrives
      requestAnimationFrame(() => {
        scroll();
        const element = row();
        if (!(element instanceof HTMLElement)) return;
        element.classList.remove("post-flash");
        // restart the animation even when re-revealing the same row
        void element.offsetWidth;
        element.classList.add("post-flash");
        setTimeout(() => element.classList.remove("post-flash"), 1_700);
      });
    };
    window.addEventListener("reveal-post", onReveal);
    return () => window.removeEventListener("reveal-post", onReveal);
  }, [thread, active]);

  const replies =
    thread === undefined || thread === null
      ? []
      : thread.posts.filter((post) => post.id !== thread.root.id);

  return (
    <aside
      aria-label="thread"
      style={
        active && weight !== undefined
          ? { flexGrow: weight, flexBasis: 0 }
          : undefined
      }
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col border-l border-border bg-background max-md:absolute max-md:inset-0 max-md:z-30",
        !active && "hidden",
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm font-medium">
          Thread
          <span className="truncate font-mono text-[10px] font-normal text-muted-foreground">
            #{channel}
          </span>
        </span>
        <button
          type="button"
          onClick={() =>
            onClose !== undefined ? onClose() : showChannel(channel)
          }
          aria-label="close the thread"
          className="flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent"
        >
          <X className="size-3.5" />
        </button>
      </header>
      <div
        ref={logRef}
        role="log"
        onScroll={() => {
          const log = logRef.current;
          if (log === null) return;
          // `display: none` reports 0s — never record the hidden state
          if (active) placeRef.current = log.scrollTop;
          pinnedRef.current =
            log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {thread === undefined ? (
          <div className="px-2 py-6 text-[12px] text-muted-foreground">
            loading the thread…
          </div>
        ) : thread === null ? (
          <div className="px-2 py-6 text-[12px] text-muted-foreground">
            this thread has no messages (yet)
          </div>
        ) : (
          <MessageContext.Provider value={{ id: thread.root.id }}>
            {/* the root — who started it, then its full text */}
            <div
              data-post-id={thread.root.id}
              className="min-w-0 border-b border-border/60 pb-3"
            >
              <div className="flex items-center gap-2">
                <AuthorAvatar name={thread.root.author} />
                <span className="font-mono text-[12px] font-semibold">
                  {thread.root.author}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  {formatAt(thread.root.at)}
                </span>

                {thread.root.status === "failed" && (
                  <span className="shrink-0 text-[11px] text-destructive">
                    failed
                  </span>
                )}
              </div>
              <div className="ml-8 min-w-0 text-[13px]">
                <MarkdownText text={thread.root.text} />
              </div>
              {replies.length === 0 && <TypingRow post={thread.root} />}
            </div>
            <div className="pt-3">
              {/* SUB-THREADS render as cards (recursively — a reply
                  that grew its own conversation is a thread here the
                  way this thread is one in the channel); loose replies
                  stay a flat stream */}
              {(() => {
                const descendants = (id: string): Post[] =>
                  replies
                    .filter((candidate) => candidate.replyTo === id)
                    .flatMap((child) => [child, ...descendants(child.id)]);
                const direct = replies.filter(
                  (candidate) => candidate.replyTo === thread.root.id,
                );
                const nested = new Set(
                  direct
                    .filter(
                      (candidate) =>
                        candidate.mode === "thread" ||
                        descendants(candidate.id).length > 0,
                    )
                    .flatMap((sub) => [
                      sub.id,
                      ...descendants(sub.id).map((post) => post.id),
                    ]),
                );
                const flat = replies.filter(
                  (candidate) => !nested.has(candidate.id),
                );
                const subRoots = direct.filter((candidate) =>
                  nested.has(candidate.id),
                );
                return (
                  <>
                    {subRoots.map((sub) => (
                      <div key={sub.id} className="mb-3">
                        <ThreadCard
                          thread={{
                            root: sub,
                            posts: [sub, ...descendants(sub.id)],
                          }}
                        />
                      </div>
                    ))}
                    <PostList
                      posts={flat}
                      context={[thread.root]}
                      suppressRef={thread.root.id}
                    />
                  </>
                );
              })()}
            </div>
          </MessageContext.Provider>
        )}
      </div>
      <ThreadWorkspaces
        thread={thread === undefined || thread === null ? id : thread.root.id}
        live={live}
      />
      <Composer
        channel={channel}
        chat={chat}
        replyTo={thread === undefined || thread === null ? id : thread.root.id}
        placeholder="Reply in thread…"
        live={live}
        onSent={() => {
          pinnedRef.current = true;
          refresh();
        }}
      />
    </aside>
  );
};

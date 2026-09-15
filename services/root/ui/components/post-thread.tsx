/**
 * The conversation, rendered from ONE recursive shape.
 *
 * A {@link Post} is a message with an author, text, and replies. That
 * is the whole model — a human's channel message, an agent's message
 * addressed with `@mentions`, and each mentioned agent's answer are
 * all posts, so ONE component draws any depth of it, reddit-style:
 *
 * ```
 * manager: @reviewer what do you check first? @e-demo1 introduce yourself
 * ├─ reviewer: the diff, then the tests…
 * ├─ e-demo1: @reviewer what do you check first?
 * │  └─ reviewer: the diff, then the tests…
 * └─ e-demo1: I'm an engineer on this codebase…
 * ```
 *
 * Nothing here knows about "asks", targets, or questions-with-
 * answers: a target is named by the text's own `@mention` (never
 * repeated as a chip), and an answer is simply a reply.
 *
 * The geometry is reddit's, uniform at every depth: 24px avatars,
 * 32px steps, a trunk under the author's avatar, each reply hung off
 * it by a rounded elbow, the ⊖ riding the arc's junction and the ⊕
 * taking the avatar's place when a branch is collapsed.
 */
import { Avatar, sessionOf } from "@/components/avatar";
import { MarkdownText } from "@/components/chat";
import { showOverlay } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { CircleMinus, CirclePlus, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

export interface Post {
  readonly id: string;
  readonly parent?: string;
  readonly author: string;
  readonly text: string;
  readonly status: "running" | "settled" | "failed";
  readonly at: number;
  readonly children: ReadonlyArray<Post>;
}

const isLive = (post: Post): boolean =>
  post.status === "running" || post.children.some(isLive);

/** Everything beneath a post — what a collapsed row counts. */
const replyCount = (post: Post): number =>
  post.children.reduce((sum, child) => sum + 1 + replyCount(child), 0);

/** Depth at which branches fold themselves, the way reddit does. */
const AUTO_FOLD_DEPTH = 4;

const firstLineOf = (text: string, max = 80): string => {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** An author's name — clicking opens that agent's session. */
const Name = ({ name }: { name: string }) => {
  const session = sessionOf(name);
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

/** A mention chip — how the text itself addresses someone. */
export const Mention = ({ name }: { name: string }) => {
  const session = sessionOf(name);
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

/** Markdown clamped to a few lines, expanding in place. */
const Clamped = ({ text, lines = 3 }: { text: string; lines?: number }) => {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split("\n").length > lines;
  if (!long || open) {
    return (
      <div className="min-w-0 text-[13px]">
        <MarkdownText text={text} />
        {long && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
          >
            less
          </button>
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="min-w-0 cursor-pointer text-left"
      title="show the full text"
    >
      <div
        style={{ WebkitLineClamp: lines }}
        className="min-w-0 overflow-hidden text-[13px] [-webkit-box-orient:vertical] [display:-webkit-box]"
      >
        <MarkdownText text={text} />
      </div>
      <span className="text-[11px] text-muted-foreground hover:text-foreground">
        more
      </span>
    </button>
  );
};

/** One avatar column: 24px avatar + 8px gap = the indent step. */
const STEP = "ml-8";
/** The trunk's x within an indented column: the avatar's center. */
const TRUNK = "-left-5";

/** A reply hung off its parent's trunk by the rounded elbow — the
 *  arc spans the whole step, landing on the child's avatar. The
 *  first reply carries the ⊖ at the arc's junction; a non-last reply
 *  continues the trunk, and the last one's elbow ends it. */
const Reply = ({
  last,
  onFold,
  children,
}: {
  last: boolean;
  onFold?: () => void;
  children: ReactNode;
}) => (
  <div className="relative">
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-0 h-4 w-5 rounded-bl-[12px] border-b border-l border-muted-foreground/30",
        TRUNK,
      )}
    />
    {!last && (
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 w-px bg-muted-foreground/30",
          TRUNK,
        )}
      />
    )}
    {onFold !== undefined && (
      <button
        type="button"
        onClick={onFold}
        aria-label="collapse this branch"
        title="collapse"
        className="group/trunk absolute top-2 z-10 flex size-4 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center"
        style={{ left: "-20px" }}
      >
        <CircleMinus className="size-3.5 rounded-full bg-background text-muted-foreground/70 group-hover/trunk:text-foreground" />
      </button>
    )}
    <div className="pt-2">{children}</div>
  </div>
);

/** A collapsed post — the ⊕ takes the avatar's place. */
const Folded = ({ post, onOpen }: { post: Post; onOpen: () => void }) => {
  const replies = replyCount(post);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 cursor-pointer items-center gap-2 rounded py-0.5 text-left hover:bg-accent/60"
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        <CirclePlus className="size-[18px] text-muted-foreground" />
      </span>
      <span className="font-mono text-[12px] font-semibold">{post.author}</span>
      <span className="min-w-0 truncate text-[12px] text-muted-foreground">
        {firstLineOf(post.text)}
      </span>
      {isLive(post) ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
      ) : (
        replies > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground/70">
            {replies} repl{replies === 1 ? "y" : "ies"}
          </span>
        )
      )}
    </button>
  );
};

/**
 * ONE post and its replies — the whole renderer, recursive.
 *
 * `speaker` is the voice the enclosing context already established
 * (the message's author); a post in that voice doesn't restate it.
 */
export const PostNode = ({
  post,
  depth = 0,
  speaker,
}: {
  post: Post;
  depth?: number;
  speaker?: string;
}) => {
  const [folded, setFolded] = useState(depth >= AUTO_FOLD_DEPTH);
  if (folded) {
    return <Folded post={post} onOpen={() => setFolded(false)} />;
  }

  const header = post.author !== speaker;
  return (
    <div className="min-w-0">
      {header && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFolded(true)}
            title="collapse"
            aria-label="collapse this post"
            className="cursor-pointer"
          >
            <Avatar name={post.author} kind="agent" size={24} />
          </button>
          <Name name={post.author} />
          {post.status === "running" && (
            <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
          )}
          {post.status === "failed" && (
            <span className="shrink-0 text-[11px] text-destructive">
              failed
            </span>
          )}
        </div>
      )}
      <div className={cn("relative", header && STEP)}>
        {/* the TEXT, then the replies — the trunk runs alongside
            both when there is anything to hang from it */}
        {post.children.length > 0 && header && (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 h-8 w-px bg-muted-foreground/30",
              TRUNK,
            )}
          />
        )}
        <Clamped text={post.text} lines={header ? 3 : 6} />
        {post.children.map((child, index) => (
          <Reply
            key={child.id}
            last={index === post.children.length - 1}
            {...(index === 0 && header
              ? { onFold: () => setFolded(true) }
              : {})}
          >
            <PostNode post={child} depth={depth + 1} />
          </Reply>
        ))}
      </div>
    </div>
  );
};

/** A post's live subtree — polls while anything under it runs. */
export const PostThread = ({
  id,
  speaker,
}: {
  id: string;
  /** The author already named by the enclosing message. */
  speaker?: string;
}) => {
  const [post, setPost] = useState<Post | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/posts/${encodeURIComponent(id)}`)
        .then(async (response) => {
          if (!live || !response.ok) return;
          const next = (await response.json()) as Post;
          setPost(next);
          if (isLive(next)) timer = setTimeout(load, 2_000);
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

  if (post === undefined) {
    return (
      <div className="text-[11px] text-muted-foreground">loading the thread…</div>
    );
  }
  return <PostNode post={post} speaker={speaker} />;
};

/**
 * A post still being written — the mentioned agents stand in as
 * pending replies until their posts land.
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
    {agents.length > 0 && (
      <div className="relative">
        {agents.map((agent, index) => (
          <Reply key={agent} last={index === agents.length - 1}>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Avatar name={agent} kind="agent" size={24} />
              <span className="font-mono text-[12px] font-semibold">
                {agent}
              </span>
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
          </Reply>
        ))}
      </div>
    )}
  </div>
);

/** How agents address each other in text — mirrors chat/Ask.ts. */
export const MENTION_RE = /(?<![\w@.])@([a-z][a-z0-9-]{0,40})\b/g;

export const mentionsOf = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(MENTION_RE)].map((match) => match[1]!)),
];

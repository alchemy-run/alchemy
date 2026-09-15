/**
 * The ASK TREE, rendered with REDDIT's exact comment grammar —
 * because that is what a chain of asks IS: every message a comment,
 * every reply nested under what it answers.
 *
 * The geometry (uniform at every depth):
 * - every avatar is 24px; every indent step is 32px (one avatar
 *   column: 24 + 8 gap)
 * - a comment's TRUNK drops from under its avatar, alongside its
 *   body and its replies; clicking the trunk (or the avatar) folds
 *   the comment to one row
 * - each reply hangs off the trunk by a rounded ELBOW; the last
 *   reply's elbow ends the trunk
 * - a folded comment is reddit's row: ⊕ avatar · author · the first
 *   line · "N replies"
 * - bodies clamp to a few lines and expand in place ("more")
 *
 * There are no titles — the message IS the content; the first line
 * carries the glance.
 *
 * Fed by `GET /api/asks/:id/tree`; a tree with a RUNNING node polls
 * until every question is answered.
 */
import { Avatar, sessionOf } from "@/components/avatar";
import { MarkdownText } from "@/components/chat";
import { showOverlay } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { CircleMinus, CirclePlus, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

export interface AskNode {
  readonly id: string;
  readonly parent?: string;
  readonly call?: string;
  readonly asker: string;
  readonly target: string;
  readonly question: string;
  readonly answer?: string;
  readonly status: "running" | "answered" | "failed";
  readonly at: number;
  readonly children: ReadonlyArray<AskNode>;
}

const hasRunning = (node: AskNode): boolean =>
  node.status === "running" || node.children.some(hasRunning);

/** Replies under a node: its children's subtrees plus the answer. */
const replyCount = (node: AskNode): number =>
  node.children.reduce((sum, child) => sum + 1 + replyCount(child), 0) +
  (node.answer === undefined ? 0 : 1);

/** Depth at which branches fold to "N replies" rows, reddit-style. */
const AUTO_FOLD_DEPTH = 3;

const firstLineOf = (text: string, max = 80): string => {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** An author's name — clicking digs into the agent's session. */
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

/** WHO a question is directed at — the discord mention: `@reviewer`,
 *  accent-washed, clicking opens the target's session. */
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

/** Markdown clamped to a few lines, expanding in place — succinct
 *  first, the full text one click away. */
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

/* ── reddit geometry ──────────────────────────────────────────────── */

/** One avatar column: 24px avatar + 8px gap. */
const STEP = "ml-8"; // 32px
/** The trunk's x, relative to the indented content column: the
 *  avatar's center (12px) minus the step (32px). */
const TRUNK_LEFT = "-left-5"; // -20px

/**
 * A COMMENT, reddit-shaped: header (avatar · author · aside), then
 * body and replies in a column indented one STEP, with the trunk
 * alongside — both the avatar and the trunk fold it.
 */
export const CommentShell = ({
  author,
  aside,
  onFold,
  children,
}: {
  /** The avatar + name; `undefined` renders a headerless comment
   *  (the voice is already established by the enclosing context). */
  author?: string;
  /** After the name: mention, status, clock. */
  aside?: ReactNode;
  onFold?: () => void;
  children: ReactNode;
}) => (
  <div className="min-w-0">
    <div className="flex items-center gap-2">
      {author !== undefined && (
        <button
          type="button"
          onClick={onFold}
          title="collapse"
          aria-label="collapse this comment"
          className={cn(onFold !== undefined && "cursor-pointer")}
        >
          <Avatar name={author} kind="agent" size={24} />
        </button>
      )}
      {author !== undefined && <Name name={author} />}
      {aside}
    </div>
    <div className={cn("relative", STEP)}>
      {/* reddit's fold handle: the ⊖ floats on the trunk a breath
          below the avatar; the LINE itself is drawn by the content
          (Trunk segments and Reply elbows), so it always terminates
          at the last reply — the button only needs to be clickable */}
      {onFold !== undefined && (
        <button
          type="button"
          onClick={onFold}
          aria-label="collapse this branch"
          title="collapse"
          className="group/trunk absolute inset-y-0 -left-7 z-10 w-4 cursor-pointer"
        >
          <CircleMinus className="absolute left-1/2 top-1.5 size-3.5 -translate-x-1/2 rounded-full bg-background text-muted-foreground/70 group-hover/trunk:text-foreground" />
        </button>
      )}
      <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">{children}</div>
    </div>
  </div>
);

/** A stretch of the parent's TRUNK alongside non-reply content (a
 *  comment's own body when replies follow it) — the line segments
 *  compose per item, so the trunk always ends exactly at the last
 *  reply's elbow, never with paint-over hacks. */
export const Trunk = ({ children }: { children: ReactNode }) => (
  <div className="relative">
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-y-0 w-px bg-muted-foreground/30",
        TRUNK_LEFT,
      )}
    />
    {children}
  </div>
);

/** A reply hanging off its parent's trunk by a rounded ELBOW — the
 *  curve spans the whole step, landing exactly on the child's
 *  avatar (avatar → avatar, no gaps). A non-last reply continues
 *  the trunk through its full height; the LAST one draws only its
 *  elbow, which is how the trunk ends. */
export const Reply = ({
  last,
  children,
}: {
  last: boolean;
  children: ReactNode;
}) => (
  <div className="relative">
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-0 h-4 w-5 rounded-bl-[12px] border-b border-l border-muted-foreground/30",
        TRUNK_LEFT,
      )}
    />
    {!last && (
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 w-px bg-muted-foreground/30",
          TRUNK_LEFT,
        )}
      />
    )}
    <div className="pt-2">{children}</div>
  </div>
);

/** A folded comment — reddit's one-liner. */
const Folded = ({
  node,
  speaker,
  onOpen,
}: {
  node: AskNode;
  speaker?: string;
  onOpen: () => void;
}) => {
  const replies = replyCount(node);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 cursor-pointer items-center gap-2 rounded py-0.5 text-left hover:bg-accent/60"
    >
      <CirclePlus className="size-3.5 shrink-0 text-muted-foreground" />
      {node.asker !== speaker ? (
        <>
          <Avatar name={node.asker} kind="agent" size={24} />
          <span className="font-mono text-[12px] font-semibold">
            {node.asker}
          </span>
        </>
      ) : (
        <Mention name={node.target} />
      )}
      <span className="min-w-0 truncate text-[12px] text-muted-foreground">
        {firstLineOf(node.question)}
      </span>
      {hasRunning(node) ? (
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
 * One ask as a comment SUBTREE: the question (aimed with an
 * @mention), the asks made while answering as replies, the answer
 * closing the node — the order the conversation happened. `speaker`
 * is the voice the context already established (the message's
 * author, or the parent's answering target): a node speaking in that
 * voice does not restate it.
 */
export const AskComment = ({
  node,
  depth,
  speaker,
}: {
  node: AskNode;
  depth: number;
  speaker?: string;
}) => {
  const [folded, setFolded] = useState(depth >= AUTO_FOLD_DEPTH);

  if (folded) {
    return (
      <Folded node={node} speaker={speaker} onOpen={() => setFolded(false)} />
    );
  }

  const replies: Array<ReactNode> = node.children.map((child) => (
    <AskComment
      key={child.id}
      node={child}
      depth={depth + 1}
      speaker={node.target}
    />
  ));
  if (node.answer !== undefined) {
    replies.push(
      <CommentShell
        key="answer"
        author={node.target}
        aside={
          node.status === "failed" ? (
            <span className="text-[11px] text-destructive">failed</span>
          ) : undefined
        }
      >
        <Clamped text={node.answer} lines={3} />
      </CommentShell>,
    );
  } else if (node.status === "running") {
    replies.push(
      <div
        key="answering"
        className="flex items-center gap-2 text-[11px] text-muted-foreground"
      >
        <Avatar name={node.target} kind="agent" size={24} />
        <span className="font-mono text-[12px] font-semibold">
          {node.target}
        </span>
        <Loader2 className="size-3 animate-spin" />
        <span className="animate-pulse">is answering…</span>
      </div>,
    );
  }

  return (
    <CommentShell
      author={node.asker === speaker ? undefined : node.asker}
      onFold={() => setFolded(true)}
      aside={
        <>
          <Mention name={node.target} />
          {node.status === "running" && (
            <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
          )}
          {node.status === "failed" && (
            <span className="shrink-0 text-[11px] text-destructive">
              failed
            </span>
          )}
        </>
      }
    >
      {replies.length > 0 ? (
        <Trunk>
          <div className="text-muted-foreground">
            <Clamped text={node.question} lines={2} />
          </div>
        </Trunk>
      ) : (
        <div className="text-muted-foreground">
          <Clamped text={node.question} lines={2} />
        </div>
      )}
      {replies.map((reply, index) => (
        <Reply key={index} last={index === replies.length - 1}>
          {reply}
        </Reply>
      ))}
    </CommentShell>
  );
};

/** One ask's live subtree — polls while any node runs. */
const useAskTree = (id: string): AskNode | undefined => {
  const [tree, setTree] = useState<AskNode | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/asks/${encodeURIComponent(id)}/tree`)
        .then(async (response) => {
          if (!live || !response.ok) return;
          const next = (await response.json()) as AskNode;
          setTree(next);
          if (hasRunning(next)) timer = setTimeout(load, 2_000);
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

  return tree;
};

/** The live subtree under one ask id — a full comment tree.
 *  `speaker` is the enclosing message's author (the ROOT asker), so
 *  the top node reads as "@target · question", not a self-reply. */
export const AskThread = ({
  id,
  speaker,
}: {
  id: string;
  speaker?: string;
}) => {
  const tree = useAskTree(id);
  if (tree === undefined) {
    return (
      <div className="text-[11px] text-muted-foreground">loading the chain…</div>
    );
  }
  return <AskComment node={tree} depth={0} speaker={speaker} />;
};

/* ── mention-asks: the text IS the message ────────────────────────── */

/** How agents address each other in text — mirrors the server's
 *  MENTION convention (chat/Ask.ts). */
export const MENTION_RE = /(?<![\w@.])@([a-z][a-z0-9-]{0,40})\b/g;

export const mentionsOf = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(MENTION_RE)].map((match) => match[1]!)),
];

/** A mentioned agent still composing — or cut off. */
const AnsweringRow = ({
  agent,
  stopped,
}: {
  agent: string;
  stopped: boolean;
}) => (
  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
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
);

/** One mentioned agent's REPLY: its comment (folding, spinner while
 *  running), the asks IT made as nested replies, its answer closing
 *  the comment. */
const TargetReply = ({ id }: { id: string }) => {
  const [folded, setFolded] = useState(false);
  const tree = useAskTree(id);
  if (tree === undefined) {
    return (
      <div className="text-[11px] text-muted-foreground">loading…</div>
    );
  }
  if (folded) {
    return (
      <Folded node={tree} speaker={tree.asker} onOpen={() => setFolded(false)} />
    );
  }
  const subs = tree.children;
  const tail =
    tree.answer !== undefined ? (
      <Clamped text={tree.answer} lines={3} />
    ) : tree.status === "running" ? (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        <span className="animate-pulse">composing the answer…</span>
      </div>
    ) : (
      <span className="text-[11px] text-destructive">failed</span>
    );
  return (
    <CommentShell
      author={tree.target}
      onFold={() => setFolded(true)}
      aside={
        tree.status === "running" ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
        ) : undefined
      }
    >
      {subs.length === 0 ? (
        tail
      ) : (
        <>
          {subs.map((child) => (
            <Reply key={child.id} last={false}>
              <AskComment
                node={child}
                depth={1}
                speaker={tree.target}
              />
            </Reply>
          ))}
          <Reply last>{tail}</Reply>
        </>
      )}
    </CommentShell>
  );
};

/**
 * A MENTION-ASK, rendered as the conversation it is: the message
 * text (its @mentions as chips), then each mentioned agent's reply
 * hanging off the trunk — reddit under a plain sentence.
 */
export const MentionAskView = ({
  text,
  entries,
  stopped,
}: {
  text: string;
  /** The settled routing (one per mentioned agent) — absent while
   *  the ask is still running (the mentions stand in). */
  entries?: ReadonlyArray<{ agent: string; ask: string }>;
  /** The round was cut before the answers landed. */
  stopped?: boolean;
}) => {
  const items =
    entries ??
    mentionsOf(text).map((agent) => ({ agent, ask: undefined as
      | string
      | undefined }));
  return (
    <div className="min-w-0">
      <div className="min-w-0 text-[13px]">
        <MarkdownText text={text} />
      </div>
      {items.length > 0 && (
        // NO extra step: the enclosing message's content column is
        // already one step past its author's avatar, so the replies
        // sit HERE and their elbows reach back to that avatar's
        // trunk — reddit's parent-to-child indent, exactly one step
        <div className="relative flex min-w-0 flex-col">
          {items.map((item, index) => (
            <Reply key={item.agent} last={index === items.length - 1}>
              {item.ask !== undefined ? (
                <TargetReply id={item.ask} />
              ) : (
                <AnsweringRow
                  agent={item.agent}
                  stopped={stopped === true}
                />
              )}
            </Reply>
          ))}
        </div>
      )}
    </div>
  );
};

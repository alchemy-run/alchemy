/**
 * The ASK TREE, rendered the way REDDIT renders a comment graph —
 * because that is what a chain of asks IS: every message a comment,
 * every reply nested under what it answers, collapse everywhere:
 *
 *   ● manager · scope the stripe surface            ← the ask (title)
 *   │   ● reviewer · what's the binding shape?      ← asked while answering
 *   │   │   ● e-4f2a ↩ it's the R2 pattern…
 *   │   ● reviewer ↩ ship it as three resources…    ← the answer closes it
 *
 * Anatomy per node (the reddit grammar):
 * - the GUTTER: the author's avatar, then a vertical connector — the
 *   whole line is a button; clicking it folds the subtree to one row
 * - the HEADER: author · the ONE-LINE title (the agents label every
 *   ask); a spinner while the question is being answered
 * - the BODIES: question and answer clamp to a couple of lines and
 *   expand in place ("more") — succinct first, everything diggable
 * - deep branches fold automatically ("N replies") the way reddit
 *   folds long chains
 *
 * Fed by `GET /api/asks/:id/tree`; a tree with a RUNNING node polls
 * until every question is answered.
 */
import { Avatar, sessionOf } from "@/components/avatar";
import { MarkdownText } from "@/components/chat";
import { showOverlay } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { CirclePlus, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

export interface AskNode {
  readonly id: string;
  readonly parent?: string;
  readonly call?: string;
  readonly asker: string;
  readonly target: string;
  readonly title?: string;
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

/** An author chip — clicking digs into the agent's session. The
 *  avatar is optional: comment headers sit beside the gutter's. */
const Who = ({ name, avatar = true }: { name: string; avatar?: boolean }) => {
  const session = sessionOf(name);
  const face = (
    <>
      {avatar && <Avatar name={name} kind="agent" size={18} />}
      <span className="font-mono text-[11px] font-medium">{name}</span>
    </>
  );
  return session === undefined ? (
    <span className="flex items-center gap-1.5">{face}</span>
  ) : (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        showOverlay({ kind: "agent", id: session });
      }}
      title={`open ${name}'s session`}
      className="flex cursor-pointer items-center gap-1.5 hover:underline"
    >
      {face}
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

/** One COMMENT: gutter (avatar + fold line) beside content. */
const Comment = ({
  author,
  header,
  children,
  onFold,
}: {
  author: string;
  header: ReactNode;
  children?: ReactNode;
  onFold?: () => void;
}) => (
  <div className="flex min-w-0 gap-2">
    <div className="flex w-[18px] shrink-0 flex-col items-center gap-1">
      <Avatar name={author} kind="agent" size={18} />
      {children !== undefined && (
        <button
          type="button"
          onClick={onFold}
          aria-label="collapse this branch"
          title="collapse"
          className="group/line w-full flex-1 cursor-pointer py-0.5"
        >
          <div className="mx-auto h-full w-px bg-border group-hover/line:w-[3px] group-hover/line:bg-primary/50" />
        </button>
      )}
    </div>
    <div className="min-w-0 flex-1 pb-0.5">
      {header}
      {children}
    </div>
  </div>
);

/** A folded branch — one row, reddit's "N replies". */
const Folded = ({
  node,
  onOpen,
}: {
  node: AskNode;
  onOpen: () => void;
}) => {
  const replies = replyCount(node);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded py-0.5 text-left hover:bg-accent/60"
    >
      <CirclePlus className="size-3.5 shrink-0 text-muted-foreground" />
      <Avatar name={node.asker} kind="agent" size={16} />
      <span className="font-mono text-[11px] font-medium">{node.asker}</span>
      <span className="min-w-0 truncate text-[12px] text-muted-foreground">
        {node.title ?? firstLineOf(node.question)}
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

/** One ask as a comment SUBTREE: the question (titled, clamped), the
 *  asks made while answering nested under it, the answer closing the
 *  node — exactly the order the conversation happened. */
export const AskComment = ({
  node,
  depth,
}: {
  node: AskNode;
  depth: number;
}) => {
  const [folded, setFolded] = useState(depth >= AUTO_FOLD_DEPTH);

  if (folded) {
    return <Folded node={node} onOpen={() => setFolded(false)} />;
  }
  return (
    <Comment
      author={node.asker}
      onFold={() => setFolded(true)}
      header={
        <div className="flex min-w-0 items-center gap-1.5">
          <Who name={node.asker} avatar={false} />
          <span className="min-w-0 truncate text-[13px] font-medium">
            {node.title ?? firstLineOf(node.question)}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
            → {node.target}
          </span>
          {node.status === "running" && (
            <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
          )}
          {node.status === "failed" && (
            <span className="shrink-0 text-[11px] text-destructive">
              failed
            </span>
          )}
        </div>
      }
    >
      {/* the full question — only when it says more than the title */}
      {node.title !== undefined &&
        node.question.trim() !== node.title.trim() && (
          <div className="pt-0.5 text-muted-foreground">
            <Clamped text={node.question} lines={2} />
          </div>
        )}
      {(node.children.length > 0 ||
        node.answer !== undefined ||
        node.status === "running") && (
        <div className="flex min-w-0 flex-col gap-1 pt-1.5">
          {node.children.map((child) => (
            <AskComment key={child.id} node={child} depth={depth + 1} />
          ))}
          {node.answer !== undefined ? (
            <Comment
              author={node.target}
              header={
                <div className="flex min-w-0 items-center gap-1.5">
                  <Who name={node.target} avatar={false} />
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    ↩ {node.status === "failed" ? "failed" : "answered"}
                  </span>
                </div>
              }
            >
              <div className="pt-0.5">
                <Clamped text={node.answer} lines={3} />
              </div>
            </Comment>
          ) : (
            node.status === "running" && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Avatar name={node.target} kind="agent" size={16} />
                <span className="font-mono font-medium">{node.target}</span>
                <Loader2 className="size-3 animate-spin" />
                <span className="animate-pulse">is answering…</span>
              </div>
            )
          )}
        </div>
      )}
    </Comment>
  );
};

/** The live subtree under one ask id — polls while any node runs. */
export const AskThread = ({ id }: { id: string }) => {
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

  if (tree === undefined) {
    return (
      <div className="text-[11px] text-muted-foreground">loading the chain…</div>
    );
  }
  return <AskComment node={tree} depth={0} />;
};

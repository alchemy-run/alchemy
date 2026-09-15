/**
 * The ASK TREE — a chain of questions rendered the way reddit renders
 * a thread, because that is what a chain IS: each ask a node, the asks
 * its target made while answering nested under it, the answer closing
 * the node after its children (the order the conversation actually
 * happened):
 *
 *   head → manager   can we ship #1521?
 *   │  manager → e-4f2a   is the D1 flake understood?
 *   │  e-4f2a ↩  yes — fencepost in the retry; fix pushed
 *   manager ↩  yes, pending the merge proposal
 *
 * Fed by `GET /api/asks/:id/tree`; a tree with a RUNNING node polls
 * until every question is answered.
 */
import { MarkdownText } from "@/components/chat";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

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

const Author = ({ name }: { name: string }) => (
  <span className="font-mono text-[11px] font-medium text-foreground">
    {name}
  </span>
);

const Node = ({ node, depth }: { node: AskNode; depth: number }) => (
  <div
    data-ask={node.id}
    className={cn(
      "flex flex-col gap-1",
      depth > 0 && "border-l-2 border-border/60 pl-3",
    )}
  >
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Author name={node.asker} />
      <span>→</span>
      <Author name={node.target} />
      {node.status === "running" && (
        <Loader2 className="size-3 animate-spin" />
      )}
      {node.status === "failed" && (
        <span className="text-destructive">failed</span>
      )}
      {node.call !== undefined && (
        <span className="rounded border border-border/60 px-1 font-mono text-[10px]">
          {node.call}
        </span>
      )}
    </div>
    <div className="text-[13px]">
      <MarkdownText text={node.question} />
    </div>
    {/* the asks made WHILE answering — the branch the user reads down
        into, then the answer closes this node beneath them */}
    {node.children.map((child) => (
      <Node key={child.id} node={child} depth={depth + 1} />
    ))}
    {node.answer !== undefined && (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Author name={node.target} />
          <span>↩</span>
        </div>
        <div className="border-l-2 border-moss/40 pl-2 text-[13px]">
          <MarkdownText text={node.answer} />
        </div>
      </div>
    )}
  </div>
);

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
  return <Node node={tree} depth={0} />;
};

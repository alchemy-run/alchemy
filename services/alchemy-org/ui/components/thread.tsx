/**
 * A THREAD's page — the conversation IS the thread (the agent
 * session's chat), with the task's state in a right pane: the GitHub
 * entities it governs (each pull opens its review), the subagents,
 * the worktrees. Terminals open on the thread's one machine.
 */

import { ChatView, timeAgo } from "@/components/chat";
import { Rail } from "@/components/rail";
import { GhosttyTerminal } from "@/components/terminal";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ThreadState } from "@/lib/channel";
import { parseEntityRef, threadSessionId } from "@/lib/channel";
import type { ThreadTab } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  Bot,
  CircleDot,
  FileDiff,
  FolderGit2,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  MessageSquare,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { ReviewView } from "@/components/review";

const Hint = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

/* ── the state pane ───────────────────────────────────────────────── */

const entityIcon = (kind: "issue" | "pull", state: string) => {
  if (kind === "issue") {
    return (
      <CircleDot
        className={cn(
          "size-3.5",
          state === "open" ? "text-moss" : "text-muted-foreground",
        )}
      />
    );
  }
  if (state === "merged") return <GitMerge className="size-3.5 text-terracotta" />;
  if (state === "closed") {
    return <GitPullRequestClosed className="size-3.5 text-brick" />;
  }
  return <GitPullRequestArrow className="size-3.5 text-moss" />;
};

const AGENT_DOT: Record<string, string> = {
  running: "bg-moss animate-pulse",
  done: "bg-muted-foreground/40",
  failed: "bg-brick",
  stopped: "bg-muted-foreground/40",
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-1 border-b border-border/60 px-3 py-2.5">
    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
      {title}
    </div>
    {children}
  </div>
);

/** The thread's books: entities, agents, close. */
const ThreadPane = ({
  state,
  onOpenReview,
  onClose,
}: {
  state: ThreadState;
  onOpenReview: (owner: string, repo: string, number: number) => void;
  onClose: () => void;
}) => {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Section title="Entities">
        {state.entities.length === 0 && (
          <div className="text-xs text-muted-foreground">
            Nothing attached yet.
          </div>
        )}
        {state.entities.map((entity) => {
          const parsed = parseEntityRef(entity.ref);
          return (
            <div
              key={entity.ref}
              className="flex flex-col gap-0.5 rounded-md px-1 py-1"
            >
              <div className="flex items-center gap-1.5">
                {entityIcon(entity.kind, entity.state)}
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {entity.title}
                </span>
                {entity.kind === "pull" && parsed !== undefined && (
                  <Hint label="Open the review — the diff beside this conversation">
                    <button
                      type="button"
                      aria-label={`open review for ${entity.ref}`}
                      onClick={() =>
                        onOpenReview(parsed.owner, parsed.repo, parsed.number)
                      }
                      className="cursor-pointer rounded border border-border p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <FileDiff className="size-3.5" />
                    </button>
                  </Hint>
                )}
              </div>
              <div className="flex items-center gap-2 pl-5 text-[11px] text-muted-foreground">
                <a
                  href={`https://github.com/${entity.ref.replace("#", "/issues/")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground hover:underline"
                >
                  {entity.ref}
                </a>
                <span>{entity.state}</span>
                {entity.worktree !== undefined && (
                  <span
                    title={entity.worktree}
                    className="flex min-w-0 items-center gap-1 truncate font-mono text-[10px]"
                  >
                    <FolderGit2 className="size-3 shrink-0" />
                    {entity.worktree.split("/").slice(-2).join("/")}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </Section>
      <Section title="Agents">
        {state.agents.length === 0 && (
          <div className="text-xs text-muted-foreground">No subagents yet.</div>
        )}
        {state.agents.map((agent) => (
          <div key={agent.key} className="flex items-center gap-2 px-1 py-0.5">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                AGENT_DOT[agent.state] ?? "bg-muted-foreground/40",
              )}
            />
            <Bot className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              title={agent.brief}
              className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
            >
              <span className="font-medium text-foreground">{agent.kind}</span>{" "}
              — {agent.brief}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {timeAgo(agent.settledAt ?? agent.startedAt)}
            </span>
          </div>
        ))}
      </Section>
      {state.status === "open" && (
        <div className="px-3 py-2.5">
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            title="Close the thread — make sure its work already landed"
            className="text-muted-foreground"
          >
            Close thread
          </Button>
        </div>
      )}
    </div>
  );
};

/* ── the page ─────────────────────────────────────────────────────── */

export const ThreadView = ({
  id,
  state,
  tab,
  active,
  terminals,
  onTab,
  onNewTerminal,
  onCloseTerminal,
  onCloseThread,
}: {
  id: string;
  state: ThreadState | undefined;
  tab: ThreadTab;
  active: boolean;
  /** The ptys the operator opened on this thread's machine. */
  terminals: ReadonlyArray<string>;
  onTab: (tab: ThreadTab) => void;
  onNewTerminal: () => void;
  onCloseTerminal: (pty: string) => void;
  onCloseThread: () => void;
}) => {
  const sessionId = threadSessionId(id);
  const reviews = (state?.entities ?? []).filter(
    (entity) => entity.kind === "pull",
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header: name, title, tabs */}
      <div className="flex items-center gap-3 border-b border-border bg-sidebar px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-semibold">
            {state?.name ?? id}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {state?.title ?? ""}
          </span>
        </div>
        {state?.status === "closed" && (
          <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0 text-[10px] text-muted-foreground">
            closed
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Hint label="The conversation — this thread's whole record">
            <button
              type="button"
              onClick={() => onTab({ kind: "chat" })}
              aria-current={tab.kind === "chat" ? "page" : undefined}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs",
                tab.kind === "chat"
                  ? "border-border bg-card font-medium shadow-xs"
                  : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <MessageSquare className="size-3.5" />
              Chat
            </button>
          </Hint>
          {reviews.map((entity) => {
            const parsed = parseEntityRef(entity.ref);
            if (parsed === undefined) return null;
            const selected =
              tab.kind === "review" &&
              tab.owner === parsed.owner &&
              tab.repo === parsed.repo &&
              tab.number === parsed.number;
            return (
              <Hint
                key={entity.ref}
                label={`Review ${entity.ref} — the diff beside the conversation`}
              >
                <button
                  type="button"
                  onClick={() =>
                    onTab({
                      kind: "review",
                      owner: parsed.owner,
                      repo: parsed.repo,
                      number: parsed.number,
                    })
                  }
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs",
                    selected
                      ? "border-border bg-card font-medium shadow-xs"
                      : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <FileDiff className="size-3.5" />#{parsed.number}
                </button>
              </Hint>
            );
          })}
          {terminals.map((pty) => {
            const selected = tab.kind === "terminal" && tab.pty === pty;
            return (
              <span
                key={pty}
                className={cn(
                  "flex h-7 items-center gap-0.5 rounded-md border pl-2 pr-1 text-xs",
                  selected
                    ? "border-border bg-card font-medium shadow-xs"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  onClick={() => onTab({ kind: "terminal", pty })}
                  aria-current={selected ? "page" : undefined}
                  title="A terminal on this thread's machine"
                  className="flex cursor-pointer items-center gap-1.5"
                >
                  <SquareTerminal className="size-3.5" />
                  {pty.slice(0, 6)}
                </button>
                <button
                  type="button"
                  onClick={() => onCloseTerminal(pty)}
                  aria-label={`close terminal ${pty}`}
                  className="cursor-pointer rounded p-0.5 hover:bg-accent"
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
          <Hint label="New terminal on this thread's machine">
            <button
              type="button"
              onClick={onNewTerminal}
              aria-label="new terminal"
              className="flex h-7 cursor-pointer items-center rounded-md border border-transparent px-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </Hint>
        </div>
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1">
        {tab.kind === "review" ? (
          <ReviewView
            key={`${tab.owner}/${tab.repo}#${tab.number}`}
            owner={tab.owner}
            repo={tab.repo}
            number={tab.number}
            threadId={id}
            active={active}
          />
        ) : (
          <>
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                tab.kind !== "chat" && "hidden",
              )}
            >
              <ChatView
                id={sessionId}
                active={active && tab.kind === "chat"}
                placeholder="Talk to the thread…"
              />
            </div>
            {terminals.map((pty) => (
              <div
                key={pty}
                className={cn(
                  "min-h-0 min-w-0 flex-1",
                  (tab.kind !== "terminal" || tab.pty !== pty) && "hidden",
                )}
              >
                <GhosttyTerminal
                  sessionId={sessionId}
                  ptyId={pty}
                  active={active && tab.kind === "terminal" && tab.pty === pty}
                />
              </div>
            ))}
            {state !== undefined && tab.kind === "chat" && (
              <Rail
                label="Thread state"
                storageKey="thread-pane-width"
                defaultWidth={320}
                minWidth={260}
              >
                <ThreadPane
                  state={state}
                  onOpenReview={(owner, repo, number) =>
                    onTab({ kind: "review", owner, repo, number })
                  }
                  onClose={onCloseThread}
                />
              </Rail>
            )}
          </>
        )}
      </div>
    </div>
  );
};

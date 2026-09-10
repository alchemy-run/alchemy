/**
 * A THREAD's page — the conversation IS the thread (the agent
 * session's chat), with the task's state in a right pane: the GitHub
 * issues and pulls assigned to it (each pull opens its review), the subagents,
 * the worktrees. Terminals open on the thread's one machine.
 */

import { ChatView, timeAgo } from "@/components/chat";
import { SessionModelSelect } from "@/components/model-select";
import { Rail } from "@/components/rail";
import { GhosttyTerminal } from "@/components/terminal";
import {
  SubagentsContext,
  OpenAgentContext,
  type SpawnTarget,
} from "@/components/tool-card";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Subagent, ThreadState } from "@/lib/channel";
import {
  agentsBulk,
  deleteAgent,
  engineerSessionId,
  parseEntityRef,
  resumeAgent,
  stopAgent,
  threadSessionId,
} from "@/lib/channel";
import type { ThreadTab } from "@/lib/routes";
import { useSelection } from "@/lib/selection";
import { cn } from "@/lib/utils";
import {
  Bot,
  Check,
  CircleDot,
  FileDiff,
  FolderGit2,
  GitMerge,
  LoaderCircle,
  GitPullRequestArrow,
  GitPullRequestClosed,
  MessageSquare,
  Play,
  Plus,
  Square,
  SquareArrowOutUpRight,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ReviewView } from "@/components/review";

const Hint = ({ label, children }: { label: string; children: ReactNode }) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="whitespace-pre-line text-xs">
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
  if (state === "merged")
    return <GitMerge className="size-3.5 text-terracotta" />;
  if (state === "closed") {
    return <GitPullRequestClosed className="size-3.5 text-brick" />;
  }
  return <GitPullRequestArrow className="size-3.5 text-moss" />;
};

/** The short name of a worktree: the part after the thread's own slug
 *  (`<thread>--pr-1521` → `pr-1521`), else the directory's name. Every
 *  tree on a thread shares the slug, so it says nothing here. */
const worktreeName = (path: string): string => {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? path;
  const cut = base.lastIndexOf("--");
  return cut === -1 ? base : base.slice(cut + 2);
};

/** An entity's worktree, as a chip: the short name, the full path on
 *  hover, the path on the clipboard on click — so a long path never
 *  decides the row's layout. */
const WorktreeChip = ({ path }: { path: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }, [path]);
  return (
    <Hint label={copied ? "Copied" : `${path}\nClick to copy the path`}>
      <button
        type="button"
        onClick={copy}
        aria-label={`copy worktree path ${path}`}
        className="ml-auto flex min-w-0 max-w-[60%] cursor-pointer items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-px font-mono text-[10px] leading-4 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3 shrink-0 text-moss" />
        ) : (
          <FolderGit2 className="size-3 shrink-0" />
        )}
        <span className="truncate">{worktreeName(path)}</span>
      </button>
    </Hint>
  );
};

const AGENT_DOT: Record<string, string> = {
  running: "bg-moss animate-pulse",
  done: "bg-muted-foreground/40",
  failed: "bg-brick",
  stopped: "bg-muted-foreground/40",
};

const Section = ({
  title,
  actions,
  children,
}: {
  title: string;
  /** Controls on the heading's right — the section-wide switches. */
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-1 border-b border-border/60 px-3 py-2.5">
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        {title}
      </div>
      {actions}
    </div>
    {children}
  </div>
);

/** A section heading's switch: tiny, quiet, labelled by what it does. */
const HeadingAction = ({
  icon: Icon,
  label,
  title,
  onClick,
  disabled,
  destructive,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={cn(
      "flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 py-0 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50",
      destructive && "hover:text-destructive",
    )}
  >
    <Icon className="size-3" />
    {label}
  </button>
);

/** The thread's state: assigned refs, agents, close, delete. */
/** The operator's switches on a thread's agents — each takes the keys
 *  it acts on (a selection, or the one agent in a pane). */
export interface AgentActions {
  /** Keys with a request in flight — rows show a spinner. */
  readonly busy: ReadonlySet<string>;
  readonly stop: (keys: ReadonlyArray<string>) => void;
  readonly resume: (keys: ReadonlyArray<string>) => void;
  /** Confirms, then erases. */
  readonly remove: (keys: ReadonlyArray<string>) => void;
}

const ThreadPane = ({
  state,
  selectedAgent,
  onOpenReview,
  onOpenAgent,
  agentActions,
  onClose,
  deleting,
  onDelete,
}: {
  state: ThreadState;
  /** The agent whose session is open in the body, if any. */
  selectedAgent: string | undefined;
  onOpenReview: (owner: string, repo: string, number: number) => void;
  onOpenAgent: (key: string) => void;
  agentActions: AgentActions;
  onClose: () => void;
  /** The thread's DELETE is in flight. */
  deleting: boolean;
  onDelete: () => void;
}) => {
  // SELECTION over the agents as listed (⌘/⇧-click select without
  // opening; a plain click opens AND selects) and the context menu
  const order = useMemo(
    () => state.agents.map((agent) => agent.key),
    [state.agents],
  );
  const pick = useSelection(order, { onDelete: agentActions.remove });
  const [menuKeys, setMenuKeys] = useState<ReadonlyArray<string>>([]);
  const menuRows = state.agents.filter((agent) => menuKeys.includes(agent.key));
  const running = menuRows.filter((agent) => agent.state === "running");
  const settled = menuRows.filter((agent) => agent.state !== "running");
  const allRunning = state.agents.filter((agent) => agent.state === "running");
  const allSettled = state.agents.filter((agent) => agent.state !== "running");
  const plural = (rows: ReadonlyArray<unknown>) =>
    rows.length > 1 ? `${rows.length} agents` : "agent";
  const agentRow = (agent: Subagent) => {
    const busy = agentActions.busy.has(agent.key);
    return (
      <button
        key={agent.key}
        type="button"
        data-agent={agent.key}
        data-state={agent.state}
        data-selected={pick.has(agent.key) ? "" : undefined}
        data-targeted={menuKeys.includes(agent.key) ? "" : undefined}
        aria-busy={busy || undefined}
        onClick={(event) => {
          if (!pick.click(agent.key, event)) onOpenAgent(agent.key);
        }}
        onContextMenu={() => setMenuKeys(pick.target(agent.key))}
        aria-label={`open agent ${agent.key}`}
        aria-current={selectedAgent === agent.key ? "page" : undefined}
        title={`${agent.brief}\n\nOpen the agent's session — every tool call, as it happens. Right-click to stop, resume, or delete.`}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent/70",
          selectedAgent === agent.key && "bg-accent",
          (pick.has(agent.key) || menuKeys.includes(agent.key)) &&
            "bg-primary/10",
        )}
      >
        {busy ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              AGENT_DOT[agent.state] ?? "bg-muted-foreground/40",
            )}
          />
        )}
        <Bot className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{agent.kind}</span> —{" "}
          {agent.brief}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">
          {timeAgo(agent.settledAt ?? agent.startedAt)}
        </span>
      </button>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Section title="Assigned">
        {state.assigned.length === 0 && (
          <div className="text-xs text-muted-foreground">
            Nothing assigned yet.
          </div>
        )}
        {state.assigned.map((entity) => {
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
              <div className="flex min-w-0 items-center gap-x-2 pl-5 text-[11px] text-muted-foreground">
                <a
                  href={`https://github.com/${entity.ref.replace("#", "/issues/")}`}
                  target="_blank"
                  rel="noreferrer"
                  title={entity.ref}
                  className="shrink-0 whitespace-nowrap hover:text-foreground hover:underline"
                >
                  {/* the number alone: a thread's assigned refs live in the one
                      connected repository, and the row is narrow */}
                  {parsed === undefined ? entity.ref : `#${parsed.number}`}
                </a>
                <span className="shrink-0">{entity.state}</span>
                {entity.worktree !== undefined && (
                  <WorktreeChip path={entity.worktree} />
                )}
              </div>
            </div>
          );
        })}
      </Section>
      <ContextMenu
        onOpenChange={(open) => {
          // the menu closing ends the gesture — target and selection go
          if (!open) {
            setMenuKeys([]);
            pick.clear();
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            onContextMenu={(event) => {
              // off a row there is nothing to act on — no menu
              if (
                !(event.target instanceof Element) ||
                event.target.closest("[data-agent]") === null
              ) {
                event.preventDefault();
              }
            }}
          >
            <Section
              title="Agents"
              actions={
                state.agents.length > 0 && (
                  <>
                    {allRunning.length > 0 && (
                      <HeadingAction
                        icon={Square}
                        label={`Stop all${allRunning.length > 1 ? ` (${allRunning.length})` : ""}`}
                        title="Stop every working agent — their commands in flight are cut"
                        onClick={() =>
                          agentActions.stop(allRunning.map((a) => a.key))
                        }
                        disabled={agentActions.busy.size > 0}
                      />
                    )}
                    {allRunning.length === 0 && allSettled.length > 0 && (
                      <HeadingAction
                        icon={Play}
                        label={`Resume all${allSettled.length > 1 ? ` (${allSettled.length})` : ""}`}
                        title="Resume every stopped agent — each picks its work back up where it was stopped"
                        onClick={() =>
                          agentActions.resume(allSettled.map((a) => a.key))
                        }
                        disabled={agentActions.busy.size > 0}
                      />
                    )}
                    <HeadingAction
                      icon={Trash2}
                      label="Delete all"
                      title="Delete every agent — sessions and transcripts erased"
                      onClick={() => agentActions.remove(order)}
                      disabled={agentActions.busy.size > 0}
                      destructive
                    />
                  </>
                )
              }
            >
              {state.agents.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No subagents yet.
                </div>
              )}
              {state.agents.map(agentRow)}
            </Section>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {menuKeys.length === 1 && (
            <>
              <ContextMenuItem onSelect={() => onOpenAgent(menuKeys[0]!)}>
                <SquareArrowOutUpRight />
                Open
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {running.length > 0 && (
            <ContextMenuItem
              onSelect={() =>
                agentActions.stop(running.map((agent) => agent.key))
              }
            >
              <Square />
              Stop {plural(running)}
            </ContextMenuItem>
          )}
          {settled.length > 0 && (
            <ContextMenuItem
              onSelect={() =>
                agentActions.resume(settled.map((agent) => agent.key))
              }
            >
              <Play />
              Resume {plural(settled)}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            // deferred a tick so the menu has closed before the confirm
            onSelect={() => setTimeout(() => agentActions.remove(menuKeys), 0)}
          >
            <Trash2 />
            Delete {plural(menuKeys)}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Section
        title="Model"
        actions={
          <SessionModelSelect
            sessionId={threadSessionId(state.id)}
            current={state.model ?? null}
            label="Thread model"
          />
        }
      >
        <div className="text-[11px] text-muted-foreground">
          What this thread's agent and its engineers sample with.
        </div>
      </Section>
      <div className="flex items-center gap-2 px-3 py-2.5">
        {state.status === "open" && (
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            title="Close the thread — make sure its work already landed"
            className="text-muted-foreground"
          >
            Close thread
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          disabled={deleting}
          aria-busy={deleting || undefined}
          title={
            deleting
              ? "Deleting — stopping its agents, dropping its worktrees, erasing its machine…"
              : "Delete the thread — its conversation, subagents, and machine are erased; the channel keeps its rows"
          }
          className="text-muted-foreground hover:text-destructive"
        >
          {deleting ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
          {deleting ? "Deleting…" : "Delete thread"}
        </Button>
      </div>
    </div>
  );
};

/**
 * The pane for a thread the server no longer knows: the rail lists it
 * (its directory row survived) but `/api/threads/:id` is a 404 — the
 * state is gone, so there is nothing to show but the way out.
 */
const MissingPane = ({
  id,
  deleting,
  onDelete,
}: {
  id: string;
  deleting: boolean;
  onDelete: () => void;
}) => (
  <div
    data-thread-missing=""
    className="flex h-full min-h-0 flex-col overflow-y-auto text-sm"
  >
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-2 rounded-full bg-destructive/70" aria-hidden />
        <span>state missing</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        The thread <code className="text-foreground">{id}</code> is listed but
        its state is gone — nothing is assigned, running, or recoverable here.
        Deleting it clears its row from the channel.
      </p>
    </div>
    <div className="mt-auto flex flex-col gap-1 px-2 py-2">
      <Button
        size="sm"
        variant="ghost"
        onClick={onDelete}
        disabled={deleting}
        aria-busy={deleting || undefined}
        title="Delete the thread — its row leaves the channel"
        className="text-muted-foreground hover:text-destructive"
      >
        {deleting ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Trash2 className="size-3.5" />
        )}
        {deleting ? "Deleting…" : "Delete thread"}
      </Button>
    </div>
  </div>
);

const AGENT_STATE_LABEL: Record<string, string> = {
  running: "working",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

/** The strip above a subagent's transcript — what it was asked and
 *  where it stands. The subagent may be missing for a moment while the
 *  thread's state catches up to a fresh spawn. */
const AgentHeader = ({
  agentKey,
  agent,
  actions,
}: {
  agentKey: string;
  agent: Subagent | undefined;
  actions: AgentActions;
}) => {
  const busy = actions.busy.has(agentKey);
  const running = agent?.state === "running";
  const control =
    "flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50";
  return (
    <div className="flex items-start gap-2 border-b border-border bg-sidebar/60 px-4 py-2">
      <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">{agent?.kind ?? "agent"}</span>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {agentKey}
          </span>
          {agent !== undefined && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              {busy ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <span
                  className={cn(
                    "size-2 rounded-full",
                    AGENT_DOT[agent.state] ?? "bg-muted-foreground/40",
                  )}
                />
              )}
              {AGENT_STATE_LABEL[agent.state] ?? agent.state}
              <span className="text-muted-foreground/70">
                · {timeAgo(agent.settledAt ?? agent.startedAt)}
              </span>
            </span>
          )}
          {agent !== undefined && (
            <span
              role="toolbar"
              aria-label="agent controls"
              className="flex shrink-0 items-center gap-1"
            >
              {running ? (
                <Hint label="Stop the agent — its command in flight is cut and its session settles. You can resume it.">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => actions.stop([agentKey])}
                    aria-label="stop agent"
                    className={control}
                  >
                    <Square className="size-3" />
                    Stop
                  </button>
                </Hint>
              ) : (
                <Hint label="Resume the agent — it picks its work back up where it was stopped; steer it from the prompt below.">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => actions.resume([agentKey])}
                    aria-label="resume agent"
                    className={control}
                  >
                    <Play className="size-3" />
                    Resume
                  </button>
                </Hint>
              )}
              <Hint label="Delete the agent — its session and transcript are erased; the thread keeps its machine.">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => actions.remove([agentKey])}
                  aria-label="delete agent"
                  className={cn(control, "hover:text-destructive")}
                >
                  <Trash2 className="size-3" />
                </button>
              </Hint>
              <SessionModelSelect
                sessionId={engineerSessionId(agentKey)}
                label="Agent model"
              />
            </span>
          )}
        </div>
        {agent !== undefined && (
          <div
            title={agent.brief}
            className="line-clamp-2 text-[12px] text-muted-foreground"
          >
            {agent.brief}
          </div>
        )}
      </div>
    </div>
  );
};

/* ── the page ─────────────────────────────────────────────────────── */

export const ThreadView = ({
  id,
  state,
  missing = false,
  tab,
  active,
  terminals,
  onTab,
  onNewTerminal,
  onCloseTerminal,
  onCloseThread,
  deleting,
  onDeleteThread,
}: {
  id: string;
  state: ThreadState | undefined;
  /** The server does not know this thread (its state is gone) though
   *  the rail still lists it — the pane offers only to delete it. */
  missing?: boolean;
  tab: ThreadTab;
  active: boolean;
  /** The ptys the operator opened on this thread's machine. */
  terminals: ReadonlyArray<string>;
  onTab: (tab: ThreadTab) => void;
  onNewTerminal: () => void;
  onCloseTerminal: (pty: string) => void;
  onCloseThread: () => void;
  /** The thread's DELETE is in flight — the server is stopping its
   *  agents, dropping its worktrees, and erasing its machine. */
  deleting: boolean;
  onDeleteThread: () => void;
}) => {
  const sessionId = threadSessionId(id);
  const reviews = (state?.assigned ?? []).filter(
    (entity) => entity.kind === "pull",
  );
  const agents = state?.agents ?? [];
  const openAgent = tab.kind === "agent" ? tab.key : undefined;
  const openSubagent = agents.find((agent) => agent.key === openAgent);

  // a spawn card names its agent by key once settled; while it is
  // still working only the brief is on the wire — match that to the
  // thread's agents, newest first, so the running one wins
  const onOpenSpawn = useCallback(
    (target: SpawnTarget) => {
      const found =
        (target.key !== undefined
          ? agents.find((agent) => agent.key === target.key)
          : undefined) ??
        [...agents]
          .sort((a, b) => b.startedAt - a.startedAt)
          .find((agent) => agent.brief === target.brief);
      if (found !== undefined) onTab({ kind: "agent", key: found.key });
    },
    [agents, onTab],
  );

  // THE SWITCHES on this thread's agents. The thread's state frame
  // carries the outcome (stopped, running again, gone); `busy` covers
  // the request's flight so a row shows it is being acted on.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const act = useCallback(
    (
      keys: ReadonlyArray<string>,
      verb: "stop" | "resume" | "delete",
      after?: (key: string) => void,
    ) => {
      if (keys.length === 0) return;
      setBusy((current) => new Set([...current, ...keys]));
      const done = (settled: ReadonlyArray<string>, ok: boolean) => {
        setBusy((current) => {
          const next = new Set(current);
          for (const key of settled) next.delete(key);
          return next;
        });
        if (ok) for (const key of settled) after?.(key);
      };
      const single =
        verb === "stop"
          ? stopAgent
          : verb === "resume"
            ? resumeAgent
            : deleteAgent;
      // one agent: its own switch; several: ONE bulk request — the
      // server fans out and answers once, so a selection of twelve is
      // not twelve round-trips racing each other
      const request =
        keys.length === 1 ? single(id, keys[0]!) : agentsBulk(id, verb, keys);
      void request
        .then(
          (response) => response.ok,
          () => false,
        )
        .then((ok) => done(keys, ok));
    },
    [id],
  );
  const agentActions = useMemo<AgentActions>(
    () => ({
      busy,
      stop: (keys) => act(keys, "stop"),
      resume: (keys) => act(keys, "resume"),
      remove: (keys) => {
        if (keys.length === 0) return;
        const what =
          keys.length === 1 ? "this agent" : `these ${keys.length} agents`;
        if (
          !window.confirm(
            `Delete ${what}? The session and its transcript are erased. This can't be undone.`,
          )
        ) {
          return;
        }
        act(keys, "delete", (key) => {
          // the pane that showed it has nothing to show
          if (openAgent === key) onTab({ kind: "chat" });
        });
      },
    }),
    [act, busy, id, onTab, openAgent],
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
          {openAgent !== undefined && (
            <span className="flex h-7 items-center gap-0.5 rounded-md border border-border bg-card pl-2 pr-1 text-xs font-medium shadow-xs">
              <span
                aria-current="page"
                title={openSubagent?.brief ?? openAgent}
                className="flex items-center gap-1.5"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    AGENT_DOT[openSubagent?.state ?? ""] ??
                      "bg-muted-foreground/40",
                  )}
                />
                <Bot className="size-3.5" />
                {openSubagent?.kind ?? "agent"}
              </span>
              <button
                type="button"
                onClick={() => onTab({ kind: "chat" })}
                aria-label="close agent"
                className="cursor-pointer rounded p-0.5 hover:bg-accent"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
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

      {deleting && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground"
        >
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          <span>
            <span className="font-medium text-foreground">
              Deleting this thread
            </span>{" "}
            — stopping its agents, dropping its worktrees, erasing its machine…
          </span>
        </div>
      )}

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
              <OpenAgentContext.Provider value={onOpenSpawn}>
                {/* the subagents, so a spawn card reads its agent's real
                    state — stopped, deleted — not the open call's */}
                <SubagentsContext.Provider value={state?.agents}>
                  <ChatView
                    id={sessionId}
                    active={active && tab.kind === "chat"}
                    placeholder="Talk to the thread…"
                  />
                </SubagentsContext.Provider>
              </OpenAgentContext.Provider>
            </div>
            {openAgent !== undefined && (
              <div
                data-agent-session={openAgent}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                <AgentHeader
                  agentKey={openAgent}
                  agent={openSubagent}
                  actions={agentActions}
                />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {/* the prompt is live while the agent is: a settled
                      session ignores input — Resume brings it back */}
                  <ChatView
                    key={openAgent}
                    id={engineerSessionId(openAgent)}
                    active={active}
                    readOnly={openSubagent?.state !== "running"}
                    placeholder="Steer the agent…"
                  />
                </div>
              </div>
            )}
            {terminals.map((pty) => (
              <div
                key={pty}
                className={cn(
                  "flex min-h-0 min-w-0 flex-1 flex-col",
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
            {(state !== undefined || missing) &&
              (tab.kind === "chat" || tab.kind === "agent") && (
                <Rail
                  label="Thread state"
                  storageKey="thread-pane-width"
                  defaultWidth={320}
                  minWidth={260}
                >
                  {state !== undefined ? (
                    <ThreadPane
                      state={state}
                      selectedAgent={openAgent}
                      onOpenReview={(owner, repo, number) =>
                        onTab({ kind: "review", owner, repo, number })
                      }
                      onOpenAgent={(key) => onTab({ kind: "agent", key })}
                      agentActions={agentActions}
                      onClose={onCloseThread}
                      deleting={deleting}
                      onDelete={onDeleteThread}
                    />
                  ) : (
                    <MissingPane
                      id={id}
                      deleting={deleting}
                      onDelete={onDeleteThread}
                    />
                  )}
                </Rail>
              )}
          </>
        )}
      </div>
    </div>
  );
};

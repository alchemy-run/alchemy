import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { RefHoverCard } from "@/components/ref-hover-card";
import { GhosttyTerminal } from "@/components/terminal";
import { hasToolCard, ToolCard } from "@/components/tool-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAnchoredToggle } from "@/lib/anchor";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { useAgent, useChat } from "alchemy/AI/React";
import {
  AlarmClock,
  CircleDot,
  GitMerge,
  GitPullRequestArrow,
  MessageSquare,
  Play,
  Square,
  Trash2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface BoardThread {
  id: string;
  term: string;
  key: string;
  status: "running" | "idle" | "settled" | "crashed";
  ticks: number;
  createdAt: number;
  updatedAt: number;
  firstInput?: string | null;
}

interface BoardPullRequest {
  number: number;
  title: string;
  state: "open" | "closed" | "unknown";
  updatedAt: number;
  /** The review session, once the bot has been admitted for this PR. */
  session: BoardThread | undefined;
}

interface Board {
  /** `owner/repo` — the repository the bot reviews. */
  repo: string;
  prs: BoardPullRequest[];
}

interface ApprovalRequest {
  id: string;
  session: { term: string; key: string };
  action: string;
  at: number;
}

/** A connected repository — STATIC code (src/Repos.ts), reflected
 *  read-only by /api/repos. Never runtime-editable. */
interface RepoInfo {
  name: string;
  sessions: boolean;
  reviews: boolean;
}

/**
 * KEY CONVENTIONS. A coding SESSION owns one sandbox MicroVM and has
 * 1..* THREADS. Thread keys are `<session>` (the base thread) or
 * `<session>::<thread>`; the server derives the machine from the
 * session part, so every thread and the terminal share the machine.
 * Session keys are `<owner>/<repo>/<name>` (legacy keys without a
 * connected-repo prefix group as unscoped).
 */
const splitThreadKey = (
  key: string,
): { session: string; thread: string | undefined } => {
  const at = key.indexOf("::");
  return at < 0
    ? { session: key, thread: undefined }
    : { session: key.slice(0, at), thread: key.slice(at + 2) };
};

const sessionOfId = (id: string | undefined): string | undefined =>
  id !== undefined && id.startsWith("Engineer:")
    ? splitThreadKey(id.slice("Engineer:".length)).session
    : undefined;

/** The hash names a thread, or nothing — there is NO default session:
 *  merely mounting a chat view attaches a socket, which ADMITS the
 *  session server-side, so a default here would resurrect itself on
 *  every load (and after every delete). */
const threadFromHash = (): string | undefined => {
  const raw = decodeURIComponent(window.location.hash.slice(1));
  return raw.startsWith("Engineer:") || raw.startsWith("ReviewBot:")
    ? raw
    : undefined;
};

const ISSUE_STATE: Record<BoardPullRequest["state"], string> = {
  open: "text-moss border-moss/40",
  closed: "text-terracotta border-terracotta/40",
  unknown: "text-muted-foreground border-border",
};

/** The `#N` pill — GitHub-linked (with hover preview) when the repo
 *  is known (the review session's key IS the repository ref). */
const IssueBadge = ({
  number,
  state,
  repo,
}: {
  number: number;
  state: BoardPullRequest["state"];
  repo: string | undefined;
}) => {
  const badge = (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0 font-mono text-[10px] leading-4",
        ISSUE_STATE[state],
        repo && "hover:bg-accent",
      )}
    >
      #{number}
    </span>
  );
  return repo ? (
    <RefHoverCard repo={repo} number={number}>
      <a
        href={`https://github.com/${repo}/issues/${number}`}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        {badge}
      </a>
    </RefHoverCard>
  ) : (
    badge
  );
};

/** Short relative age for the sidebar; the tooltip has the full form. */
const timeAgo = (at: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const statusDot: Record<BoardThread["status"], string> = {
  running: "bg-emerald-500 animate-pulse",
  idle: "bg-muted-foreground/40",
  settled: "bg-muted-foreground/20",
  crashed: "bg-red-500",
};

/** A thread's sidebar title: its first message, else a placeholder. */
const threadTitle = (thread: BoardThread | undefined): string => {
  const first = thread?.firstInput?.trim();
  return first !== undefined && first !== null && first.length > 0
    ? first
    : "New thread";
};

/** A thread's TAB label: first input (truncated), else its suffix. */
const tabTitle = (thread: BoardThread): string => {
  const first = thread.firstInput?.trim();
  if (first !== undefined && first !== null && first.length > 0) {
    return first.length > 28 ? `${first.slice(0, 28)}…` : first;
  }
  return splitThreadKey(thread.key).thread ?? "main";
};

/** Session status rollup: the most alive thread wins. */
const SESSION_STATUS_ORDER: Array<BoardThread["status"]> = [
  "running",
  "idle",
  "crashed",
  "settled",
];

interface SessionGroup {
  /** The full session key (repo prefix included when present). */
  session: string;
  repo: string | undefined;
  /** The session key minus its repo prefix — the sidebar label. */
  label: string;
  /** The session's threads, oldest first (tab order). */
  threads: BoardThread[];
  status: BoardThread["status"];
  updatedAt: number;
}

const groupSessions = (
  threads: BoardThread[],
  repos: RepoInfo[],
): SessionGroup[] => {
  const bySession = new Map<string, BoardThread[]>();
  for (const thread of threads) {
    const { session } = splitThreadKey(thread.key);
    const list = bySession.get(session);
    if (list === undefined) bySession.set(session, [thread]);
    else list.push(thread);
  }
  return [...bySession.entries()]
    .map(([session, group]): SessionGroup => {
      const repo = repos.find((entry) =>
        session.startsWith(`${entry.name}/`),
      )?.name;
      return {
        session,
        repo,
        label: repo === undefined ? session : session.slice(repo.length + 1),
        threads: [...group].sort((a, b) => a.createdAt - b.createdAt),
        status:
          SESSION_STATUS_ORDER.find((status) =>
            group.some((thread) => thread.status === status),
          ) ?? "idle",
        updatedAt: Math.max(...group.map((thread) => thread.updatedAt)),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

export const App = () => {
  const [threads, setThreads] = useState<BoardThread[]>([]);
  const [board, setBoard] = useState<Board>({ repo: "", prs: [] });
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(threadFromHash);
  // visited threads stay MOUNTED (visibility-hidden) so switching
  // back preserves scroll position and the streaming tail
  const [visited, setVisited] = useState<string[]>(() => {
    const id = threadFromHash();
    return id === undefined ? [] : [id];
  });
  // PRs whose review the user requested — auto-select when the
  // session lands on the board stream
  const [requested, setRequested] = useState<Set<number>>(() => new Set());
  // the two ACTIVITIES (Code | Review) each remember their last
  // selection, so flipping tabs restores where you were
  const [activity, setActivity] = useState<"code" | "review">(() =>
    threadFromHash()?.startsWith("ReviewBot:") ? "review" : "code",
  );
  const [codeId, setCodeId] = useState<string | undefined>(() => {
    const id = threadFromHash();
    return id?.startsWith("Engineer:") ? id : undefined;
  });
  const [reviewId, setReviewId] = useState<string | undefined>(() => {
    const id = threadFromHash();
    return id?.startsWith("ReviewBot:") ? id : undefined;
  });
  // per-session TERMINAL tab selection + lazy mounting (a terminal
  // mounts on first visit and stays mounted, like chat views)
  const [terminalSel, setTerminalSel] = useState<Record<string, boolean>>({});
  const [terminalVisited, setTerminalVisited] = useState<string[]>([]);

  /** Route to a thread id — updates the hash, the activity, and the
   *  per-activity memory. Selecting a thread deselects the session's
   *  terminal tab; `undefined` clears the selection (empty state). */
  const apply = (id: string | undefined) => {
    setActiveId(id);
    if (id === undefined) {
      setCodeId(undefined);
      return;
    }
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
    if (id.startsWith("Engineer:")) {
      setCodeId(id);
      setActivity("code");
      const session = sessionOfId(id);
      if (session !== undefined) {
        setTerminalSel((current) => ({ ...current, [session]: false }));
      }
    } else if (id.startsWith("ReviewBot:")) {
      setReviewId(id);
      setActivity("review");
    }
  };

  const open = (id: string) => {
    window.location.hash = encodeURIComponent(id);
    apply(id);
  };

  /** Clear the code selection (after deleting the current session). */
  const closeCode = () => {
    window.location.hash = "";
    apply(undefined);
  };

  /** A PR with no review session: clicking REQUESTS its review — the
   *  server synthesizes the opened event and the session appears. */
  const requestReview = (number: number) => {
    setRequested((current) => new Set(current).add(number));
    void fetch(`/api/prs/${number}/review`, { method: "POST" }).catch(() => {
      setRequested((current) => {
        const next = new Set(current);
        next.delete(number);
        return next;
      });
    });
  };

  // back/forward navigation drives the same path
  useEffect(() => {
    const onHash = () => apply(threadFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // the CONNECTED repositories — static code, fetched once
  useEffect(() => {
    fetch("/api/repos")
      .then(
        (response) =>
          (response.ok ? response.json() : []) as Promise<RepoInfo[]>,
      )
      .then(setRepos)
      .catch(() => {});
  }, []);

  // the thread list: poll — threads appear the moment their session
  // is admitted (opening a thread attaches, which admits)
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/chats")
        .then(
          (response) =>
            (response.ok ? response.json() : []) as Promise<BoardThread[]>,
        )
        .then((board) => {
          if (live) setThreads(board.filter((t) => t.term === "Engineer"));
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // The PR board: SSE of snapshots (falls back to polling when the
  // stream is unavailable — old deploys, proxy buffers, …).
  useEffect(() => {
    let live = true;
    const apply = (data: Board) => {
      if (live) setBoard(data);
    };
    const source = new EventSource("/api/board/stream");
    source.onmessage = (event) => {
      try {
        apply(JSON.parse(event.data) as Board);
      } catch {
        // ignore malformed frames
      }
    };
    let interval: ReturnType<typeof setInterval> | undefined;
    source.onerror = () => {
      if (interval !== undefined) return;
      const tick = () =>
        fetch("/api/board")
          .then((response) => response.json() as Promise<Board>)
          .then(apply)
          .catch(() => {});
      tick();
      interval = setInterval(tick, 3000);
    };
    return () => {
      live = false;
      source.close();
      if (interval !== undefined) clearInterval(interval);
    };
  }, []);

  // a REQUESTED review's session just appeared — jump to it
  useEffect(() => {
    for (const pull of board.prs) {
      if (pull.session !== undefined && requested.has(pull.number)) {
        setRequested((current) => {
          const next = new Set(current);
          next.delete(pull.number);
          return next;
        });
        open(pull.session.id);
        return;
      }
    }
  }, [board.prs, requested]);

  // the OPERATOR's gate: pending approval requests (armed deploys
  // only — the list stays empty when ORG_APPROVALS is unset)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/approvals")
        .then(
          (response) =>
            (response.ok ? response.json() : []) as Promise<ApprovalRequest[]>,
        )
        .then((list) => {
          if (live) setApprovals(list);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const answerApproval = (id: string, outcome: "allowed-once" | "rejected") => {
    setApprovals((current) => current.filter((request) => request.id !== id));
    void fetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome }),
    }).catch(() => {});
  };

  const randomSuffix = () =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  /** The new-session prompt (dialog subject): the target repo and the
   *  editable name, pre-filled with a generated one. */
  const [newSessionPrompt, setNewSessionPrompt] = useState<
    { repo: string | undefined; name: string } | undefined
  >(undefined);

  /** A new SESSION under a connected repo — one sandbox MicroVM. The
   *  dialog opens with a generated name selected: type to replace it,
   *  or just press Enter to take it. */
  const newSession = (repo: string | undefined) =>
    setNewSessionPrompt({ repo, name: `s-${randomSuffix()}` });

  const commitNewSession = () => {
    if (newSessionPrompt === undefined) return;
    const name = newSessionPrompt.name.trim().replace(/\s+/g, "-");
    if (name.length === 0) return;
    const { repo } = newSessionPrompt;
    setNewSessionPrompt(undefined);
    open(`Engineer:${repo === undefined ? name : `${repo}/${name}`}`);
  };

  /** A new THREAD in a session — rides the session's machine. */
  const newThread = (session: string) =>
    open(`Engineer:${session}::t-${randomSuffix()}`);

  /** The terminal tab: mounts on first visit, stays mounted. */
  const openTerminal = (session: string) => {
    setTerminalSel((current) => ({ ...current, [session]: true }));
    setTerminalVisited((current) =>
      current.includes(session) ? current : [...current, session],
    );
  };

  /** The off switch: settle the session in place — terminal, the
   *  transcript stays readable. Optimistic; the poll corrects. */
  const stopThread = (id: string) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === id ? { ...thread, status: "settled" } : thread,
      ),
    );
    void fetch(`/api/chats/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    }).catch(() => {});
  };

  /** Stop every live thread of a session. */
  const stopSession = (group: SessionGroup) => {
    for (const thread of group.threads) {
      if (thread.status === "running" || thread.status === "idle") {
        stopThread(thread.id);
      }
    }
  };

  /** The undo for stop: reopen a settled thread in place — the
   *  transcript continues. Optimistic; the poll corrects. */
  const resumeThread = (id: string) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === id ? { ...thread, status: "idle" } : thread,
      ),
    );
    void fetch(`/api/chats/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    }).catch(() => {});
  };

  /** Resume every settled thread of a session. */
  const resumeSession = (group: SessionGroup) => {
    for (const thread of group.threads) {
      if (thread.status === "settled") {
        resumeThread(thread.id);
      }
    }
  };

  /** The session awaiting delete confirmation (the dialog's subject). */
  const [confirmDelete, setConfirmDelete] = useState<SessionGroup | undefined>(
    undefined,
  );
  /** Sessions mid-delete: the row stays listed with a spinner until
   *  the server confirms — deleting settles the session, purges its
   *  transcripts, and terminates its machine, which takes seconds. */
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());

  /** The eraser, once confirmed: stop + purge every thread of the
   *  session and terminate its machine. The row unlists only when the
   *  server is DONE — no optimistic vanish that snaps back. */
  const deleteSession = async (group: SessionGroup) => {
    setConfirmDelete(undefined);
    setDeleting((current) => new Set(current).add(group.session));
    const ids = new Set(group.threads.map((thread) => thread.id));
    // navigate away + unmount its views first (closes sockets client-side)
    setVisited((current) => current.filter((id) => !ids.has(id)));
    setTerminalVisited((current) =>
      current.filter((session) => session !== group.session),
    );
    if (sessionOfId(codeId) === group.session) closeCode();
    await Promise.allSettled(
      [...ids].map((id) =>
        fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" }),
      ),
    );
    setThreads((current) => current.filter((thread) => !ids.has(thread.id)));
    setDeleting((current) => {
      const next = new Set(current);
      next.delete(group.session);
      return next;
    });
  };

  // the active/code thread is listed even before the board knows it
  // (a just-created thread has no row yet). Review sessions live in
  // the Review activity, never here.
  const list = useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    for (const id of [activeId, codeId]) {
      if (id !== undefined && !byId.has(id) && id.startsWith("Engineer:")) {
        byId.set(id, {
          id,
          term: "Engineer",
          key: id.slice("Engineer:".length),
          status: "idle",
          ticks: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          firstInput: null,
        });
      }
    }
    return [...byId.values()];
  }, [threads, activeId, codeId]);

  /** Sessions (threads grouped by `::`-stripped key), newest first. */
  const groups = useMemo(() => groupSessions(list, repos), [list, repos]);

  const currentSession = sessionOfId(codeId);
  const currentGroup = groups.find(
    (group) => group.session === currentSession,
  );
  const terminalActive =
    currentSession !== undefined && terminalSel[currentSession] === true;

  /** Sidebar buckets: one per connected `sessions: true` repo, plus
   *  an unscoped bucket for legacy keys (`main`, `t-…`). */
  const repoBuckets = useMemo(() => {
    const buckets: Array<{
      repo: string | undefined;
      groups: SessionGroup[];
    }> = repos
      .filter((repo) => repo.sessions)
      .map((repo) => ({
        repo: repo.name,
        groups: groups.filter((group) => group.repo === repo.name),
      }));
    const unscoped = groups.filter((group) => group.repo === undefined);
    if (unscoped.length > 0 || buckets.length === 0) {
      buckets.push({ repo: undefined, groups: unscoped });
    }
    return buckets;
  }, [groups, repos]);

  const openPrCount = board.prs.filter((pull) => pull.state === "open").length;
  const reviewRef = reviewId?.match(/^ReviewBot:(.+)#(\d+)$/);

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* NEW SESSION — a generated name, pre-selected: type to replace,
          Enter to take it. The commonest action gets the fastest path. */}
      <Dialog
        open={newSessionPrompt !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) setNewSessionPrompt(undefined);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              commitNewSession();
            }}
          >
            <DialogHeader>
              <DialogTitle>New session</DialogTitle>
              <DialogDescription>
                {newSessionPrompt?.repo !== undefined ? (
                  <>
                    A machine of its own under{" "}
                    <span className="font-mono">{newSessionPrompt.repo}</span>{" "}
                    — threads and terminal share it.
                  </>
                ) : (
                  "A machine of its own — threads and terminal share it."
                )}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={newSessionPrompt?.name ?? ""}
              onChange={(event) =>
                setNewSessionPrompt((current) =>
                  current === undefined
                    ? current
                    : { ...current, name: event.target.value },
                )
              }
              onFocus={(event) => event.currentTarget.select()}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-sm"
              aria-label="Session name"
            />
            <DialogFooter showCloseButton={false}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setNewSessionPrompt(undefined)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={(newSessionPrompt?.name.trim() ?? "") === ""}
              >
                Create session
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* DELETE CONFIRMATION — the eraser is irreversible (transcripts +
          machine), so it asks first; the row then spins until the server
          confirms. */}
      <Dialog
        open={confirmDelete !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmDelete(undefined);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete session</DialogTitle>
            <DialogDescription>
              {confirmDelete !== undefined && (
                <>
                  <span className="font-mono text-foreground">
                    {confirmDelete.label}
                  </span>{" "}
                  — {confirmDelete.threads.length} thread
                  {confirmDelete.threads.length === 1 ? "" : "s"}, its
                  transcripts, and its machine will be permanently deleted.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton={false}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirmDelete !== undefined) void deleteSession(confirmDelete);
              }}
            >
              <Trash2 /> Delete session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        {/* THE ACTIVITIES: Code (sessions) | Review (pull requests) */}
        <div className="flex border-b border-border">
          {(["code", "review"] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setActivity(name)}
              className={cn(
                "flex-1 border-b-2 px-3 py-2 font-mono text-xs",
                activity === name
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {name === "code" ? "Code" : `Review${openPrCount > 0 ? ` (${openPrCount})` : ""}`}
            </button>
          ))}
        </div>
        {activity === "code" ? (
          /* SESSIONS grouped under their CONNECTED repo (static code) */
          <div className="min-h-0 flex-1 overflow-y-auto">
            {repoBuckets.map((bucket) => (
              <div key={bucket.repo ?? "~unscoped"}>
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  {bucket.repo !== undefined ? (
                    <a
                      href={`https://github.com/${bucket.repo}`}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-mono text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      {bucket.repo}
                    </a>
                  ) : (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      unscoped
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => newSession(bucket.repo)}
                    className="rounded border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    + session
                  </button>
                </div>
                {bucket.groups.map((group) => (
                  <div
                    key={group.session}
                    onClick={() => {
                      // a session mid-delete is not navigable
                      if (deleting.has(group.session)) return;
                      open(
                        [...group.threads].sort(
                          (a, b) => b.updatedAt - a.updatedAt,
                        )[0]!.id,
                      );
                    }}
                    className={cn(
                      "group flex w-full cursor-pointer flex-col gap-1 border-b border-border/50 px-3 py-2 text-left hover:bg-accent/50",
                      group.session === currentSession && "bg-accent",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {deleting.has(group.session) ? (
                        <Spinner className="size-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <span
                          className={cn(
                            "inline-block size-1.5 shrink-0 rounded-full",
                            statusDot[group.status] ?? statusDot.idle,
                          )}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
                        {group.label}
                      </span>
                      {!deleting.has(group.session) && (
                        <>
                          {(group.status === "running" ||
                            group.status === "idle") && (
                            <button
                              type="button"
                              title="Stop session"
                              onClick={(event) => {
                                event.stopPropagation();
                                stopSession(group);
                              }}
                              className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground group-hover:block"
                            >
                              <Square className="size-3" />
                            </button>
                          )}
                          {group.status === "settled" && (
                            <button
                              type="button"
                              title="Resume session"
                              onClick={(event) => {
                                event.stopPropagation();
                                resumeSession(group);
                              }}
                              className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground group-hover:block"
                            >
                              <Play className="size-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            title="Delete session"
                            onClick={(event) => {
                              event.stopPropagation();
                              setConfirmDelete(group);
                            }}
                            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-border hover:text-terracotta group-hover:block"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 pl-3 font-mono text-[10px] text-muted-foreground">
                      {group.threads.length} thread
                      {group.threads.length === 1 ? "" : "s"} ·{" "}
                      {deleting.has(group.session) ? "deleting…" : group.status}
                      <span className="ml-auto">
                        <AtTooltip at={group.updatedAt}>
                          <span className="cursor-default">
                            {timeAgo(group.updatedAt)}
                          </span>
                        </AtTooltip>
                      </span>
                    </span>
                  </div>
                ))}
                {bucket.groups.length === 0 && (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No sessions yet.
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          /* THE PULL REQUESTS — one review session each */
          <div className="min-h-0 flex-1 overflow-y-auto">
            {board.repo && (
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <a
                  href={`https://github.com/${board.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-mono text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {board.repo}
                </a>
              </div>
            )}
            {board.prs.map((pull) => {
              const repo = board.repo || pull.session?.key.split("#")[0];
              return (
                <button
                  key={pull.number}
                  type="button"
                  onClick={() =>
                    pull.session !== undefined
                      ? open(pull.session.id)
                      : requestReview(pull.number)
                  }
                  className={cn(
                    "flex w-full items-center gap-2 border-b border-border/50 px-3 py-2.5 text-left hover:bg-accent/50",
                    pull.session?.id === reviewId && "bg-accent",
                  )}
                >
                  <IssueBadge
                    number={pull.number}
                    state={pull.state}
                    repo={repo}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {pull.title}
                  </span>
                  {pull.session?.status === "running" && (
                    <span className="size-2 shrink-0 animate-pulse rounded-full bg-moss" />
                  )}
                  {pull.session === undefined && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {requested.has(pull.number) ? "reviewing…" : "review"}
                    </span>
                  )}
                </button>
              );
            })}
            {board.prs.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">
                No pull requests yet — open one on the repository and the
                bot reviews it.
              </div>
            )}
          </div>
        )}
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* ── CODE: the session surface — tabbed threads + terminal ── */}
        <div
          className={cn(
            "absolute inset-0 flex flex-col",
            activity === "code" ? "visible" : "pointer-events-none invisible",
          )}
        >
          {currentGroup !== undefined && (
            <div className="flex items-center gap-0.5 border-b border-border px-2">
              {currentGroup.threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => open(thread.id)}
                  className={cn(
                    "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs",
                    thread.id === codeId && !terminalActive
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block size-1.5 shrink-0 rounded-full",
                      statusDot[thread.status] ?? statusDot.idle,
                    )}
                  />
                  <span className="max-w-48 truncate">{tabTitle(thread)}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => openTerminal(currentGroup.session)}
                className={cn(
                  "border-b-2 px-3 py-2 font-mono text-xs",
                  terminalActive
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {">_"} terminal
              </button>
              <button
                type="button"
                title="New thread (shares this session's machine)"
                onClick={() => newThread(currentGroup.session)}
                className="px-2 py-2 font-mono text-sm text-muted-foreground hover:text-foreground"
              >
                +
              </button>
              <span className="ml-auto pr-2 font-mono text-[10px] text-muted-foreground">
                one machine · {currentGroup.threads.length} thread
                {currentGroup.threads.length === 1 ? "" : "s"}
              </span>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {codeId === undefined && !terminalActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <span className="font-mono text-xs text-muted-foreground">
                  no session selected
                </span>
                <button
                  type="button"
                  onClick={() =>
                    newSession(repos.find((repo) => repo.sessions)?.name)
                  }
                  className="rounded border border-border px-3 py-1 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  + new session
                </button>
              </div>
            )}
            {visited
              .filter((id) => id.startsWith("Engineer:"))
              .map((id) => {
                const shown =
                  activity === "code" && id === codeId && !terminalActive;
                return (
                  <div
                    key={id}
                    className={cn(
                      "absolute inset-0 flex flex-col",
                      shown ? "visible" : "pointer-events-none invisible",
                    )}
                  >
                    <ChatView
                      id={id}
                      active={shown}
                      agents={[]}
                      breadcrumb={undefined}
                      onOpenThread={open}
                    />
                  </div>
                );
              })}
            {terminalVisited.map((session) => {
              const shown =
                activity === "code" &&
                session === currentSession &&
                terminalActive;
              return (
                <div
                  key={session}
                  className={cn(
                    "absolute inset-0 flex flex-col",
                    shown ? "visible" : "pointer-events-none invisible",
                  )}
                >
                  <GhosttyTerminal
                    sessionId={`Engineer:${session}`}
                    active={shown}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {/* ── REVIEW: the pull-request surface ── */}
        <div
          className={cn(
            "absolute inset-0 flex flex-col",
            activity === "review"
              ? "visible"
              : "pointer-events-none invisible",
          )}
        >
          {reviewRef && (
            <div className="flex items-center gap-3 border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
              <span className="truncate">
                {reviewRef[1]}#{reviewRef[2]}
              </span>
              <a
                href={`https://github.com/${reviewRef[1]}/pull/${reviewRef[2]}`}
                target="_blank"
                rel="noreferrer"
                className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 hover:bg-accent hover:text-foreground"
              >
                open on GitHub ↗
              </a>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {visited
              .filter((id) => id.startsWith("ReviewBot:"))
              .map((id) => {
                const shown = activity === "review" && id === reviewId;
                return (
                  <div
                    key={id}
                    className={cn(
                      "absolute inset-0 flex flex-col",
                      shown ? "visible" : "pointer-events-none invisible",
                    )}
                  >
                    <ChatView
                      id={id}
                      active={shown}
                      agents={[]}
                      breadcrumb={undefined}
                      onOpenThread={open}
                    />
                  </div>
                );
              })}
            {reviewId === undefined && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a pull request — or click “review” to request one.
              </div>
            )}
          </div>
        </div>
        {/* the operator's gate — one card per pending approval */}
        {approvals.length > 0 && (
          <div className="absolute bottom-4 right-4 z-20 flex w-96 flex-col gap-2">
            {approvals.map((request) => (
              <div
                key={request.id}
                className="rounded-lg border border-honey/50 bg-background p-3 shadow-lg"
              >
                <div className="mb-1 font-mono text-[10px] uppercase text-honey">
                  approval requested
                </div>
                <button
                  type="button"
                  onClick={() => open(`${request.session.term}:${request.session.key}`)}
                  className="mb-2 block w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {request.session.key}
                </button>
                <div className="mb-3 text-sm">{request.action}</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => answerApproval(request.id, "allowed-once")}
                    className="flex-1 rounded border border-moss/50 px-2 py-1 text-xs text-moss hover:bg-moss/10"
                  >
                    approve once
                  </button>
                  <button
                    type="button"
                    onClick={() => answerApproval(request.id, "rejected")}
                    className="flex-1 rounded border border-brick/50 px-2 py-1 text-xs text-brick hover:bg-brick/10"
                  >
                    reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};


interface ChatContext {
  /** The channel's dispatched workers — dispatch cards link to them. */
  agents: BoardThread[];
  /** Set when this chat is itself a worker: the way back up. */
  breadcrumb: { label: string; to: string } | undefined;
  onOpenThread: (id: string) => void;
}

const ChatView = ({
  id,
  active,
  ...context
}: { id: string; active: boolean } & ChatContext) => {
  const [initial, setInitial] = useState<{
    messages: UIMessage[];
    /** Snapshot delivered → socket tails live; 404 (the Cloudflare
     *  placement keeps transcripts in each session's own DO) → the
     *  socket replays the full history instead. */
    hydrated: boolean;
  }>();

  // snapshot first; the live tail rides the run socket. Drop the
  // snapshot's in-flight `live-*` sample — the socket restates that
  // burst durably, and keeping both renders the reasoning twice (one
  // stuck on "Thinking…" forever).
  useEffect(() => {
    fetch(`/api/chats/${encodeURIComponent(id)}/messages`)
      .then(async (response) =>
        response.ok
          ? {
              messages: ((await response.json()) as UIMessage[]).filter(
                (m) => !m.id.startsWith("live-"),
              ),
              hydrated: true,
            }
          : { messages: [], hydrated: false },
      )
      .then(setInitial)
      .catch(() => setInitial({ messages: [], hydrated: false }));
  }, [id]);

  if (initial === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  return (
    <Chat
      id={id}
      initial={initial.messages}
      hydrated={initial.hydrated}
      active={active}
      {...context}
    />
  );
};

/** Full local timestamp, tooltip-grade: "Sun, Mar 1, 2026, 02:54:07". */
const formatFull = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** A hover/click tooltip carrying the full timestamp. */
const AtTooltip = ({ at, children }: { at: number; children: ReactNode }) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-xs">
        {formatFull(at)}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

/** Compact time for the gutter — day context lives in the dividers. */
const formatAt = (at: number | undefined): string => {
  if (at === undefined || !Number.isFinite(at)) return "";
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

/** Calendar-day key for divider boundaries. */
const dayOf = (at: number | undefined): string | undefined =>
  at === undefined || !Number.isFinite(at)
    ? undefined
    : new Date(at).toDateString();

/** "Mar 1" (+ year when not this year) — the day-divider label. */
const formatDay = (at: number): string => {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

/** GitHub event families → timeline icon + accent. */
const EVENT_FAMILY: Array<[RegExp, { icon: LucideIcon; className: string }]> = [
  [/^PullRequestMerged/, { icon: GitMerge, className: "text-terracotta" }],
  [/^PullRequest/, { icon: GitPullRequestArrow, className: "text-terracotta" }],
  [/^IssueComment/, { icon: MessageSquare, className: "text-mist" }],
  [/^Issue/, { icon: CircleDot, className: "text-moss" }],
  [
    /^(CheckRun|CheckSuite|WorkflowRun|Push)/,
    { icon: Zap, className: "text-honey" },
  ],
];

/** Humanized verb phrases for the common tags; the fallback spaces
 *  out the PascalCase (`ReviewRequested` → "review requested"). */
const EVENT_VERB: Record<string, string> = {
  IssueOpened: "opened issue",
  IssueClosed: "closed issue",
  IssueReopened: "reopened issue",
  IssueCommentCreated: "commented on",
  PullRequestOpened: "opened pull request",
  PullRequestMerged: "merged pull request",
  PullRequestClosed: "closed pull request",
  PullRequestReviewSubmitted: "reviewed",
};

const eventVerb = (tag: string): string =>
  EVENT_VERB[tag] ?? tag.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ").toLowerCase();

interface WorldEvent {
  tag: string;
  repo?: string;
  number?: number;
  title?: string;
  author?: string;
  body?: string;
  url?: string;
}

/** Best-effort parse of an input text as a tagged GitHub world event. */
const parseWorldEvent = (
  text: string,
): { event: WorldEvent; raw: string } | undefined => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, any>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const tag = parsed._tag;
    if (typeof tag !== "string") return undefined;
    const repo = parsed.repository
      ? `${parsed.repository.owner?.login ?? ""}/${parsed.repository.name ?? ""}`
      : undefined;
    const subject = parsed.issue ?? parsed.pullRequest ?? parsed.pull_request;
    const comment = parsed.comment;
    // a COMMENT event's significant text is the comment itself, not
    // the issue it landed on — headline with its first line
    const commentLine =
      typeof comment?.body === "string"
        ? comment.body.trim().split("\n")[0]
        : undefined;
    return {
      event: {
        tag,
        repo,
        number: subject?.number,
        title: commentLine || subject?.title,
        author:
          comment?.user?.login ?? subject?.user?.login ?? parsed.sender?.login,
        body: comment?.body ?? subject?.body ?? undefined,
        url: comment?.html_url ?? subject?.html_url,
      },
      raw: JSON.stringify(parsed, null, 2),
    };
  } catch {
    return undefined;
  }
};

/**
 * Linkify `#123` and `owner/repo#123` references in prose. Bare
 * `#N` resolves against the thread's own repository (derived from
 * the run key). GitHub's /issues/N door redirects to /pull/N, so
 * one URL shape covers both.
 */
const REF_SPLIT = /((?:[\w.-]+\/[\w.-]+)?#\d+\b)/g;
const LinkifiedText = ({ text, repo }: { text: string; repo?: string }) => (
  <>
    {text.split(REF_SPLIT).map((chunk, index) => {
      const match = chunk.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
      const targetRepo = match?.[1] ?? repo;
      if (!match || !targetRepo) return chunk;
      return (
        <RefHoverCard key={index} repo={targetRepo} number={Number(match[2])}>
          <a
            href={`https://github.com/${targetRepo}/issues/${match[2]}`}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
          >
            {chunk}
          </a>
        </RefHoverCard>
      );
    })}
  </>
);

/**
 * Rewrite bare `#N` / `owner/repo#N` references into markdown links
 * (resolved against the thread's repo), leaving code spans and fences
 * untouched so literal `#123`s in code stay literal.
 */
const CODE_SPLIT = /(```[\s\S]*?```|`[^`]*`)/g;
const linkifyMarkdownRefs = (text: string, repo?: string): string =>
  text
    .split(CODE_SPLIT)
    .map((chunk, index) => {
      if (index % 2 === 1) return chunk; // code — leave alone
      return chunk.replace(
        /(?<![\w/[])((?:[\w.-]+\/[\w.-]+)?#\d+)\b/g,
        (whole) => {
          const match = whole.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
          const target = match?.[1] ?? repo;
          if (!match || !target) return whole;
          return `[${whole}](https://github.com/${target}/issues/${match[2]})`;
        },
      );
    })
    .join("");

/** Prose rendered as MARKDOWN (Streamdown) — GitHub refs become
 *  hover-card links via the anchor override. */
const MarkdownText = ({ text, repo }: { text: string; repo?: string }) => (
  <MessageResponse
    components={{
      a: ({ href, children, node: _node, ...rest }: any) => {
        const ref = String(href ?? "").match(
          /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)$/,
        );
        const anchor = (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
            {...rest}
          >
            {children}
          </a>
        );
        return ref ? (
          <RefHoverCard repo={ref[1]!} number={Number(ref[2])}>
            {anchor}
          </RefHoverCard>
        ) : (
          anchor
        );
      },
    }}
  >
    {linkifyMarkdownRefs(text, repo)}
  </MessageResponse>
);

/**
 * One text part, upgraded: tagged world events render as timeline
 * rows, `<note>` inputs render as a muted aside — never a JSON dump —
 * and everything else is markdown with linkified GitHub references.
 */
const TextPart = ({
  text,
  repo,
  kind,
}: {
  text: string;
  repo?: string;
  /** Structural provenance from the observation (message metadata). */
  kind?: "note" | "reminder";
}) => {
  // A Thread.remind delivery — the run's own past self speaking.
  // `kind` is the structural signal; the prefix match only covers
  // rows persisted before provenance existed.
  const reminder =
    kind === "reminder" || text.trim().startsWith("[reminder]")
      ? text.trim().replace(/^\[reminder\]\s?/, "")
      : undefined;
  if (reminder !== undefined) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <AlarmClock className="mt-0.5 size-3.5 shrink-0 text-honey" />
        <div className="min-w-0 whitespace-pre-wrap">
          <span className="mr-1.5 font-medium text-honey">reminder</span>
          <LinkifiedText text={reminder} repo={repo} />
        </div>
      </div>
    );
  }
  const note =
    kind === "note" || text.trim().startsWith("<note>")
      ? (text.trim().match(/^<note>\n?([\s\S]*?)\n?<\/note>$/)?.[1] ??
        text.trim())
      : undefined;
  if (note !== undefined) {
    return (
      <div className="whitespace-pre-wrap rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
        <LinkifiedText text={note} repo={repo} />
      </div>
    );
  }
  const world = parseWorldEvent(text);
  if (world === undefined) {
    return <MarkdownText text={text} repo={repo} />;
  }
  const { event, raw } = world;
  return <EventCard event={event} raw={raw} />;
};

/**
 * A world event as a TIMELINE ROW (GitHub-issue-timeline style): a
 * family-colored icon, a humanized verb, the subject, and the ref —
 * full-width and left-anchored, clearly the world's log rather than
 * anyone's speech bubble. Click to expand author/body/raw; the raw
 * JSON lives in a FIXED-height scroll region so toggling it never
 * reflows the layout.
 */
const EventCard = ({ event, raw }: { event: WorldEvent; raw: string }) => {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const anchored = useAnchoredToggle();
  const family = EVENT_FAMILY.find(([test]) => test.test(event.tag))?.[1] ?? {
    icon: Zap,
    className: "text-muted-foreground",
  };
  const FamilyIcon = family.icon;
  return (
    <div className="w-full text-[13px]">
      <button
        type="button"
        onClick={(click) => anchored(click.currentTarget, () => setOpen(!open))}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent/40"
      >
        <FamilyIcon className={cn("size-3.5 shrink-0", family.className)} />
        <span className="shrink-0 text-muted-foreground">
          {event.author ?? "world"} {eventVerb(event.tag)}
        </span>
        {event.title && (
          <span className="min-w-0 flex-1 truncate">{event.title}</span>
        )}
        {event.repo && event.number !== undefined && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            #{event.number}
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="ml-[7px] border-l border-border/60 py-1 pl-4">
          <div className="flex flex-wrap items-center gap-x-3 font-mono text-xs text-muted-foreground">
            {event.repo &&
              (event.url ? (
                <a
                  href={event.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-border underline-offset-2 hover:text-foreground"
                >
                  {event.repo}
                  {event.number !== undefined ? `#${event.number}` : ""}
                </a>
              ) : (
                <span>
                  {event.repo}
                  {event.number !== undefined ? `#${event.number}` : ""}
                </span>
              ))}
            <button
              type="button"
              onClick={(click) =>
                anchored(click.currentTarget, () => setShowRaw(!showRaw))
              }
              className="ml-auto cursor-pointer font-mono text-[10px] hover:text-foreground"
            >
              {showRaw ? "▾ raw" : "▸ raw"}
            </button>
          </div>
          {event.body && !showRaw && (
            <div className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
              {event.body}
            </div>
          )}
          {showRaw && (
            <pre className="mt-1.5 h-56 overflow-auto rounded bg-background/60 p-2 text-[10px]">
              {raw}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

/** A thought trace — lives INSIDE the Conversation tree, where the
 *  stick-to-bottom context (and thus anchored toggling) is available. */
const ReasoningTrace = ({
  text,
  streaming,
  open,
  onToggle,
}: {
  text: string;
  streaming: boolean;
  open: boolean;
  onToggle: () => void;
}) => {
  const anchored = useAnchoredToggle();
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={(event) => anchored(event.currentTarget, onToggle)}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left font-medium"
      >
        <span className="font-mono">{open ? "▾" : "▸"}</span>
        {streaming ? (
          <span className="animate-pulse">Thinking…</span>
        ) : (
          "Thought process"
        )}
      </button>
      {open && <div className="mt-2 whitespace-pre-wrap">{text}</div>}
    </div>
  );
};

const Chat = ({
  id,
  initial,
  hydrated,
  active,
  agents,
  breadcrumb,
  onOpenThread,
}: {
  id: string;
  initial: UIMessage[];
  /** false = no snapshot endpoint (Cloudflare) — replay over the socket. */
  hydrated: boolean;
  active: boolean;
} & ChatContext) => {
  // Persistent run socket — subscribe on mount, re-subscribe after
  // each burst so a parked IssueOwner keeps streaming. `history:
  // "live"` when the transcript hydrated from `initial` (the
  // /messages snapshot — a full replay would render every message
  // twice); `"replay"` when no snapshot exists and the socket owns
  // the history. SAME-ORIGIN like every other request: `/attach/*`
  // rides the service binding to the backend, in dev included (the
  // vite chain relays WebSocket upgrades — cloudflare-runtime's
  // `websockets.ts`).
  const agent = useAgent({
    chatId: id,
    history: hydrated ? "live" : "replay",
  });
  const { messages, sendMessage, status, stop } = useChat({
    agent,
    messages: initial,
    resume: active,
    persist: active,
  });

  // Pause the socket when the thread is hidden (visited tabs stay
  // mounted). Stopping drops the transport stream; re-selecting with
  // resume/persist opens it again.
  useEffect(() => {
    if (!active) stop();
  }, [active, stop]);

  // "IssueOwner:owner/repo#N" → "owner/repo" — the context bare `#N`
  // references in prose resolve against
  const threadRepo = id.slice(id.indexOf(":") + 1).split("#")[0] || undefined;

  // delegation tool-call → worker thread. Door calls (`AI.Dispatch`)
  // carry their identity on the part (`part.dispatch.child` is the
  // worker's run key) — a DIRECT link. The generic `dispatch`
  // intrinsic without a session falls back to the serial heuristic:
  // the Nth dispatch of agent X is the Nth child run of term X.
  const workerByCall = useMemo(() => {
    const counts = new Map<string, number>();
    const byCall = new Map<string, BoardThread>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "dynamic-tool") continue;
        const dispatch = (part as any).dispatch as
          | { agent: string; child: string | undefined }
          | undefined;
        if (dispatch !== undefined) {
          const worker =
            dispatch.child !== undefined
              ? agents.find(
                  (thread) =>
                    thread.id === `${dispatch.agent}:${dispatch.child}`,
                )
              : undefined;
          if (worker !== undefined) {
            byCall.set(part.toolCallId, worker);
            continue;
          }
        }
        const agent =
          dispatch?.agent ??
          (part.toolName === "dispatch" &&
          typeof (part.input as any)?.agent === "string"
            ? ((part.input as any).agent as string)
            : undefined);
        if (agent === undefined) continue;
        const index = counts.get(agent) ?? 0;
        counts.set(agent, index + 1);
        const worker = agents.filter((thread) => thread.term === agent)[index];
        if (worker !== undefined) byCall.set(part.toolCallId, worker);
      }
    }
    return byCall;
  }, [messages, agents]);

  // reasoning expansion is USER-owned: collapsed by default, and a
  // trace the user opened stays open. Keyed by the trace's text
  // prefix — stable while it streams AND across the handoff from the
  // live bubble to the canonical message (the text only appends).
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(
    () => new Set(),
  );
  const traceKey = (text: string) => text.slice(0, 48);
  const toggleTrace = (key: string) =>
    setExpandedTraces((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Steer the agent DIRECTLY over the run socket — the message lands
  // in the run's inbox as an ordinary input, never as a GitHub comment.
  const onSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text) return;
    void sendMessage({ text });
  };

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
        {breadcrumb && (
          <button
            type="button"
            onClick={() => onOpenThread(breadcrumb.to)}
            className="shrink-0 rounded border border-border px-2 py-0.5 hover:bg-accent"
          >
            ← {breadcrumb.label}
          </button>
        )}
        <span className="truncate">{id}</span>
      </div>
      {/* initial="instant": open AT the end, no scroll animation */}
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="mx-auto max-w-3xl">
          {messages.map((message, messageIndex) => {
            // world events and notes carry their own card chrome — the
            // user-bubble around them reads as an ugly double border
            const meta = message.metadata as
              | { kind?: "note" | "reminder"; at?: number }
              | undefined;
            const kind = meta?.kind;
            // DAY DIVIDER: a rule wherever the calendar day advances
            // past the previous message's
            const previousAt = (
              messages[messageIndex - 1]?.metadata as
                | { at?: number }
                | undefined
            )?.at;
            const day = dayOf(meta?.at);
            const newDay =
              day !== undefined &&
              (messageIndex === 0 || day !== dayOf(previousAt));
            const bare =
              message.role === "user" &&
              (kind !== undefined ||
                message.parts.every(
                  (part) =>
                    part.type === "text" &&
                    (parseWorldEvent(part.text) !== undefined ||
                      // legacy rows from before structural provenance
                      part.text.trim().startsWith("<note>") ||
                      part.text.trim().startsWith("[reminder]")),
                ));
            return (
              <div key={message.id} className="contents">
                {newDay && meta?.at !== undefined && (
                  <div className="flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-border" />
                    <AtTooltip at={meta.at}>
                      <span className="shrink-0 cursor-default font-mono text-[11px] text-muted-foreground hover:text-foreground">
                        {formatDay(meta.at)}
                      </span>
                    </AtTooltip>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                <div className="flex items-start gap-2">
                  {/* wall-clock gutter — the observation's `at` */}
                  <div className="w-12 shrink-0 select-none pt-1 text-right font-mono text-[10px] leading-4 text-muted-foreground/60">
                    {meta?.at !== undefined ? (
                      <AtTooltip at={meta.at}>
                        <span className="cursor-default hover:text-foreground">
                          {formatAt(meta.at)}
                        </span>
                      </AtTooltip>
                    ) : null}
                  </div>
                  <Message
                    from={message.role}
                    className={cn("min-w-0 flex-1", bare && "max-w-full")}
                  >
                    {/* world events are TIMELINE ROWS — full-width and
                  left-anchored like the rest of the log, never a
                  speech bubble */}
                    <MessageContent
                      className={cn(
                        // cards must never flex-SHRINK vertically — a
                        // height-squeezed `overflow-hidden` card collapses
                        // into an empty border pill
                        "*:shrink-0",
                        bare &&
                          "w-full max-w-full group-[.is-user]:bg-transparent group-[.is-user]:px-0 group-[.is-user]:py-0",
                      )}
                    >
                      {message.parts.map((part, index) => {
                        if (part.type === "reasoning") {
                          const key = traceKey(part.text);
                          return (
                            <ReasoningTrace
                              key={index}
                              text={part.text}
                              streaming={part.state === "streaming"}
                              open={expandedTraces.has(key)}
                              onToggle={() => toggleTrace(key)}
                            />
                          );
                        }
                        if (part.type === "text") {
                          return (
                            <TextPart
                              key={index}
                              text={part.text}
                              repo={threadRepo}
                              kind={kind}
                            />
                          );
                        }
                        if (part.type === "dynamic-tool") {
                          const tool = part;
                          // orphan part (an output whose call this client
                          // never saw) — nothing renderable, skip it
                          if (!tool.toolName) return null;
                          const dispatchInfo = (tool as any).dispatch as
                            | { agent: string; child: string | undefined }
                            | undefined;
                          if (
                            dispatchInfo !== undefined ||
                            tool.toolName === "dispatch"
                          ) {
                            const worker = workerByCall.get(tool.toolCallId);
                            const agent =
                              dispatchInfo?.agent ??
                              (tool.input as any)?.agent ??
                              "subagent";
                            const running =
                              worker?.status === "running" ||
                              (worker === undefined &&
                                tool.state === "input-available");
                            return (
                              <button
                                key={index}
                                type="button"
                                disabled={worker === undefined}
                                onClick={() =>
                                  worker && onOpenThread(worker.id)
                                }
                                className={cn(
                                  "flex w-full items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-left",
                                  worker !== undefined && "hover:bg-accent",
                                )}
                              >
                                <span
                                  className={cn(
                                    "size-2.5 shrink-0 rounded-full",
                                    running
                                      ? "animate-pulse bg-moss"
                                      : worker?.status === "crashed"
                                        ? "bg-brick"
                                        : "bg-muted-foreground/50",
                                  )}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium">
                                    {agent}
                                    {running ? " — working…" : ""}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {String((tool.input as any)?.task ?? "")}
                                  </span>
                                </span>
                                {worker !== undefined && (
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    {worker.ticks} ticks · view thread →
                                  </span>
                                )}
                              </button>
                            );
                          }
                          const card = (
                            <ToolCard
                              key={index}
                              toolName={tool.toolName}
                              state={tool.state}
                              input={tool.input}
                              output={tool.output}
                              errorText={tool.errorText}
                            />
                          );
                          // registry-rendered tools get the compact card;
                          // unknown tools keep the generic collapsible
                          if (hasToolCard(tool.toolName)) return card;
                          return (
                            <Tool key={index}>
                              <ToolHeader
                                type={tool.type}
                                state={tool.state}
                                toolName={tool.toolName}
                              />
                              <ToolContent>
                                <ToolInput input={tool.input} />
                                <ToolOutput
                                  output={
                                    typeof tool.output === "string" ? (
                                      <pre className="whitespace-pre-wrap p-3 text-xs">
                                        {tool.output}
                                      </pre>
                                    ) : tool.output !== undefined ? (
                                      <pre className="whitespace-pre-wrap p-3 text-xs">
                                        {JSON.stringify(tool.output, null, 2)}
                                      </pre>
                                    ) : undefined
                                  }
                                  errorText={tool.errorText}
                                />
                              </ToolContent>
                            </Tool>
                          );
                        }
                        return null;
                      })}
                    </MessageContent>
                  </Message>
                </div>
              </div>
            );
          })}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4">
        <PromptInput onSubmit={onSubmit}>
          <PromptInputBody>
            {/* pr-12 keeps typed text clear of the submit button */}
            <PromptInputTextarea
              placeholder="Talk to the reviewer…"
              className="pr-12"
            />
          </PromptInputBody>
          <PromptInputSubmit
            status={status === "streaming" ? "streaming" : undefined}
            variant="ghost"
            className="absolute right-2 bottom-2 text-muted-foreground"
          />
        </PromptInput>
      </div>
    </>
  );
};

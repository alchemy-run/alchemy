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
import { ProposalCard, type Proposal } from "@/components/proposals";
import {
  PullRequestOverview,
  type MachineState,
} from "@/components/pull-request";
import { RefHoverCard } from "@/components/ref-hover-card";
import { GhosttyTerminal } from "@/components/terminal";
import { hasToolCard, ToolCard } from "@/components/tool-card";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Ansi } from "@/lib/ansi";
import type { UIMessage } from "ai";
import { useAgent, useChat } from "alchemy/AI/React";
import {
  AlarmClock,
  CircleDot,
  GitMerge,
  GitPullRequestArrow,
  MessageSquare,
  MessageSquareText,
  Pencil,
  Play,
  RefreshCw,
  Square,
  SquareTerminal,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

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

/** A connected repository — STATIC code (src/github/Repos.ts), reflected
 *  read-only by /api/repos. Never runtime-editable. */
interface RepoInfo {
  name: string;
  sessions: boolean;
  reviews: boolean;
}

/**
 * KEY CONVENTIONS. A SESSION owns one sandbox MicroVM and has 1..*
 * THREADS. Thread keys are `<session>` (the base thread) or
 * `<session>::<thread>`; the server derives the machine from the
 * session part, so every thread and the terminal share the machine.
 *
 * Two kinds of session key:
 * - a CODING session: `<owner>/<repo>/<name>` (legacy keys without a
 *   connected-repo prefix group as unscoped) — the Code activity;
 * - a PULL REQUEST session: `<owner>/<repo>#<n>` — the Review
 *   activity. Its machine's tree is the PR's head, and the Reviewer's
 *   session (`Reviewer:<owner>/<repo>#<n>`), the operator's engineer
 *   threads (`Engineer:<owner>/<repo>#<n>[::<thread>]`), and the
 *   terminals all share it.
 *
 * VIEW IDS are chat ids (`Engineer:…`, `Reviewer:…`) plus one
 * synthetic kind, `pr:<owner>/<repo>#<n>` — the PR's overview page.
 */
const splitThreadKey = (
  key: string,
): { session: string; thread: string | undefined } => {
  const at = key.indexOf("::");
  return at < 0
    ? { session: key, thread: undefined }
    : { session: key.slice(0, at), thread: key.slice(at + 2) };
};

/** A pull-request session key (`owner/repo#N`)? */
const isPullSession = (session: string): boolean => /#\d+$/.test(session);

/** `owner/repo#N` → N. */
const pullNumberOf = (session: string): number =>
  Number(session.match(/#(\d+)$/)?.[1]);

/** The overview view id of a PR session. */
const overviewId = (session: string): string => `pr:${session}`;

const sessionOfId = (id: string | undefined): string | undefined => {
  if (id === undefined) return undefined;
  if (id.startsWith("Engineer:")) {
    return splitThreadKey(id.slice("Engineer:".length)).session;
  }
  if (id.startsWith("Reviewer:")) {
    return splitThreadKey(id.slice("Reviewer:".length)).session;
  }
  if (id.startsWith("pr:")) return id.slice("pr:".length);
  return undefined;
};

/** A view id that belongs to the REVIEW activity (a PR session). */
const isReviewId = (id: string | undefined): boolean => {
  const session = sessionOfId(id);
  return session !== undefined && isPullSession(session);
};

/** The hash names a view, or nothing — there is NO default session:
 *  merely mounting a chat view attaches a socket, which ADMITS the
 *  session server-side, so a default here would resurrect itself on
 *  every load (and after every delete). */
const threadFromHash = (): string | undefined => {
  const raw = decodeURIComponent(window.location.hash.slice(1));
  return raw.startsWith("Engineer:") ||
    raw.startsWith("Reviewer:") ||
    raw.startsWith("pr:")
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
  /** Set for a PULL REQUEST session (`owner/repo#N`) — Review's. */
  pull: number | undefined;
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
      const repo = repos.find(
        (entry) =>
          session.startsWith(`${entry.name}/`) ||
          session.startsWith(`${entry.name}#`),
      )?.name;
      const pull = isPullSession(session) ? pullNumberOf(session) : undefined;
      return {
        session,
        repo,
        pull,
        label:
          pull !== undefined
            ? `#${pull}`
            : repo === undefined
              ? session
              : session.slice(repo.length + 1),
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

/** `useState` mirrored to localStorage — the UI's own memory (layout,
 *  display names). Corrupt or missing storage yields the initial. */
const usePersistedState = <T,>(
  storageKey: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] => {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // storage full / disabled — the session still works, unremembered
    }
  }, [storageKey, value]);
  return [value, setValue];
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
    isReviewId(threadFromHash()) ? "review" : "code",
  );
  const [codeId, setCodeId] = useState<string | undefined>(() => {
    const id = threadFromHash();
    return id?.startsWith("Engineer:") && !isReviewId(id) ? id : undefined;
  });
  /** The selected PULL REQUEST session (`owner/repo#N`) in Review. */
  const [reviewSession, setReviewSession] = useState<string | undefined>(() => {
    const id = threadFromHash();
    return isReviewId(id) ? sessionOfId(id) : undefined;
  });
  /** Per PR session, the selected non-terminal tab: `"overview"` or a
   *  thread id (the bot's review or an engineer thread). PERSISTED like
   *  the terminal selection — returning to a PR resumes its tab. */
  const [reviewTab, setReviewTab] = usePersistedState<Record<string, string>>(
    "alchemy-org:layout:review-tab",
    {},
  );
  /** Each PR machine's state as the checkout door last reported it —
   *  this page load's memory only (the machine itself is the server's). */
  const [machines, setMachines] = useState<Record<string, MachineState>>({});
  /** The review pipeline answered 503 — the deploy has no bot. */
  const [reviewUnavailable, setReviewUnavailable] = useState(false);
  // ── the per-session LAYOUT — this browser's view of each session,
  // PERSISTED: which terminal tabs are open (each is one shell on the
  // session's machine), which tab is selected (`undefined` = thread
  // view), and the last thread looked at (a session-row click resumes
  // there). Sessions and threads themselves are the SERVER's — the
  // directory (`/api/chats`) is the only source of truth for what
  // exists; this store only remembers how you had each one laid out.
  const [terminals, setTerminals] = usePersistedState<Record<string, string[]>>(
    "alchemy-org:layout:terminals",
    {},
  );
  const [terminalSel, setTerminalSel] = usePersistedState<
    Record<string, string | undefined>
  >("alchemy-org:layout:terminal-selected", {});
  const [lastThread, setLastThread] = usePersistedState<Record<string, string>>(
    "alchemy-org:layout:last-thread",
    {},
  );
  /** Per terminal tab (`session\u001f${ptyId}`): kills the guest shell —
   *  registered by each mounted GhosttyTerminal, called by the tab's ×. */
  const terminalKillers = useRef(new Map<string, () => void>());

  /** Route to a thread id — updates the hash, the activity, and the
   *  per-activity memory. Deliberately does NOT touch the session's
   *  terminal-tab selection: hidden views stay mounted and selections
   *  stay remembered, so returning to a session resumes its last
   *  state (explicit thread clicks deselect via {@link openThread}).
   *  `undefined` clears the selection (empty state). */
  const apply = (id: string | undefined) => {
    setActiveId(id);
    if (id === undefined) {
      setCodeId(undefined);
      return;
    }
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
    const session = sessionOfId(id);
    if (session !== undefined && isPullSession(session)) {
      // a PULL REQUEST view: its overview, the bot's review, or one of
      // the operator's threads on it — the Review activity
      setReviewSession(session);
      const tab = id.startsWith("pr:") ? "overview" : id;
      setReviewTab((current) =>
        current[session] === tab ? current : { ...current, [session]: tab },
      );
      setActivity("review");
      return;
    }
    if (id.startsWith("Engineer:")) {
      setCodeId(id);
      setActivity("code");
      if (session !== undefined) {
        setLastThread((current) =>
          current[session] === id ? current : { ...current, [session]: id },
        );
      }
    }
  };

  const open = (id: string) => {
    window.location.hash = encodeURIComponent(id);
    apply(id);
  };

  // a hash that names a PR view on load must also land its tab — the
  // persisted tab memory would otherwise win over the URL
  useEffect(() => {
    const id = threadFromHash();
    if (id !== undefined && isReviewId(id)) apply(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Open a THREAD's chat view — the explicit act that deselects the
   *  session's terminal tab. */
  const openThread = (id: string) => {
    const session = sessionOfId(id);
    if (session !== undefined) {
      setTerminalSel((current) =>
        current[session] !== undefined
          ? { ...current, [session]: undefined }
          : current,
      );
    }
    open(id);
  };

  /** Open a PR's OVERVIEW page (its description and conversation). */
  const openOverview = (session: string) => openThread(overviewId(session));

  /**
   * The PR machine's "resume and pull": converge the tree every thread
   * and terminal on this PR shares onto the PR head as it is now. The
   * server launches or wakes the machine as a side effect, so calling
   * this BEFORE the first thread/terminal means the machine lands on
   * the PR branch before anyone types. Idempotent; a running call is
   * not doubled.
   */
  const checkoutPull = (session: string) => {
    if (machines[session]?.phase === "checking-out") return;
    setMachines((current) => ({
      ...current,
      [session]: { phase: "checking-out" },
    }));
    void fetch(`/api/prs/${pullNumberOf(session)}/checkout`, {
      method: "POST",
    })
      .then(async (response) => {
        const data = (await response.json()) as
          | { branch: string; headSha?: string }
          | { error: string };
        setMachines((current) => ({
          ...current,
          [session]:
            "error" in data
              ? { phase: "error", message: data.error }
              : {
                  phase: "ready",
                  branch: data.branch,
                  headSha: data.headSha,
                },
        }));
      })
      .catch((cause: unknown) =>
        setMachines((current) => ({
          ...current,
          [session]: { phase: "error", message: String(cause) },
        })),
      );
  };

  /** A PR machine that this page has not converged yet gets pulled on
   *  the first thread/terminal opened on it. */
  const ensurePullMachine = (session: string) => {
    const phase = machines[session]?.phase;
    if (phase === undefined || phase === "error") checkoutPull(session);
  };

  /** A session-row click RESUMES the session where the operator left
   *  it: the remembered thread (else the freshest), and the remembered
   *  thread-vs-terminal tab — every hidden view stayed mounted, so
   *  this is a pure visibility flip, no re-render from scratch. */
  const openSession = (group: SessionGroup) => {
    const remembered = lastThread[group.session];
    const target =
      remembered !== undefined &&
      group.threads.some((thread) => thread.id === remembered)
        ? remembered
        : [...group.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0]!.id;
    open(target);
  };

  /** Clear the code selection (after deleting the current session). */
  const closeCode = () => {
    window.location.hash = "";
    apply(undefined);
  };

  /** A PR with no review session: REQUEST its review — the server
   *  synthesizes the opened event and the bot's session appears. A 503
   *  means this deploy runs no review pipeline. */
  const requestReview = (number: number) => {
    setRequested((current) => new Set(current).add(number));
    const forget = () =>
      setRequested((current) => {
        const next = new Set(current);
        next.delete(number);
        return next;
      });
    void fetch(`/api/prs/${number}/review`, { method: "POST" })
      .then((response) => {
        if (response.ok) return;
        if (response.status === 503) setReviewUnavailable(true);
        forget();
      })
      .catch(forget);
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

  // the DIRECTORY: poll — a thread lists from the moment its key is
  // opened (`POST /api/chats/:id`), before any input. A failed poll
  // changes nothing: an empty list is a fact only when the server
  // says so, never a stand-in for an error.
  const reloadThreads = useRef<() => Promise<void>>(() => Promise.resolve());
  /** True once the directory has answered at least once — before
   *  that, an empty list means "not loaded", not "no sessions". */
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/chats")
        .then((response) =>
          response.ok ? (response.json() as Promise<BoardThread[]>) : undefined,
        )
        .then((board) => {
          if (live && board !== undefined) {
            setThreads(board.filter((t) => t.term === "Engineer"));
            setDirectoryLoaded(true);
          }
        })
        .catch(() => {});
    reloadThreads.current = load;
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

  // PROPOSALS: what the agents want to do on GitHub, awaiting the
  // operator (src/github/Proposals.ts) — polled as one recent list;
  // the pending ones are the inbox overlay, a pull request's own show
  // on its page in every state
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalBusy, setProposalBusy] = useState<ReadonlySet<string>>(
    new Set(),
  );
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/proposals")
        .then(
          (response) =>
            (response.ok ? response.json() : []) as Promise<Proposal[]>,
        )
        .then((list) => {
          if (live) setProposals(list);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  /** The operator's three verbs on a proposal: accept (the GitHub
   *  write), reject (optional reason to the agent), and revise — "ask
   *  for changes": the proposal stays pending, the message wakes the
   *  agent, and it updates the card in place. */
  const settleProposal = (
    id: string,
    verb: "accept" | "reject" | "revise",
    text?: string,
  ) => {
    setProposalBusy((current) => new Set(current).add(id));
    void fetch(`/api/proposals/${encodeURIComponent(id)}/${verb}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        text === undefined
          ? {}
          : verb === "revise"
            ? { message: text }
            : { reason: text },
      ),
    })
      .then(async (response) => {
        const resolved = (await response.json().catch(() => undefined)) as
          | Proposal
          | { error: string }
          | undefined;
        if (resolved !== undefined && "id" in resolved) {
          setProposals((current) =>
            current.map((entry) => (entry.id === id ? resolved : entry)),
          );
        }
      })
      .catch(() => {})
      .finally(() =>
        setProposalBusy((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        }),
      );
  };

  const randomSuffix = () =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  /** The new-session prompt (dialog subject): the target repo and the
   *  editable name, pre-filled with a generated one. */
  const [newSessionPrompt, setNewSessionPrompt] = useState<
    { repo: string | undefined; name: string } | undefined
  >(undefined);

  /** Display-name overrides — RENAME is a UI act; session/thread/pty
   *  keys are identity and never change. Persisted locally, keyed
   *  `session:<key>` / `thread:<id>` / `terminal:<session>\u001f<pty>`. */
  const [names, setNames] = usePersistedState<Record<string, string>>(
    "alchemy-org:display-names",
    {},
  );
  const displayName = (key: string, fallback: string) => names[key] ?? fallback;

  const [renamePrompt, setRenamePrompt] = useState<
    | {
        what: "session" | "thread" | "terminal";
        nameKey: string;
        /** The default label — shown when the override is cleared. */
        fallback: string;
        value: string;
      }
    | undefined
  >(undefined);

  const startRename = (
    what: "session" | "thread" | "terminal",
    nameKey: string,
    fallback: string,
  ) =>
    setRenamePrompt({
      what,
      nameKey,
      fallback,
      value: names[nameKey] ?? fallback,
    });

  const commitRename = () => {
    if (renamePrompt === undefined) return;
    const value = renamePrompt.value.trim();
    setNames((current) => {
      const next = { ...current };
      // emptied or reverted to the default → drop the override
      if (value.length === 0 || value === renamePrompt.fallback) {
        delete next[renamePrompt.nameKey];
      } else {
        next[renamePrompt.nameKey] = value;
      }
      return next;
    });
    setRenamePrompt(undefined);
  };

  /** A new SESSION under a connected repo — one sandbox MicroVM. The
   *  dialog opens with a generated name selected: type to replace it,
   *  or just press Enter to take it. */
  const newSession = (repo: string | undefined) =>
    setNewSessionPrompt({ repo, name: `s-${randomSuffix()}` });

  /** CREATE a thread key on the server, then show it. The row lists
   *  for every client from here on — a session is a server fact, not
   *  a tab: it survives clicking away, reloads, and its first message
   *  never being sent. The view opens immediately (the directory
   *  bridges the gap with a synthesized row until the poll catches up). */
  const createThread = (id: string, show: (id: string) => void) => {
    show(id);
    void fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "POST" })
      .then(() => reloadThreads.current())
      .catch(() => {});
  };

  const commitNewSession = () => {
    if (newSessionPrompt === undefined) return;
    const name = newSessionPrompt.name.trim().replace(/\s+/g, "-");
    if (name.length === 0) return;
    const { repo } = newSessionPrompt;
    setNewSessionPrompt(undefined);
    createThread(
      `Engineer:${repo === undefined ? name : `${repo}/${name}`}`,
      open,
    );
  };

  /** A new THREAD in a session — rides the session's machine. A PR
   *  session's FIRST engineer thread is the base key (`Engineer:<pr>`,
   *  the "main" of the PR); later ones append `::t-…` like any session.
   *  Opening it on a PR pulls the PR head onto the machine first. */
  const newThread = (session: string) => {
    if (isPullSession(session)) {
      ensurePullMachine(session);
      const hasBase = threads.some((row) => row.id === `Engineer:${session}`);
      if (!hasBase) return createThread(`Engineer:${session}`, openThread);
    }
    createThread(`Engineer:${session}::t-${randomSuffix()}`, openThread);
  };

  /** Select a terminal tab (creating the session's first — pty id
   *  "main" — when none is open yet). Mounts on create, stays mounted.
   *  A NEW terminal on a PR session pulls the PR head onto the machine
   *  first (re-selecting an existing tab never resets anyone's tree). */
  const openTerminal = (session: string, ptyId?: string) => {
    const target = ptyId ?? terminals[session]?.[0] ?? "main";
    if (
      isPullSession(session) &&
      !(terminals[session] ?? []).includes(target)
    ) {
      ensurePullMachine(session);
    }
    setTerminals((current) => {
      const list = current[session] ?? [];
      return list.includes(target)
        ? current
        : { ...current, [session]: [...list, target] };
    });
    setTerminalSel((current) => ({ ...current, [session]: target }));
  };

  /** A NEW terminal tab: a fresh PTY (its own shell) on the session's
   *  machine. The first terminal is always "main" (it reattaches to
   *  the machine's existing shell); ids never recycle — a killed "2"
   *  stays dead. */
  const newTerminal = (session: string) => {
    const list = terminals[session] ?? [];
    if (list.length === 0) return openTerminal(session);
    const next = `${
      1 +
      list.reduce(
        (max, id) => Math.max(max, id === "main" ? 1 : Number(id) || 1),
        1,
      )
    }`;
    openTerminal(session, next);
  };

  /** Kill terminal tabs: the guest shells die, the tabs drop, and a
   *  killed selection lands on the last surviving terminal (else the
   *  thread view). */
  const killTerminals = (session: string, ptyIds: ReadonlyArray<string>) => {
    if (ptyIds.length === 0) return;
    for (const ptyId of ptyIds) {
      terminalKillers.current.get(`${session}\u001f${ptyId}`)?.();
      terminalKillers.current.delete(`${session}\u001f${ptyId}`);
    }
    const gone = new Set(ptyIds);
    const remaining = (terminals[session] ?? []).filter((id) => !gone.has(id));
    setTerminals((current) => ({ ...current, [session]: remaining }));
    setTerminalSel((current) => {
      const selected = current[session];
      return selected !== undefined && gone.has(selected)
        ? { ...current, [session]: remaining[remaining.length - 1] }
        : current;
    });
  };

  /** The terminal tab's ×. */
  const killTerminal = (session: string, ptyId: string) =>
    killTerminals(session, [ptyId]);

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

  /** The thread tab awaiting kill confirmation (the dialog's subject). */
  const [confirmKillThread, setConfirmKillThread] = useState<
    BoardThread | undefined
  >(undefined);
  /** The dialog's default action — focused on open so Enter confirms. */
  const killThreadConfirmRef = useRef<HTMLButtonElement>(null);

  /** The thread tab's ×, once confirmed: delete the thread (transcript
   *  and directory row) and land on a sibling tab. No thread is
   *  special — the server terminates the shared machine only when the
   *  deleted thread was the session's last. */
  const killThread = (thread: BoardThread) => {
    setConfirmKillThread(undefined);
    const id = thread.id;
    const session = sessionOfId(id);
    setVisited((current) => current.filter((visitedId) => visitedId !== id));
    setThreads((current) => current.filter((row) => row.id !== id));
    setLastThread((current) => {
      if (session === undefined || current[session] !== id) return current;
      const { [session]: _dropped, ...rest } = current;
      return rest;
    });
    if (session !== undefined) {
      const sibling = threads.find(
        (row) => row.id !== id && sessionOfId(row.id) === session,
      );
      if (isPullSession(session)) {
        // a PR's threads come and go; the PR page itself stays
        if (reviewTab[session] === id) {
          if (sibling !== undefined) open(sibling.id);
          else openOverview(session);
        }
      } else if (codeId === id) {
        if (sibling !== undefined) open(sibling.id);
        else closeCode();
      }
    }
    void fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => {});
  };

  /** A BULK tab close awaiting confirmation ("close all", "close all
   *  to the right") — only when threads are included: their transcripts
   *  are destroyed. Terminal-only closes execute immediately. */
  const [confirmCloseTabs, setConfirmCloseTabs] = useState<
    | {
        session: string;
        threads: BoardThread[];
        terminals: string[];
      }
    | undefined
  >(undefined);
  /** The dialog's default action — focused on open so Enter confirms. */
  const closeTabsConfirmRef = useRef<HTMLButtonElement>(null);

  /** Request a bulk tab close: terminal-only closes run immediately;
   *  anything deleting thread transcripts asks first. */
  const requestCloseTabs = (
    session: string,
    threadRows: ReadonlyArray<BoardThread>,
    ptyIds: ReadonlyArray<string>,
  ) => {
    if (threadRows.length === 0) {
      killTerminals(session, ptyIds);
      return;
    }
    setConfirmCloseTabs({
      session,
      threads: [...threadRows],
      terminals: [...ptyIds],
    });
  };

  /** The bulk close, once confirmed: kill the terminals, delete the
   *  threads, and land the selection on a survivor. */
  const closeTabs = (input: {
    session: string;
    threads: BoardThread[];
    terminals: string[];
  }) => {
    setConfirmCloseTabs(undefined);
    killTerminals(input.session, input.terminals);
    const ids = new Set(input.threads.map((row) => row.id));
    if (ids.size === 0) return;
    setVisited((current) => current.filter((id) => !ids.has(id)));
    setThreads((current) => current.filter((row) => !ids.has(row.id)));
    setLastThread((current) => {
      const remembered = current[input.session];
      if (remembered === undefined || !ids.has(remembered)) return current;
      const { [input.session]: _dropped, ...rest } = current;
      return rest;
    });
    const sibling = threads.find(
      (row) => !ids.has(row.id) && sessionOfId(row.id) === input.session,
    );
    if (isPullSession(input.session)) {
      const selected = reviewTab[input.session];
      if (selected !== undefined && ids.has(selected)) {
        if (sibling !== undefined) open(sibling.id);
        else openOverview(input.session);
      }
    } else if (codeId !== undefined && ids.has(codeId)) {
      if (sibling !== undefined) open(sibling.id);
      else closeCode();
    }
    // SEQUENTIAL: the server terminates the shared machine on the
    // delete that empties the session — parallel deletes would race
    // the directory query that decides which one that is
    void (async () => {
      for (const id of ids) {
        await fetch(`/api/chats/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }).catch(() => {});
      }
    })();
  };

  /** The session awaiting delete confirmation (the dialog's subject). */
  const [confirmDelete, setConfirmDelete] = useState<SessionGroup | undefined>(
    undefined,
  );
  /** The dialog's default action — focused on open so Enter confirms. */
  const deleteSessionConfirmRef = useRef<HTMLButtonElement>(null);
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
    for (const ptyId of terminals[group.session] ?? []) {
      terminalKillers.current.delete(`${group.session}\u001f${ptyId}`);
    }
    setTerminals((current) => {
      const { [group.session]: _dropped, ...rest } = current;
      return rest;
    });
    setTerminalSel((current) => {
      const { [group.session]: _dropped, ...rest } = current;
      return rest;
    });
    if (sessionOfId(codeId) === group.session) closeCode();
    // SEQUENTIAL: the delete that empties the session terminates the
    // machine — parallel deletes would race the directory query
    for (const id of ids) {
      await fetch(`/api/chats/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    setThreads((current) => current.filter((thread) => !ids.has(thread.id)));
    setDeleting((current) => {
      const next = new Set(current);
      next.delete(group.session);
      return next;
    });
  };

  /** The PR session's selected thread tab, if a thread is selected. */
  const reviewThreadId =
    reviewSession !== undefined &&
    reviewTab[reviewSession] !== undefined &&
    reviewTab[reviewSession] !== "overview"
      ? reviewTab[reviewSession]
      : undefined;

  // the active/selected engineer thread is listed even before the
  // directory knows it (a just-created thread has no row yet)
  const list = useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    for (const id of [activeId, codeId, reviewThreadId]) {
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
  }, [threads, activeId, codeId, reviewThreadId]);

  /** Sessions (threads grouped by `::`-stripped key), newest first —
   *  coding sessions AND pull-request sessions alike. */
  const groups = useMemo(() => groupSessions(list, repos), [list, repos]);

  const currentSession = sessionOfId(codeId);
  const currentGroup = groups.find((group) => group.session === currentSession);
  const activeTerminal =
    currentSession !== undefined ? terminalSel[currentSession] : undefined;
  const terminalActive = activeTerminal !== undefined;

  /** The selected PR's engineer threads (none yet is a fine state — the
   *  PR page and the bot's review exist without any). */
  const reviewGroup = groups.find((group) => group.session === reviewSession);
  const reviewThreads = reviewGroup?.threads ?? [];
  const reviewPull =
    reviewSession !== undefined
      ? board.prs.find((pull) => pull.number === pullNumberOf(reviewSession))
      : undefined;
  const reviewBotId = reviewPull?.session?.id;
  const reviewTerminal =
    reviewSession !== undefined ? terminalSel[reviewSession] : undefined;

  /** The ONE view on screen, by id: a chat (`Engineer:…`/`Reviewer:…`),
   *  a PR overview (`pr:…`), or a terminal (`pty:<session>\u001f<pty>`).
   *  Every visited view stays mounted; this decides which is visible. */
  const activeView: string | undefined = (() => {
    if (activity === "code") {
      return currentSession !== undefined && activeTerminal !== undefined
        ? `pty:${currentSession}\u001f${activeTerminal}`
        : codeId;
    }
    if (reviewSession === undefined) return undefined;
    if (reviewTerminal !== undefined) {
      return `pty:${reviewSession}\u001f${reviewTerminal}`;
    }
    // a remembered thread tab that no longer exists (deleted from
    // another tab) must not resurrect it by mounting its view
    const tab = reviewTab[reviewSession];
    const known =
      tab !== undefined &&
      tab !== "overview" &&
      (tab === reviewBotId ||
        tab === activeId ||
        reviewThreads.some((row) => row.id === tab));
    return known ? tab : overviewId(reviewSession);
  })();

  // the inbox skips proposals whose pull request page is the one on
  // screen — that page shows them in place, with the same buttons
  const pendingProposals = proposals.filter(
    (proposal) =>
      proposal.status === "pending" &&
      (proposal.number === undefined ||
        activeView !== `pr:${proposal.repo}#${proposal.number}`),
  );

  // The layout store follows the directory: a session deleted here or
  // anywhere else takes its remembered tabs with it. Only once the
  // directory has actually answered — and never the session on
  // screen, whose row may still be in flight from its POST. PR
  // sessions are known for as long as the board lists the PR (their
  // terminals may exist with no thread at all).
  useEffect(() => {
    if (!directoryLoaded) return;
    const known = new Set(groups.map((group) => group.session));
    if (currentSession !== undefined) known.add(currentSession);
    if (reviewSession !== undefined) known.add(reviewSession);
    if (board.repo) {
      for (const pull of board.prs) known.add(`${board.repo}#${pull.number}`);
    }
    const prune = <T,>(store: Record<string, T>): Record<string, T> => {
      const stale = Object.keys(store).filter((key) => !known.has(key));
      if (stale.length === 0) return store;
      const next = { ...store };
      for (const key of stale) delete next[key];
      return next;
    };
    setTerminals(prune);
    setTerminalSel(prune);
    setLastThread(prune);
    setReviewTab(prune);
  }, [directoryLoaded, groups, currentSession, reviewSession, board]);

  /** Sessions whose views have been shown this page load. A RESTORED
   *  terminal tab mounts (and so attaches to — wakes — its machine)
   *  only once its session is opened: a reload must not boot every
   *  machine you ever had a terminal on. */
  const visitedSessions = useMemo(() => {
    const set = new Set<string>();
    for (const id of visited) {
      const session = sessionOfId(id);
      if (session !== undefined) set.add(session);
    }
    if (currentSession !== undefined) set.add(currentSession);
    if (reviewSession !== undefined) set.add(reviewSession);
    return set;
  }, [visited, currentSession, reviewSession]);

  /** Sidebar buckets: one per connected `sessions: true` repo, plus
   *  an unscoped bucket for legacy keys (`main`, `t-…`). Pull-request
   *  sessions are Review's, never listed here. */
  const repoBuckets = useMemo(() => {
    const coding = groups.filter((group) => group.pull === undefined);
    const buckets: Array<{
      repo: string | undefined;
      groups: SessionGroup[];
    }> = repos
      .filter((repo) => repo.sessions)
      .map((repo) => ({
        repo: repo.name,
        groups: coding.filter((group) => group.repo === repo.name),
      }));
    const unscoped = coding.filter((group) => group.repo === undefined);
    if (unscoped.length > 0 || buckets.length === 0) {
      buckets.push({ repo: undefined, groups: unscoped });
    }
    return buckets;
  }, [groups, repos]);

  const openPrCount = board.prs.filter((pull) => pull.state === "open").length;

  /** A PR-row click RESUMES the PR where the operator left it: the
   *  remembered tab (overview, the review, or a thread) — and a
   *  selected terminal stays selected (`open` never deselects one;
   *  only an explicit thread click does). */
  const openPullSession = (session: string) => {
    const remembered = reviewTab[session];
    open(
      remembered !== undefined && remembered !== "overview"
        ? remembered
        : overviewId(session),
    );
  };

  /**
   * THE TAB STRIP — one strip, one menu, for a coding session and a
   * pull-request session alike: leading tabs (a PR's overview and the
   * bot's review — not closable), then the session's engineer threads,
   * then its terminals, so "close all to the right" is positional
   * across kinds and every tab carries the identical actions. `selected`
   * is the view id on screen ({@link activeView}).
   */
  const tabStrip = ({
    session,
    leading,
    threads: rows,
    selected,
    summary,
  }: {
    session: string;
    leading: Array<{
      kind: "lead";
      id: string;
      label: ReactNode;
      status: BoardThread["status"] | undefined;
      onSelect: () => void;
    }>;
    threads: BoardThread[];
    selected: string | undefined;
    summary: ReactNode;
  }) => {
    const ptyIds = terminals[session] ?? [];
    type Tab =
      | (typeof leading)[number]
      | { kind: "thread"; thread: BoardThread }
      | { kind: "terminal"; ptyId: string; nth: number };
    const strip: Tab[] = [
      ...leading,
      ...rows.map((thread) => ({ kind: "thread" as const, thread })),
      ...ptyIds.map((ptyId, nth) => ({
        kind: "terminal" as const,
        ptyId,
        nth,
      })),
    ];
    const rightOf = (index: number) => {
      const rest = strip.slice(index + 1);
      return {
        threads: rest.flatMap((tab) =>
          tab.kind === "thread" ? [tab.thread] : [],
        ),
        terminals: rest.flatMap((tab) =>
          tab.kind === "terminal" ? [tab.ptyId] : [],
        ),
      };
    };
    const tabClass = (isSelected: boolean, mono = false) =>
      cn(
        "group/tab flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs",
        mono && "font-mono",
        isSelected
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      );
    const tabProps = (isSelected: boolean, mono = false) => ({
      role: "tab" as const,
      "aria-selected": isSelected,
      className: tabClass(isSelected, mono),
    });
    return (
      <div
        role="tablist"
        aria-label="Session tabs"
        className="flex items-center gap-0.5 border-b border-border px-2"
      >
        {strip.map((tab, index) => {
          const right = rightOf(index);
          const closableRight =
            right.terminals.length > 0 || right.threads.length > 0;
          const key =
            tab.kind === "lead"
              ? tab.id
              : tab.kind === "thread"
                ? tab.thread.id
                : `>_${tab.ptyId}`;
          return (
            <Fragment key={key}>
              {index > 0 && (
                // subtle divider — deliberately shorter than the tab
                <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
              )}
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  {tab.kind === "lead" ? (
                    <button
                      type="button"
                      onClick={tab.onSelect}
                      {...tabProps(selected === tab.id)}
                    >
                      {tab.status !== undefined && (
                        <span
                          className={cn(
                            "inline-block size-1.5 shrink-0 rounded-full",
                            statusDot[tab.status] ?? statusDot.idle,
                          )}
                        />
                      )}
                      {tab.label}
                    </button>
                  ) : tab.kind === "thread" ? (
                    <button
                      type="button"
                      onClick={() => openThread(tab.thread.id)}
                      {...tabProps(selected === tab.thread.id)}
                    >
                      <span
                        className={cn(
                          "inline-block size-1.5 shrink-0 rounded-full",
                          statusDot[tab.thread.status] ?? statusDot.idle,
                        )}
                      />
                      <span className="max-w-48 truncate">
                        {displayName(
                          `thread:${tab.thread.id}`,
                          tabTitle(tab.thread),
                        )}
                      </span>
                      <span
                        role="button"
                        title="Delete thread"
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmKillThread(tab.thread);
                        }}
                        className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-border hover:text-terracotta group-hover/tab:block"
                      >
                        <X className="size-3" />
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openTerminal(session, tab.ptyId)}
                      {...tabProps(
                        selected === `pty:${session}\u001f${tab.ptyId}`,
                        true,
                      )}
                    >
                      {">_"}{" "}
                      {displayName(
                        `terminal:${session}\u001f${tab.ptyId}`,
                        `${tab.nth + 1}`,
                      )}
                      <span
                        role="button"
                        title="Close terminal (the shell dies)"
                        onClick={(event) => {
                          event.stopPropagation();
                          killTerminal(session, tab.ptyId);
                        }}
                        className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-border hover:text-terracotta group-hover/tab:block"
                      >
                        <X className="size-3" />
                      </span>
                    </button>
                  )}
                </ContextMenuTrigger>
                <ContextMenuContent
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <ContextMenuItem onSelect={() => newThread(session)}>
                    <MessageSquare /> New thread
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => newTerminal(session)}>
                    <SquareTerminal /> New terminal
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={!closableRight}
                    onSelect={() =>
                      requestCloseTabs(session, right.threads, right.terminals)
                    }
                  >
                    Close all to the right
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={rows.length === 0 && ptyIds.length === 0}
                    onSelect={() => requestCloseTabs(session, rows, ptyIds)}
                  >
                    Close all
                  </ContextMenuItem>
                  {tab.kind !== "lead" && (
                    <>
                      <ContextMenuSeparator />
                      {tab.kind === "thread" ? (
                        <ContextMenuItem
                          onSelect={() =>
                            startRename(
                              "thread",
                              `thread:${tab.thread.id}`,
                              tabTitle(tab.thread),
                            )
                          }
                        >
                          <Pencil /> Rename thread…
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem
                          onSelect={() =>
                            startRename(
                              "terminal",
                              `terminal:${session}\u001f${tab.ptyId}`,
                              `${tab.nth + 1}`,
                            )
                          }
                        >
                          <Pencil /> Rename terminal…
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      {tab.kind === "thread" ? (
                        <ContextMenuItem
                          variant="destructive"
                          onSelect={() => setConfirmKillThread(tab.thread)}
                        >
                          <Trash2 /> Delete thread
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem
                          variant="destructive"
                          onSelect={() => killTerminal(session, tab.ptyId)}
                        >
                          <X /> Close terminal
                        </ContextMenuItem>
                      )}
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            </Fragment>
          );
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="New thread or terminal"
              className="px-2 py-2 font-mono text-sm text-muted-foreground hover:text-foreground"
            >
              +
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            // let the freshly opened thread/terminal keep focus
            // instead of returning it to the + trigger
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuItem onSelect={() => newThread(session)}>
              <MessageSquare /> New thread
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => newTerminal(session)}>
              <SquareTerminal /> New terminal
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto pr-2 font-mono text-[10px] text-muted-foreground">
          {summary}
        </span>
      </div>
    );
  };

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
                    <span className="font-mono">{newSessionPrompt.repo}</span> —
                    threads and terminal share it.
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
      {/* RENAME — a display-name override only; the underlying
          session/thread/pty key is identity and never changes.
          Clearing the field restores the default label. */}
      <Dialog
        open={renamePrompt !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRenamePrompt(undefined);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              commitRename();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename {renamePrompt?.what}</DialogTitle>
              <DialogDescription>
                Display name only — clear it to restore{" "}
                <span className="font-mono">{renamePrompt?.fallback}</span>.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={renamePrompt?.value ?? ""}
              onChange={(event) =>
                setRenamePrompt((current) =>
                  current === undefined
                    ? current
                    : { ...current, value: event.target.value },
                )
              }
              onFocus={(event) => event.currentTarget.select()}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-sm"
              aria-label="Display name"
            />
            <DialogFooter showCloseButton={false}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRenamePrompt(undefined)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* KILL-THREAD CONFIRMATION — deleting a thread purges its
          transcript. The shared machine survives unless this is the
          session's last thread — then the machine dies with it. */}
      <Dialog
        open={confirmKillThread !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmKillThread(undefined);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-sm"
          // confirm is the DEFAULT: Enter deletes, Escape cancels
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            killThreadConfirmRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete thread</DialogTitle>
            <DialogDescription>
              {confirmKillThread !== undefined && (
                <>
                  <span className="font-mono text-foreground">
                    {threadTitle(confirmKillThread)}
                  </span>{" "}
                  — its transcript will be permanently deleted.{" "}
                  {threads.some(
                    (row) =>
                      row.id !== confirmKillThread.id &&
                      sessionOfId(row.id) === sessionOfId(confirmKillThread.id),
                  )
                    ? "The session and its machine stay."
                    : "It is the session's last thread — the session and its machine go with it."}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton={false}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmKillThread(undefined)}
            >
              Cancel
            </Button>
            <Button
              ref={killThreadConfirmRef}
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirmKillThread !== undefined) {
                  killThread(confirmKillThread);
                }
              }}
            >
              <Trash2 /> Delete thread
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* BULK-CLOSE CONFIRMATION — "close all" / "close all to the
          right" that includes threads: their transcripts are destroyed
          (terminal-only closes never ask). */}
      <Dialog
        open={confirmCloseTabs !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmCloseTabs(undefined);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-sm"
          // confirm is the DEFAULT: Enter closes, Escape cancels
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeTabsConfirmRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Close tabs</DialogTitle>
            <DialogDescription>
              {confirmCloseTabs !== undefined && (
                <>
                  {confirmCloseTabs.threads.length} thread
                  {confirmCloseTabs.threads.length === 1 ? "" : "s"} will be
                  permanently deleted (transcripts included)
                  {confirmCloseTabs.terminals.length > 0 && (
                    <>
                      {" "}
                      and {confirmCloseTabs.terminals.length} terminal
                      {confirmCloseTabs.terminals.length === 1 ? "" : "s"}{" "}
                      killed
                    </>
                  )}
                  . The session and its machine stay.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton={false}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmCloseTabs(undefined)}
            >
              Cancel
            </Button>
            <Button
              ref={closeTabsConfirmRef}
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirmCloseTabs !== undefined) {
                  closeTabs(confirmCloseTabs);
                }
              }}
            >
              <Trash2 /> Close tabs
            </Button>
          </DialogFooter>
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
        <DialogContent
          showCloseButton={false}
          className="max-w-sm"
          // confirm is the DEFAULT: Enter deletes, Escape cancels
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            deleteSessionConfirmRef.current?.focus();
          }}
        >
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
              ref={deleteSessionConfirmRef}
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirmDelete !== undefined)
                  void deleteSession(confirmDelete);
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
              {name === "code"
                ? "Code"
                : `Review${openPrCount > 0 ? ` (${openPrCount})` : ""}`}
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
                  <ContextMenu key={group.session}>
                    <ContextMenuTrigger asChild>
                      <div
                        onClick={() => {
                          // a session mid-delete is not navigable
                          if (deleting.has(group.session)) return;
                          openSession(group);
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
                            {displayName(
                              `session:${group.session}`,
                              group.label,
                            )}
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
                          {deleting.has(group.session)
                            ? "deleting…"
                            : group.status}
                          <span className="ml-auto">
                            <AtTooltip at={group.updatedAt}>
                              <span className="cursor-default">
                                {timeAgo(group.updatedAt)}
                              </span>
                            </AtTooltip>
                          </span>
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent
                      onCloseAutoFocus={(event) => event.preventDefault()}
                    >
                      <ContextMenuItem
                        onSelect={() => newThread(group.session)}
                      >
                        <MessageSquare /> New thread
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          openSession(group);
                          newTerminal(group.session);
                        }}
                      >
                        <SquareTerminal /> New terminal
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() =>
                          startRename(
                            "session",
                            `session:${group.session}`,
                            group.label,
                          )
                        }
                      >
                        <Pencil /> Rename session…
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      {(group.status === "running" ||
                        group.status === "idle") && (
                        <ContextMenuItem onSelect={() => stopSession(group)}>
                          <Square /> Stop session
                        </ContextMenuItem>
                      )}
                      {group.status === "settled" && (
                        <ContextMenuItem onSelect={() => resumeSession(group)}>
                          <Play /> Resume session
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() => setConfirmDelete(group)}
                      >
                        <Trash2 /> Delete session…
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
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
              const session = `${repo}#${pull.number}`;
              const group = groups.find((entry) => entry.session === session);
              const threadCount =
                (group?.threads.length ?? 0) + (pull.session ? 1 : 0);
              const terminalCount = terminals[session]?.length ?? 0;
              const working =
                pull.session?.status === "running" ||
                group?.status === "running";
              return (
                <ContextMenu key={pull.number}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => openPullSession(session)}
                      className={cn(
                        "flex w-full flex-col gap-1 border-b border-border/50 px-3 py-2 text-left hover:bg-accent/50",
                        session === reviewSession && "bg-accent",
                      )}
                    >
                      <span className="flex w-full items-center gap-2">
                        <IssueBadge
                          number={pull.number}
                          state={pull.state}
                          repo={repo}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                          {pull.title}
                        </span>
                        {working && (
                          <span className="size-2 shrink-0 animate-pulse rounded-full bg-moss" />
                        )}
                      </span>
                      {(threadCount > 0 || terminalCount > 0) && (
                        <span className="flex items-center gap-2 pl-1 font-mono text-[10px] text-muted-foreground">
                          {threadCount > 0 && (
                            <span className="flex items-center gap-1">
                              <MessageSquare className="size-3" />
                              {threadCount}
                            </span>
                          )}
                          {terminalCount > 0 && (
                            <span className="flex items-center gap-1">
                              <SquareTerminal className="size-3" />
                              {terminalCount}
                            </span>
                          )}
                          {pull.session !== undefined && (
                            <span className="ml-auto">
                              review · {pull.session.status}
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    <ContextMenuItem
                      onSelect={() => {
                        openPullSession(session);
                        newThread(session);
                      }}
                    >
                      <MessageSquare /> New thread
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        openPullSession(session);
                        newTerminal(session);
                      }}
                    >
                      <SquareTerminal /> New terminal
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      disabled={
                        pull.session !== undefined ||
                        requested.has(pull.number) ||
                        reviewUnavailable
                      }
                      onSelect={() => requestReview(pull.number)}
                    >
                      <MessageSquareText /> Request review
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={machines[session]?.phase === "checking-out"}
                      onSelect={() => checkoutPull(session)}
                    >
                      <RefreshCw /> Pull PR head onto machine
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {board.prs.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">
                No pull requests yet — open one on the repository and the bot
                reviews it.
              </div>
            )}
          </div>
        )}
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* ── the SESSION CHROME — one tab strip for both activities:
            a coding session's threads + terminals; a pull request's
            overview + the bot's review + threads + terminals ── */}
        {activity === "code" &&
          currentGroup !== undefined &&
          tabStrip({
            session: currentGroup.session,
            leading: [],
            threads: currentGroup.threads,
            selected: activeView,
            summary: `one machine · ${currentGroup.threads.length} thread${
              currentGroup.threads.length === 1 ? "" : "s"
            }`,
          })}
        {activity === "review" && reviewSession !== undefined && (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
              <IssueBadge
                number={pullNumberOf(reviewSession)}
                state={reviewPull?.state ?? "unknown"}
                repo={board.repo || undefined}
              />
              <span className="min-w-0 truncate text-foreground">
                {reviewPull?.title ?? reviewSession}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {machines[reviewSession]?.phase === "checking-out" && (
                  <>
                    <Spinner className="size-3" /> pulling…
                  </>
                )}
                {machines[reviewSession]?.phase === "ready" && (
                  <>
                    on {(machines[reviewSession] as { branch: string }).branch}
                  </>
                )}
                {machines[reviewSession]?.phase === "error" && (
                  <span className="text-brick">machine error</span>
                )}
              </span>
            </div>
            {tabStrip({
              session: reviewSession,
              leading: [
                {
                  kind: "lead",
                  id: overviewId(reviewSession),
                  label: (
                    <>
                      <GitPullRequestArrow className="size-3.5" /> Pull request
                    </>
                  ),
                  status: undefined,
                  onSelect: () => openOverview(reviewSession),
                },
                ...(reviewBotId !== undefined && reviewPull?.session
                  ? [
                      {
                        kind: "lead" as const,
                        id: reviewBotId,
                        label: "Review",
                        status: reviewPull.session.status,
                        onSelect: () => openThread(reviewBotId),
                      },
                    ]
                  : []),
              ],
              threads: reviewThreads,
              selected: activeView,
              summary: `one machine · ${reviewThreads.length} thread${
                reviewThreads.length === 1 ? "" : "s"
              }`,
            })}
          </>
        )}
        {/* ── the VIEWS: every visited one stays mounted (visibility
            flips — scroll position, sockets, and shells survive) ── */}
        <div className="relative min-h-0 flex-1">
          {activity === "code" && codeId === undefined && !terminalActive && (
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
          {activity === "review" && reviewSession === undefined && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a pull request.
            </div>
          )}
          {visited
            .filter(
              (id) => id.startsWith("Engineer:") || id.startsWith("Reviewer:"),
            )
            .map((id) => {
              const shown = activeView === id;
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
                    onOpenThread={openThread}
                  />
                </div>
              );
            })}
          {visited
            .filter((id) => id.startsWith("pr:"))
            .map((id) => {
              const session = id.slice("pr:".length);
              const number = pullNumberOf(session);
              const pull = board.prs.find((entry) => entry.number === number);
              const shown = activeView === id;
              return (
                <div
                  key={id}
                  className={cn(
                    "absolute inset-0 flex flex-col",
                    shown ? "visible" : "pointer-events-none invisible",
                  )}
                >
                  <PullRequestOverview
                    repo={session.slice(0, session.lastIndexOf("#"))}
                    number={number}
                    active={shown}
                    Markdown={MarkdownText}
                    machine={machines[session] ?? { phase: "idle" }}
                    onCheckout={() => checkoutPull(session)}
                    onNewThread={() => newThread(session)}
                    onNewTerminal={() => newTerminal(session)}
                    review={
                      pull?.session !== undefined
                        ? {
                            status: "session",
                            running: pull.session.status === "running",
                          }
                        : {
                            status: "none",
                            requested: requested.has(number),
                            unavailable: reviewUnavailable,
                          }
                    }
                    onRequestReview={() => requestReview(number)}
                    proposals={proposals.filter(
                      (proposal) =>
                        proposal.number === number &&
                        proposal.repo ===
                          session.slice(0, session.lastIndexOf("#")),
                    )}
                    proposalBusy={proposalBusy}
                    onAcceptProposal={(id) => settleProposal(id, "accept")}
                    onRejectProposal={(id, reason) =>
                      settleProposal(id, "reject", reason)
                    }
                    onReviseProposal={(id, message) =>
                      settleProposal(id, "revise", message)
                    }
                    onOpenSession={(id) => openThread(id)}
                  />
                </div>
              );
            })}
          {Object.entries(terminals)
            .filter(([session]) => visitedSessions.has(session))
            .flatMap(([session, ptyIds]) =>
              ptyIds.map((ptyId) => {
                const shown = activeView === `pty:${session}\u001f${ptyId}`;
                return (
                  <div
                    key={`${session}\u001f${ptyId}`}
                    className={cn(
                      "absolute inset-0 flex flex-col",
                      shown ? "visible" : "pointer-events-none invisible",
                    )}
                  >
                    <GhosttyTerminal
                      sessionId={`Engineer:${session}`}
                      ptyId={ptyId}
                      active={shown}
                      registerKill={(kill) =>
                        terminalKillers.current.set(
                          `${session}\u001f${ptyId}`,
                          kill,
                        )
                      }
                    />
                  </div>
                );
              }),
            )}
        </div>
        {/* the inbox — one card per pending proposal, anywhere in the app */}
        {pendingProposals.length > 0 && (
          <div
            aria-label="proposals"
            className="absolute bottom-4 right-4 z-20 flex max-h-[70vh] w-[26rem] flex-col gap-2 overflow-y-auto"
          >
            {pendingProposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                Markdown={MarkdownText}
                compact
                busy={proposalBusy.has(proposal.id)}
                onAccept={() => settleProposal(proposal.id, "accept")}
                onReject={(reason) =>
                  settleProposal(proposal.id, "reject", reason)
                }
                onRevise={(message) =>
                  settleProposal(proposal.id, "revise", message)
                }
                onOpenSession={() =>
                  openThread(`${proposal.session.term}:${proposal.session.key}`)
                }
              />
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
    /** Snapshot delivered → socket tails live from the watermark. A
     *  failed snapshot (backend unreachable) → the socket replays the
     *  full history instead; user messages ride `onInput`. */
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
  // twice); `"replay"` when the snapshot failed and the socket owns
  // the history. SAME-ORIGIN like every other request: `/attach/*`
  // rides the service binding to the backend, in dev included (the
  // vite chain relays WebSocket upgrades — cloudflare-runtime's
  // `websockets.ts`).
  const agent = useAgent({
    chatId: id,
    history: hydrated ? "live" : "replay",
  });
  // The socket stays OPEN while the thread is hidden — visited tabs
  // are never paused. Stopping on hide forced a full history REPLAY on
  // re-select, which rebuilt the whole conversation and snapped the
  // scroll: the visible
  // "re-render" switching threads. A handful of idle hibernatable
  // sockets is far cheaper than that.
  const { messages, sendMessage, status } = useChat({
    agent,
    messages: initial,
    resume: true,
    persist: true,
  });

  // A selected thread is a thread you're about to TALK to — put the
  // caret in the prompt (first visit and every return).
  const promptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    promptRef.current?.querySelector("textarea")?.focus();
  }, [active]);

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
                                        <Ansi text={tool.output} />
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
      <div ref={promptRef} className="mx-auto w-full max-w-3xl p-4">
        <PromptInput onSubmit={onSubmit}>
          <PromptInputBody>
            {/* pr-12 keeps typed text clear of the submit button */}
            <PromptInputTextarea
              placeholder={
                id.startsWith("Reviewer:")
                  ? "Talk to the reviewer…"
                  : "Talk to the engineer…"
              }
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

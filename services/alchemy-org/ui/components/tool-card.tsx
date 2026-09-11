import {
  AlarmClock,
  BookmarkPlus,
  ChevronDown,
  CircleCheck,
  CircleSlash,
  Eraser,
  FilePen,
  FilePlus2,
  FileText,
  FolderSearch,
  FolderTree,
  GitFork,
  GitPullRequestArrow,
  Hammer,
  List,
  MessageSquare,
  Network,
  Paperclip,
  ScrollText,
  Search,
  Send,
  Signpost,
  Sparkles,
  SquareArrowOutUpRight,
  SquareCode,
  StickyNote,
  Tag,
  Terminal,
  Upload,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type * as AI from "alchemy/AI";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { GeneralEngineer } from "../../src/coding/Engineer.ts";
import { useAnchoredToggle } from "@/lib/anchor";
import { Ansi, stripAnsi } from "@/lib/ansi";
import { CodeCard } from "@/components/code";
import { cn } from "@/lib/utils";

/* ── helpers ─────────────────────────────────────────────────── */

const firstLine = (text: string): string => {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : `${text.slice(0, nl)} …`;
};

const clamp = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

const countLines = (text: string): number =>
  text.length === 0 ? 0 : text.split("\n").length;

/**
 * Per-tool transcript cards — a REGISTRY keyed by tool name (the
 * OpenCode pattern), each renderer producing a one-line verb summary
 * (the pi/Codex pattern: `$ cmd`, `Read path`, `Edit path +3 −1`)
 * with expandable per-tool detail. Unknown tools fall back to the
 * generic collapsible card.
 */

/** Tool outputs are the record of the tool's `AI.out(…)` splices —
 *  the transcript hands renderers the JSON-stringified value, so a
 *  structured renderer parses it back. */
const parseRecord = (
  raw: string | undefined,
): Record<string, any> | undefined => {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
};

/** +N −M across a patch/diff text (grammar: leading + / -). */
const diffStat = (text: string): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (/^\+(?!\+\+)/.test(line)) added++;
    else if (/^-(?!--)/.test(line)) removed++;
  }
  return { added, removed };
};

const DiffStatBadge = ({
  added,
  removed,
}: {
  added: number;
  removed: number;
}) =>
  added === 0 && removed === 0 ? null : (
    <span className="shrink-0 font-mono text-[11px]">
      {added > 0 && <span className="text-moss">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-brick">−{removed}</span>}
    </span>
  );

/** Unified-diff / patch text with +/− line coloring. */
const DiffText = ({ text }: { text: string }) => (
  <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] leading-4">
    {text.split("\n").map((line, index) => (
      <div
        key={index}
        className={cn(
          line.startsWith("+") && !line.startsWith("+++")
            ? "bg-moss/15 text-moss"
            : line.startsWith("-") && !line.startsWith("---")
              ? "bg-brick/15 text-brick"
              : /^(@@|\*\*\*|diff |index )/.test(line)
                ? "text-muted-foreground"
                : undefined,
        )}
      >
        {line || " "}
      </div>
    ))}
  </pre>
);

/** Plain monospace block; string children render their ANSI colors.
 *  `wrap: false` keeps every line whole and scrolls sideways instead. */
const Mono = ({
  children,
  wrap = true,
}: {
  children: ReactNode;
  wrap?: boolean;
}) => (
  <pre
    className={cn(
      "max-h-80 overflow-auto p-2 font-mono text-[11px] leading-4",
      wrap ? "whitespace-pre-wrap" : "whitespace-pre",
    )}
  >
    {typeof children === "string" ? <Ansi text={children} /> : children}
  </pre>
);

/** Head+tail window (the Codex convention) for long plain output. */
const WindowedText = ({
  text,
  head = 8,
  tail = 12,
}: {
  text: string;
  head?: number;
  tail?: number;
}) => {
  const lines = text.split("\n");
  if (lines.length <= head + tail + 1) return <Mono>{text}</Mono>;
  const omitted = lines.length - head - tail;
  return (
    <Mono>
      <Ansi text={lines.slice(0, head).join("\n")} />
      {"\n"}
      <span className="text-muted-foreground">… +{omitted} lines</span>
      {"\n"}
      <Ansi text={lines.slice(-tail).join("\n")} />
    </Mono>
  );
};

/* ── opening a subagent ──────────────────────────────────────── */

/** What a spawn card knows about its subagent: the session `key`
 *  once the spawn has settled (it rides the tool's output), and the
 *  `brief` from the very first chunk — the thread view matches a
 *  still-running card to its subagent by that. */
export interface SpawnTarget {
  readonly key?: string;
  readonly brief?: string;
}

/** How a spawn card opens its subagent's session — the thread view
 *  provides one; anywhere else the card has no door and shows none. */
export const OpenAgentContext = createContext<
  ((target: SpawnTarget) => void) | undefined
>(undefined);

/** One agent as the thread's STATE has it — what a spawn card reads
 *  its state from, so the card never says "working" over an agent the
 *  operator stopped or deleted while the spawn call is still open. */
export interface Subagent {
  readonly key: string;
  readonly brief: string;
  readonly state: "running" | "done" | "failed" | "stopped";
  readonly startedAt: number;
}

/** The thread's agents, live — provided by the thread view; `undefined`
 *  anywhere the thread state is not at hand (the card then trusts the
 *  call). */
export const SubagentsContext = createContext<
  ReadonlyArray<Subagent> | undefined
>(undefined);

/** The subagent for a spawn target: by key once the call answered; while
 *  it is still working only the brief is on the wire — the newest
 *  agent with that brief. */
export const findSubagent = (
  agents: ReadonlyArray<Subagent>,
  target: SpawnTarget,
): Subagent | undefined =>
  (target.key !== undefined
    ? agents.find((agent) => agent.key === target.key)
    : undefined) ??
  [...agents]
    .sort((a, b) => b.startedAt - a.startedAt)
    .find((agent) => agent.brief === target.brief);

/** What a spawn card shows instead of "working" when the thread state
 *  says the agent is not running (or no longer exists) while its call
 *  is open. */
export const spawnSettledLabel = (
  agents: ReadonlyArray<Subagent> | undefined,
  target: SpawnTarget,
): string | undefined => {
  if (agents === undefined) return undefined;
  const found = findSubagent(agents, target);
  if (found === undefined) return "deleted";
  return found.state === "running" ? undefined : found.state;
};

const OpenAgentButton = ({ target }: { target: SpawnTarget }) => {
  const open = useContext(OpenAgentContext);
  if (open === undefined) return null;
  // the card's header is itself a button (expand/collapse), so this is
  // a role=button span — nested <button>s are invalid HTML
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        open(target);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          open(target);
        }
      }}
      aria-label="Open the agent's session"
      className="flex cursor-pointer items-center gap-1 rounded border border-border px-1.5 py-0 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <SquareArrowOutUpRight className="size-3" />
      open
    </span>
  );
};

/* ── the registry ────────────────────────────────────────────── */

export interface ToolCallView {
  /** The tool's icon — terminal, file, search, PR… */
  readonly icon: LucideIcon;
  /** The one-line verb + target. */
  readonly title: ReactNode;
  /** Secondary badge: diffstat, exit code, match count… */
  readonly badge?: ReactNode;
  /** Expanded detail; undefined = nothing to expand. */
  readonly body?: ReactNode;
  /** The card's own verdict that the call is OVER although the
   *  transcript still shows it open — shown in place of "running…",
   *  and the card stops pulsing. */
  readonly settled?: string;
  /** Collapsed result line (`→ …`) — the outcome without expanding. */
  readonly summary?: string;
  /** Open the body on first render — for cards whose detail IS the
   *  story (eval's program), not an appendix. */
  readonly defaultOpen?: boolean;
}

/** The last non-empty line — where a command's verdict usually is.
 *  Plain text: the summary row is truncated by character count. */
const lastLine = (text: string): string | undefined => {
  const lines = stripAnsi(text)
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
};

/** One value of a structured answer, on one line. */
const compactValue = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? `${value.length} item${value.length === 1 ? "" : "s"}`
      : value !== null && typeof value === "object"
        ? `{${Object.keys(value).length} fields}`
        : String(value);

/**
 * The collapsed `→ …` line for a tool's answer. Tools answer STRUCTURED
 * data (every `AI.out` field, as JSON), and a renderer sees it
 * pretty-printed — so "the last line" of an object is its closing
 * brace. An object reads as its fields (`kind pull · title Fix…`), an
 * array as its length, a string as its last non-empty line (where a
 * command's verdict usually is).
 */
const summarize = (output: string): string | undefined => {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return compactValue(parsed);
      if (parsed !== null && typeof parsed === "object") {
        const fields = Object.entries(parsed).filter(
          ([, value]) => value !== undefined && value !== null && value !== "",
        );
        if (fields.length === 0) return undefined;
        return fields
          .map(([key, value]) => `${key} ${compactValue(value)}`)
          .join(" · ");
      }
    } catch {
      // not JSON after all — a string that happens to open with a brace
    }
  }
  return lastLine(output);
};

const outputText = (output: unknown): string | undefined =>
  // null/undefined both mean "answered nothing" — void tools land here
  output == null
    ? undefined
    : typeof output === "string"
      ? output
      : JSON.stringify(output, null, 2);

/** A renderer as the transcript sees it — the wire is untyped JSON, so
 *  `input` is `any` here; the Engineer's own cards are authored against
 *  their PRECISE input types (see {@link CODER}) and merge in. */
/** What the transcript's surroundings tell a card — the thread's
 *  subagents, when the card renders inside a thread. */
export interface RenderEnv {
  readonly agents?: ReadonlyArray<Subagent>;
}

type Renderer = (
  input: any,
  output: string | undefined,
  running: boolean,
  env: RenderEnv,
) => ToolCallView;

/**
 * THIS app's registry contract for one agent/skill layer: a card per
 * wire tool, each receiving that tool's typed input. Built on the
 * core's type-level facts (`AI.ToolNames` / `AI.ToolInput` — the wire
 * surface a `make` Layer carries); the registry SHAPE — this signature,
 * `ToolCallView` — is ours, which is why the type lives here and not
 * in alchemy.
 */
type Renderers<L> = {
  [Name in AI.ToolNames<L> & string]: (
    input: AI.ToolInput<L, Name>,
    output: string | undefined,
    running: boolean,
  ) => ToolCallView;
};

/* ── the Thread's and Channel's wires ────────────────────────── */

/** Readable text the agent wrote — a brief, a comment, a rule — as
 *  prose rather than monospace. */
const Prose = ({ children }: { children: string }) => (
  <div className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 text-[13px] leading-5">
    {children}
  </div>
);

/** `#N` / `owner/repo#N` as the agent named it. */
const Ref = ({ value }: { value: string | number | undefined }) => (
  <span className="font-mono text-mist">
    {typeof value === "number" ? `#${value}` : (value ?? "?")}
  </span>
);

/** A thread id (`t-…`) as the transcript names it. */
const ThreadId = ({ id }: { id: string | undefined }) => (
  <span className="font-mono text-mist">{id ?? "?"}</span>
);

/** The "why" of a judgement or a decision, as its own paragraph. */
const Why = ({ why }: { why: string | undefined }) =>
  why ? (
    <div className="px-3 py-2 text-[12px] leading-5 text-muted-foreground">
      {why}
    </div>
  ) : null;

/** A thread's state as `read_state` / `read_thread` answer it — the
 *  org's record of one thread, loosely typed off the wire. */
interface ThreadStateAnswer {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly status?: string;
  readonly turn?: string;
  readonly assigned?: ReadonlyArray<{
    readonly ref?: string;
    readonly kind?: string;
    readonly state?: string;
    readonly title?: string;
    readonly worktree?: string;
  }>;
  readonly agents?: ReadonlyArray<{
    readonly key?: string;
    readonly kind?: string;
    readonly brief?: string;
    readonly state?: string;
  }>;
}

/** The answer's state, whether the tool wrapped it (`{ state }`) or not. */
const parseThreadState = (
  output: string | undefined,
): ThreadStateAnswer | undefined => {
  const record = parseRecord(output);
  if (record === undefined) return undefined;
  const state = record.state ?? record;
  return typeof state === "object" &&
    state !== null &&
    ("assigned" in state || "agents" in state || "status" in state)
    ? (state as ThreadStateAnswer)
    : undefined;
};

const AGENT_STATE_DOT: Record<string, string> = {
  running: "bg-moss animate-pulse",
  done: "bg-muted-foreground/50",
  failed: "bg-destructive",
  stopped: "bg-amber-500",
};

/** The state, laid out: what the thread governs and who is working. */
const ThreadStateBody = ({ state }: { state: ThreadStateAnswer }) => {
  const assigned = state.assigned ?? [];
  const agents = state.agents ?? [];
  return (
    <div className="divide-y divide-border/50 text-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
        {state.name && <span className="font-medium">{state.name}</span>}
        {state.title && (
          <span className="text-muted-foreground">{state.title}</span>
        )}
        <span className="ml-auto flex shrink-0 gap-2 text-[11px] text-muted-foreground">
          {state.status && <span>{state.status}</span>}
          {state.turn && <span>turn: {state.turn}</span>}
        </span>
      </div>
      <div className="px-3 py-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">
          Assigned · {assigned.length}
        </div>
        {assigned.length === 0 ? (
          <div className="text-muted-foreground">nothing assigned</div>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {assigned.map((entity, index) => (
              <li
                key={entity.ref ?? index}
                className="flex min-w-0 items-baseline gap-2"
              >
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  {entity.kind ?? "?"}
                </span>
                <Ref value={entity.ref} />
                {entity.state && (
                  <span className="shrink-0 text-muted-foreground">
                    {entity.state}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {entity.title ?? ""}
                </span>
                {entity.worktree && (
                  <span
                    title={entity.worktree}
                    className="shrink-0 font-mono text-[10px] text-muted-foreground"
                  >
                    {entity.worktree.split("/").pop()}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="px-3 py-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">
          Agents · {agents.length}
        </div>
        {agents.length === 0 ? (
          <div className="text-muted-foreground">none</div>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {agents.map((agent, index) => (
              <li
                key={agent.key ?? index}
                className="flex min-w-0 items-center gap-2"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    AGENT_STATE_DOT[agent.state ?? ""] ??
                      "bg-muted-foreground/40",
                  )}
                />
                <span className="shrink-0 font-medium">
                  {agent.kind ?? "agent"}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {firstLine(agent.brief ?? "")}
                </span>
                {agent.state && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {agent.state}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/** The collapsed line for a thread's state: what it holds, in counts. */
const summarizeThreadState = (state: ThreadStateAnswer): string => {
  const assigned = state.assigned ?? [];
  const agents = state.agents ?? [];
  const running = agents.filter((agent) => agent.state === "running").length;
  const count = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  return [
    state.status,
    `${assigned.length} assigned`,
    running > 0
      ? `${count(agents.length, "agent", "agents")} (${running} working)`
      : count(agents.length, "agent", "agents"),
  ]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" · ");
};

/**
 * Cards for the THREAD agent's wire (`src/thread/ThreadAgent.ts`).
 * All of its tools are inline `AI.Tool`s — runtime-only, no tag on
 * any requirement channel — so their names and input shapes are
 * declared by hand here and must be kept in step with the charter.
 */
const THREAD: {
  /** Shared with the channel agent — its call names the `thread` the
   *  ref goes to; the thread agent's own call is about itself. */
  assign: (
    input: { ref: string; thread?: string; title?: string },
    output: string | undefined,
  ) => ToolCallView;
  unassign: (
    input: { ref: string; thread?: string },
    output: string | undefined,
  ) => ToolCallView;
  worktree: (
    input: { ref: string },
    output: string | undefined,
  ) => ToolCallView;
  read_state: (input: unknown, output: string | undefined) => ToolCallView;
  /** Two tools share the name: the thread agent's `spawn` (an Engineer
   *  on a `brief`) and the driver's intrinsic `spawn` (an anonymous
   *  subagent given `instructions` + a `task`). */
  spawn: (
    input: { brief?: string; instructions?: string; task?: string },
    output: string | undefined,
    running: boolean,
    env: RenderEnv,
  ) => ToolCallView;
  post_card: (input: { title: string; text: string }) => ToolCallView;
  /** Shared with the channel agent's bookkeeping close — the thread
   *  agent's call carries `why`, the channel's carries `thread`. */
  close_thread: (
    input: { why?: string; thread?: string },
    output: string | undefined,
  ) => ToolCallView;
} = {
  assign: (input, output) => ({
    icon: Paperclip,
    title: (
      <>
        Assign <Ref value={input.ref} />
        {input.thread && (
          <>
            {" "}
            <span className="text-muted-foreground">→</span>{" "}
            <ThreadId id={input.thread} />
          </>
        )}
        {input.title && (
          <>
            <span className="text-muted-foreground"> · </span>
            {clamp(input.title, 100)}
          </>
        )}
      </>
    ),
    summary: output === undefined ? undefined : summarize(output),
  }),

  unassign: (input, output) => ({
    icon: CircleSlash,
    title: (
      <>
        Unassign <Ref value={input.ref} />
        {input.thread && (
          <>
            {" "}
            <span className="text-muted-foreground">from</span>{" "}
            <ThreadId id={input.thread} />
          </>
        )}
      </>
    ),
    summary: output === undefined ? undefined : summarize(output),
  }),

  worktree: (input, output) => {
    const record = parseRecord(output);
    return {
      icon: FolderTree,
      title: (
        <>
          Worktree for <Ref value={input.ref} />
        </>
      ),
      summary:
        record === undefined ? undefined : `${record.path} (${record.branch})`,
    };
  },

  read_state: (_input, output) => {
    const state = parseThreadState(output);
    return {
      icon: Waypoints,
      title: <>Read the thread's state</>,
      summary: state === undefined ? undefined : summarizeThreadState(state),
      body:
        state !== undefined ? (
          <ThreadStateBody state={state} />
        ) : output === undefined ? undefined : (
          <WindowedText text={output} head={20} tail={5} />
        ),
    };
  },

  spawn: (input, output, running, env) => {
    const intrinsic = input.brief === undefined;
    const brief = input.brief ?? input.task ?? "";
    const record = parseRecord(output);
    const report =
      (record?.report as string | undefined) ??
      (record === undefined ? output : undefined);
    const agentKey =
      typeof record?.agent === "string" ? record.agent : undefined;
    // the thread state outranks the open call: an engineer the operator
    // stopped or deleted mid-spawn is not "working", whatever the
    // transcript still owes
    const settled =
      running && !intrinsic
        ? spawnSettledLabel(env.agents, { key: agentKey, brief: input.brief })
        : undefined;
    return {
      icon: Hammer,
      settled,
      title: (
        <>
          {intrinsic ? "Subagent" : "Engineer"}{" "}
          <span className="text-muted-foreground">·</span>{" "}
          {clamp(firstLine(brief), 110)}
        </>
      ),
      badge: (
        <span className="flex shrink-0 items-center gap-2">
          {running && settled === undefined && (
            <span className="animate-pulse text-[11px] text-moss">working</span>
          )}
          {!intrinsic && (
            <OpenAgentButton target={{ key: agentKey, brief: input.brief }} />
          )}
        </span>
      ),
      body: (
        <div className="divide-y divide-border/50">
          {input.instructions && (
            <div>
              <div className="px-2 pt-1.5 text-[11px] font-medium text-muted-foreground">
                instructions
              </div>
              <Prose>{input.instructions}</Prose>
            </div>
          )}
          {countLines(brief) > 1 && <Prose>{brief}</Prose>}
          {report !== undefined && report.length > 0 && (
            <WindowedText text={report} />
          )}
        </div>
      ),
    };
  },

  post_card: (input) => ({
    icon: Send,
    title: (
      <>
        Card <span className="text-muted-foreground">·</span>{" "}
        {clamp(input.title ?? "", 110)}
      </>
    ),
    body: input.text ? <Prose>{input.text}</Prose> : undefined,
  }),

  close_thread: (input, output) => ({
    icon: CircleCheck,
    title:
      input.thread === undefined ? (
        <>Close the thread</>
      ) : (
        <>
          Close <ThreadId id={input.thread} />
        </>
      ),
    summary: output === undefined ? undefined : summarize(output),
    body: input.why === undefined ? undefined : <Why why={input.why} />,
  }),
};

/**
 * Cards for the CHANNEL agent's wire (`src/channel/ChannelAgent.ts`)
 * — inline tools, hand declared like the thread's. Its runs mostly
 * read (search_messages, read_history, read_thread) and route
 * (create_thread, place_messages, assign); every card is one
 * line with the detail a click away.
 */
const CHANNEL: {
  search_messages: (
    input: { q: string },
    output: string | undefined,
  ) => ToolCallView;
  read_history: (input: unknown, output: string | undefined) => ToolCallView;
  read_messages: (
    input: { ids: ReadonlyArray<string> },
    output: string | undefined,
  ) => ToolCallView;
  list_threads: (input: unknown, output: string | undefined) => ToolCallView;
  read_thread: (
    input: { thread: string },
    output: string | undefined,
  ) => ToolCallView;
  create_thread: (
    input: { name: string; title: string },
    output: string | undefined,
  ) => ToolCallView;
  place_messages: (
    input: { thread: string; ids: ReadonlyArray<string> },
    output: string | undefined,
  ) => ToolCallView;
  brief_thread: (
    input: { thread: string; text: string },
    output: string | undefined,
  ) => ToolCallView;
  rename_thread: (input: {
    thread: string;
    name?: string;
    title?: string;
  }) => ToolCallView;
  read_issue: (
    input: { repo: string; number: number },
    output: string | undefined,
  ) => ToolCallView;
  read_pull: (
    input: { repo: string; number: number },
    output: string | undefined,
  ) => ToolCallView;
  send_reply: (input: { text: string }) => ToolCallView;
} = {
  search_messages: (input, output) => ({
    icon: Search,
    title: (
      <>
        Search <span className="font-mono">{clamp(input.q ?? "", 80)}</span>
      </>
    ),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  read_history: (_input, output) => ({
    icon: ScrollText,
    title: <>Page the channel</>,
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  read_messages: (input, output) => ({
    icon: FileText,
    title: (
      <>
        Read{" "}
        <span className="font-mono text-mist">
          {input.ids?.length ?? 0} message{input.ids?.length === 1 ? "" : "s"}
        </span>
      </>
    ),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  list_threads: (_input, output) => ({
    icon: List,
    title: <>List the threads</>,
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  read_thread: (input, output) => {
    const state = parseThreadState(output);
    return {
      icon: Waypoints,
      title: (
        <>
          Show <ThreadId id={input.thread} />
        </>
      ),
      summary: state === undefined ? undefined : summarizeThreadState(state),
      body:
        state !== undefined ? (
          <ThreadStateBody state={state} />
        ) : output === undefined ? undefined : (
          <WindowedText text={output} head={20} tail={5} />
        ),
    };
  },

  create_thread: (input, output) => ({
    icon: GitFork,
    title: (
      <>
        New thread <span className="font-medium">{input.name}</span>
        {input.title && (
          <>
            <span className="text-muted-foreground"> · </span>
            {clamp(input.title, 90)}
          </>
        )}
      </>
    ),
    summary: output === undefined ? undefined : summarize(output),
  }),

  place_messages: (input, output) => ({
    icon: Paperclip,
    title: (
      <>
        Place{" "}
        <span className="font-mono text-mist">
          {input.ids?.length ?? 0} message{input.ids?.length === 1 ? "" : "s"}
        </span>{" "}
        <span className="text-muted-foreground">→</span>{" "}
        <ThreadId id={input.thread} />
      </>
    ),
    summary: output === undefined ? undefined : summarize(output),
  }),

  brief_thread: (input, output) => ({
    icon: Send,
    title: (
      <>
        Brief <ThreadId id={input.thread} />{" "}
        <span className="text-muted-foreground">·</span>{" "}
        {clamp(firstLine(input.text ?? ""), 90)}
      </>
    ),
    summary: output === undefined ? undefined : summarize(output),
    body:
      countLines(input.text ?? "") > 1 ? (
        <Prose>{input.text}</Prose>
      ) : undefined,
  }),

  rename_thread: (input) => ({
    icon: Tag,
    title: (
      <>
        Rename <ThreadId id={input.thread} />
        {input.name && (
          <>
            {" "}
            <span className="font-medium">{input.name}</span>
          </>
        )}
        {input.title && (
          <>
            <span className="text-muted-foreground"> · </span>
            {clamp(input.title, 90)}
          </>
        )}
      </>
    ),
  }),

  read_issue: (input, output) => ({
    icon: FileText,
    title: (
      <>
        Read issue <Ref value={`${input.repo}#${input.number}`} />
      </>
    ),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  read_pull: (input, output) => ({
    icon: GitPullRequestArrow,
    title: (
      <>
        Read pull <Ref value={`${input.repo}#${input.number}`} />
      </>
    ),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  send_reply: (input) => ({
    icon: MessageSquare,
    title: (
      <>
        Reply <span className="text-muted-foreground">·</span>{" "}
        {clamp(firstLine(input.text ?? ""), 110)}
      </>
    ),
    body:
      countLines(input.text ?? "") > 1 ? (
        <Prose>{input.text}</Prose>
      ) : undefined,
  }),
};

/**
 * Cards for the Engineer's wire, typed straight off the charter:
 * every class tool `GeneralEngineer`'s prose mentions rides its
 * requirement channel (mention-is-presence, lifted into the type
 * system — `AI.ToolNames` / `AI.ToolInput`), and the annotation holds
 * this object to it. Two guarantees, both compiler-enforced: mention
 * a new tool in the charter without adding its card → this object
 * errors, naming the missing tool; each renderer's `input` is that
 * tool's ACTUAL parameter type. The import of `GeneralEngineer` is
 * type-only: erased at build, no server code reaches the browser
 * bundle.
 */
const CODER: Renderers<typeof GeneralEngineer> = {
  // the word between a thread's agents — the manager holds the same
  // tool, so this card serves both wires
  message: (input) => ({
    icon: MessageSquare,
    title: (
      <>
        Message <span className="text-muted-foreground">→</span>{" "}
        <span className="font-mono">{String(input.to ?? "")}</span>
      </>
    ),
    body: input.text ? <Prose>{input.text}</Prose> : undefined,
  }),
  bash: (input, output, running) => {
    const record = parseRecord(output);
    const parsed =
      record === undefined
        ? undefined
        : {
            exit:
              typeof record.exitCode === "number" ? record.exitCode : undefined,
            stdout: String(record.stdout ?? ""),
            stderr: String(record.stderr ?? ""),
          };
    return {
      icon: Terminal,
      title: (
        <span className="font-mono">
          {clamp(firstLine(String(input.command ?? "")), 100)}
        </span>
      ),
      badge:
        parsed?.exit === undefined ? undefined : (
          <span
            className={cn(
              "shrink-0 font-mono text-[11px]",
              parsed.exit === 0 ? "text-moss" : "text-brick",
            )}
          >
            {parsed.exit === 0 ? "✓" : `✗ ${parsed.exit}`}
          </span>
        ),
      summary:
        parsed === undefined
          ? undefined
          : (lastLine(parsed.exit === 0 ? parsed.stdout : parsed.stderr) ??
            lastLine(parsed.stdout)),
      body:
        parsed === undefined && !running ? undefined : (
          <div>
            {countLines(String(input.command ?? "")) > 1 && (
              <Mono>{String(input.command)}</Mono>
            )}
            {parsed && parsed.stdout.length > 0 && (
              <WindowedText text={parsed.stdout} />
            )}
            {parsed && parsed.stderr.length > 0 && (
              <div className="border-t border-border/50">
                <div className="px-2 pt-1 text-[11px] font-medium text-muted-foreground">
                  stderr
                </div>
                <WindowedText text={parsed.stderr} />
              </div>
            )}
          </div>
        ),
    };
  },

  readFile: (input, output) => {
    const content = parseRecord(output)?.content as string | undefined;
    return {
      icon: FileText,
      title: (
        <>
          Read <span className="font-mono text-mist">{input.path}</span>
          {input.offset !== undefined && input.offset !== 1 && (
            <span className="text-muted-foreground">:{input.offset}</span>
          )}
        </>
      ),
      body:
        content === undefined ? undefined : (
          <WindowedText text={content} head={20} tail={5} />
        ),
    };
  },

  grep: (input, output) => {
    const matches = parseRecord(output)?.matches as string | undefined;
    return {
      icon: Search,
      title: (
        <>
          grep <span className="font-mono text-honey">/{input.pattern}/</span>
          {input.path && (
            <span className="text-muted-foreground"> in {input.path}</span>
          )}
        </>
      ),
      badge:
        matches === undefined ? undefined : (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {/no matches/i.test(matches) ? "0" : countLines(matches)}
          </span>
        ),
      summary:
        matches === undefined ? undefined : firstLine(stripAnsi(matches)),
      body: matches === undefined ? undefined : <WindowedText text={matches} />,
    };
  },

  glob: (input, output) => {
    const files = parseRecord(output)?.files as string | undefined;
    return {
      icon: FolderSearch,
      title: (
        <>
          glob <span className="font-mono text-honey">{input.pattern}</span>
          {input.path && (
            <span className="text-muted-foreground"> in {input.path}</span>
          )}
        </>
      ),
      badge:
        files === undefined ? undefined : (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {/no files/i.test(files) ? "0" : countLines(files)}
          </span>
        ),
      body: files === undefined ? undefined : <WindowedText text={files} />,
    };
  },

  listDirectory: (input, output) => {
    const record = parseRecord(output);
    const entries = Array.isArray(record?.entries)
      ? (record.entries as string[])
      : undefined;
    return {
      icon: FolderTree,
      title: (
        <>
          ls <span className="font-mono text-mist">{input.path || "."}</span>
        </>
      ),
      badge:
        typeof record?.total === "number" ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {record.total}
          </span>
        ) : undefined,
      body:
        entries === undefined ? undefined : (
          <WindowedText text={entries.join("\n")} />
        ),
    };
  },

  readOutput: (input, output) => {
    const content = parseRecord(output)?.content as string | undefined;
    return {
      icon: ScrollText,
      title: (
        <>
          Read output{" "}
          <span className="font-mono text-muted-foreground">
            {input.outputId}
          </span>
        </>
      ),
      body: content === undefined ? undefined : <WindowedText text={content} />,
    };
  },

  writeFile: (input, output) => ({
    icon: FilePlus2,
    title: (
      <>
        Write <span className="font-mono text-mist">{input.path}</span>
      </>
    ),
    badge: (
      <DiffStatBadge
        added={countLines(String(input.content ?? ""))}
        removed={0}
      />
    ),
    body:
      input.content === undefined ? (
        outputText(output) && <Mono>{outputText(output)}</Mono>
      ) : (
        <DiffText
          text={String(input.content)
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n")}
        />
      ),
  }),

  editFile: (input) => {
    const edits: Array<{ oldString: string; newString: string }> =
      Array.isArray(input.edits) ? input.edits : [];
    const removed = edits.reduce(
      (n, e) => n + countLines(e.oldString ?? ""),
      0,
    );
    const added = edits.reduce((n, e) => n + countLines(e.newString ?? ""), 0);
    return {
      icon: FilePen,
      title: (
        <>
          Edit <span className="font-mono text-mist">{input.path}</span>
          {edits.length > 1 && (
            <span className="text-muted-foreground">
              {" "}
              ({edits.length} edits)
            </span>
          )}
        </>
      ),
      badge: <DiffStatBadge added={added} removed={removed} />,
      body: (
        <div className="divide-y divide-border/50">
          {edits.map((edit, index) => (
            <DiffText
              key={index}
              text={[
                ...String(edit.oldString ?? "")
                  .split("\n")
                  .map((line) => `-${line}`),
                ...String(edit.newString ?? "")
                  .split("\n")
                  .map((line) => `+${line}`),
              ].join("\n")}
            />
          ))}
        </div>
      ),
    };
  },

  pushBranch: (input, output, running) => {
    const record = parseRecord(output);
    return {
      icon: Upload,
      title: (
        <>
          Push branch{" "}
          <span className="font-mono text-mist">{input.branch}</span>
        </>
      ),
      summary:
        running || record === undefined
          ? undefined
          : `pushed to ${record.remote}@${record.pushed}`,
    };
  },

  openPullRequest: (input, output) => {
    const url = parseRecord(output)?.url as string | undefined;
    return {
      icon: GitPullRequestArrow,
      title: (
        <>
          Open pull request{" "}
          <span className="font-medium">{clamp(input.title, 80)}</span>
        </>
      ),
      badge: url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 font-mono text-[11px] text-mist underline-offset-2 hover:underline"
        >
          {url.replace("https://github.com/", "")}
        </a>
      ) : undefined,
      body: input.body ? <Mono>{input.body}</Mono> : undefined,
    };
  },
};

/* ── JSON as YAML ────────────────────────────────────────────── */

/** A scalar YAML can take bare — anything else is quoted so the text
 *  round-trips: empty, leading/trailing space, YAML punctuation, or a
 *  value the reader would type as something else (`true`, `12`, `null`). */
const YAML_BARE = /^[A-Za-z_][\w ./@+-]*$/;
const YAML_TYPED = /^(true|false|null|yes|no|on|off|~|[-+]?\d[\d_.eE+-]*)$/i;
const yamlScalar = (value: string): string =>
  value.length > 0 &&
  YAML_BARE.test(value) &&
  !YAML_TYPED.test(value) &&
  value.trim() === value
    ? value
    : JSON.stringify(value);

/** Render a JSON value as YAML — the eval output an operator reads,
 *  fewer brackets and quotes than the JSON the model reads. Multi-line
 *  strings become block scalars. */
const toYaml = (value: unknown, indent = ""): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    if (value.includes("\n")) {
      const pad = `${indent}  `;
      return `|\n${value
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => (line.length === 0 ? "" : pad + line))
        .join("\n")}`;
    }
    return yamlScalar(value);
  }
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = toYaml(item, `${indent}  `);
        return isYamlBlock(item)
          ? `${indent}- ${rendered.trimStart()}`
          : `${indent}- ${rendered}`;
      })
      .join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return entries
    .map(([key, item]) => {
      const rendered = toYaml(item, `${indent}  `);
      return isYamlBlock(item)
        ? `${indent}${yamlScalar(key)}:\n${rendered}`
        : `${indent}${yamlScalar(key)}: ${rendered}`;
    })
    .join("\n");
};

/** Does this value render as an indented block (non-empty object or
 *  array) rather than inline after the key? */
const isYamlBlock = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (Array.isArray(value)
    ? value.length > 0
    : Object.keys(value as object).length > 0);

/** The eval output parsed, when CodeMode serialised a structured value
 *  (an object or array — JSON, pretty-printed). Strings, numbers and
 *  the like stay as the text they are. */
const structuredOutput = (text: string): unknown | undefined => {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** An eval result as CodeMode renders it: the program's output, then
 *  an optional `--- logs ---` section of captured console output. */
const EVAL_LOGS_MARKER = "\n\n--- logs ---\n";
const splitEvalOutput = (
  raw: string,
): { result: string; logs: string | undefined } => {
  const marker = raw.indexOf(EVAL_LOGS_MARKER);
  return marker < 0
    ? { result: raw, logs: undefined }
    : {
        result: raw.slice(0, marker),
        logs: raw.slice(marker + EVAL_LOGS_MARKER.length),
      };
};

type EvalPaneId = "output" | "logs" | "code";

/**
 * An eval card's body: ONE pane at a time behind a row of tabs —
 * what the program returned (`output`), what it logged (`logs`) and
 * what ran (`code`). It opens on the output, the answer; the logs
 * and the source are a tab away. Switching tabs is anchored — the
 * card's height changes under the cursor, the page does not move.
 */
const EvalPanes = ({
  code,
  logs,
  output,
}: {
  code: string;
  logs: string | undefined;
  output: string | undefined;
}) => {
  const anchored = useAnchoredToggle();
  // a structured output (CodeMode's pretty-printed JSON) reads as YAML,
  // highlighted; its line count is the YAML's
  const yaml = useMemo(() => {
    const structured =
      output === undefined ? undefined : structuredOutput(output);
    return structured === undefined ? undefined : toYaml(structured);
  }, [output]);
  const panes: Array<{ id: EvalPaneId; count: number }> = [];
  if (output !== undefined) {
    panes.push({ id: "output", count: countLines(yaml ?? output) });
  }
  if (logs !== undefined) panes.push({ id: "logs", count: countLines(logs) });
  panes.push({ id: "code", count: countLines(code) });
  const [active, setActive] = useState<EvalPaneId>(panes[0]!.id);
  const shown = panes.some((pane) => pane.id === active)
    ? active
    : panes[0]!.id;
  return (
    <div>
      <div
        role="tablist"
        className="flex items-center gap-3 border-b border-border/50 px-2.5"
      >
        {panes.map((pane) => {
          const selected = pane.id === shown;
          return (
            <button
              key={pane.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-pane={pane.id}
              onClick={(event) =>
                anchored(event.currentTarget, () => setActive(pane.id))
              }
              className={cn(
                "-mb-px flex cursor-pointer items-center border-b py-1.5 text-[11px]",
                selected
                  ? "border-foreground/70 font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {pane.id}
              <span className="font-normal text-muted-foreground/70">
                {" "}
                · {pane.count} line{pane.count === 1 ? "" : "s"}
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" data-pane={shown}>
        {shown === "output" &&
          output !== undefined &&
          (yaml !== undefined ? (
            <div
              data-format="yaml"
              className="max-h-96 overflow-auto px-2 py-2 [&_.code-surface]:my-0"
            >
              <CodeCard code={yaml} language="yaml" overflow="scroll" />
            </div>
          ) : (
            <Mono wrap={false}>{output}</Mono>
          ))}
        {shown === "logs" && logs !== undefined && (
          <Mono wrap={false}>{logs}</Mono>
        )}
        {shown === "code" && (
          <div className="px-2 py-2 [&_.code-surface]:my-0">
            <CodeCard code={code} language="typescript" />
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * The remainder: driver intrinsics (`eval`, `skill`, `remind_me` —
 * their schemas live in the driver, not on any agent's wire). Unknown
 * names fall back to the generic collapsible card.
 */
const EXTRAS: Record<string, Renderer> = {
  /** CODEMODE's one tool — the model writes a whole module and titles
   *  it. ONE line by default — the title, the intent — and the open
   *  card is a row of tabs (output, logs, code), one pane at a time.
   *  A pre-title transcript row falls back to "Run code". */
  eval: (input, output, running) => {
    const code = String(input.code ?? "");
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const parsed = output === undefined ? undefined : splitEvalOutput(output);
    const nonEmpty = (text: string | undefined) =>
      text !== undefined && text.trim().length > 0 ? text.trim() : undefined;
    return {
      icon: SquareCode,
      title:
        title.length > 0 ? (
          title
        ) : (
          <>
            Run code{" "}
            <span className="text-muted-foreground">
              · {countLines(code)} line{countLines(code) === 1 ? "" : "s"}
            </span>
          </>
        ),
      body: (
        <div>
          {running && (
            <div className="border-b border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
              <span className="animate-pulse">evaluating…</span>
            </div>
          )}
          <EvalPanes
            code={code}
            logs={nonEmpty(parsed?.logs)}
            output={nonEmpty(parsed?.result)}
          />
        </div>
      ),
    };
  },

  skill: (input, output) => ({
    icon: Sparkles,
    title: (
      <>
        {input.action === "deactivate" ? "Deactivate" : "Activate"} skill{" "}
        <span className="font-medium">{String(input.skill ?? "")}</span>
      </>
    ),
    body:
      output === undefined ? undefined : (
        <WindowedText text={output} head={12} tail={0} />
      ),
  }),

  remind_me: (input) => ({
    icon: AlarmClock,
    title: (
      <>
        Reminder in{" "}
        <span className="font-mono">{String(input.delay ?? "")}</span>
      </>
    ),
    body: input.note ? <Mono>{String(input.note)}</Mono> : undefined,
  }),
};

/** The transcript's lookup table: the typed, charter-checked packs
 *  layered over the untyped remainder. */
const RENDERERS: Record<string, Renderer> = {
  ...EXTRAS,
  ...CODER,
  ...THREAD,
  ...CHANNEL,
};

/** Whether a compact per-tool card exists for this tool name. */
export const hasToolCard = (toolName: string): boolean => toolName in RENDERERS;

/* ── runs: consecutive calls of one tool, folded ─────────────── */

/** How many consecutive calls of one tool make a RUN worth folding.
 *  Two cards read fine as two cards; three or more of the same verb
 *  in a row are a list, and the list's headline is what matters. */
export const MIN_TOOL_RUN = 3;

/** One line for a run of `n` calls — the verb in the run's tense.
 *  Tools not named here fold under a generic count. */
const RUN_LABELS: Record<string, (n: number, running: boolean) => string> = {
  worktree: (n, running) =>
    `${running ? "Creating" : "Created"} ${n} worktrees`,
  assign: (n, running) => `${running ? "Assigning" : "Assigned"} ${n} refs`,
  unassign: (n, running) =>
    `${running ? "Unassigning" : "Unassigned"} ${n} refs`,
  spawn: (n, running) => `${running ? "Spawning" : "Spawned"} ${n} agents`,
  message: (n, running) => `${running ? "Sending" : "Sent"} ${n} messages`,
  read_pull: (n, running) =>
    `${running ? "Reading" : "Read"} ${n} pull requests`,
  read_issue: (n, running) => `${running ? "Reading" : "Read"} ${n} issues`,
  read_thread: (n, running) => `${running ? "Reading" : "Read"} ${n} threads`,
  read_messages: (n, running) =>
    `${running ? "Reading" : "Read"} ${n} pages of messages`,
  place_messages: (n, running) =>
    `${running ? "Placing" : "Placed"} messages ${n} times`,
  brief_thread: (n, running) =>
    `${running ? "Briefing" : "Briefed"} ${n} threads`,
  create_thread: (n, running) =>
    `${running ? "Creating" : "Created"} ${n} threads`,
  bash: (n, running) => `${running ? "Running" : "Ran"} ${n} commands`,
  grep: (n, running) => `${running ? "Searching" : "Searched"} ${n} times`,
  glob: (n, running) => `${running ? "Globbing" : "Globbed"} ${n} times`,
  readFile: (n, running) => `${running ? "Reading" : "Read"} ${n} files`,
  writeFile: (n, running) => `${running ? "Writing" : "Wrote"} ${n} files`,
  editFile: (n, running) => `${running ? "Editing" : "Edited"} ${n} files`,
  listDirectory: (n, running) =>
    `${running ? "Listing" : "Listed"} ${n} directories`,
  pushBranch: (n, running) => `${running ? "Pushing" : "Pushed"} ${n} branches`,
  openPullRequest: (n, running) =>
    `${running ? "Opening" : "Opened"} ${n} pull requests`,
  eval: (n, running) => `${running ? "Evaluating" : "Evaluated"} ${n} programs`,
};

const runLabel = (toolName: string, n: number, running: boolean): string =>
  RUN_LABELS[toolName]?.(n, running) ?? `${n} × ${toolName}`;

/** Whether a run of `toolName` calls can fold: the tool has a card
 *  (the fold's rows are those cards) — the generic collapsible has
 *  no headline to fold under. */
export const canFoldToolRun = (toolName: string): boolean =>
  hasToolCard(toolName);

export interface ToolRunProps {
  readonly toolName: string;
  /** The calls, in transcript order — three or more. */
  readonly calls: ReadonlyArray<ToolCardProps>;
}

/**
 * A RUN of one tool — `worktree` five times in a row — folded into one
 * line ("Created 5 worktrees") that opens into the calls' own cards.
 * The headline carries the run's state: how many are still running,
 * how many failed. A run with a failure opens by default, as a single
 * failed card does — the failure is the story.
 */
export const ToolRun = ({ toolName, calls }: ToolRunProps) => {
  const agents = useContext(SubagentsContext);
  const anchored = useAnchoredToggle();
  const renderer = RENDERERS[toolName];
  const inFlight = calls.filter(
    (call) =>
      call.state === "input-available" || call.state === "input-streaming",
  ).length;
  const failed = calls.filter((call) => call.state === "output-error").length;
  const [open, setOpen] = useState(failed > 0);

  if (renderer === undefined) return null;
  const first = calls[0]!;
  const Icon = renderer(
    (first.input ?? {}) as Record<string, any>,
    undefined,
    false,
    { agents },
  ).icon;
  const running = inFlight > 0;

  return (
    <div
      data-tool-run={toolName}
      data-count={calls.length}
      className={cn(
        "callout overflow-hidden text-sm",
        failed > 0 ? "callout-danger" : running && "border-primary/40",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => anchored(event.currentTarget, () => setOpen(!open))}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50"
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            failed > 0
              ? "text-brick"
              : running
                ? "animate-pulse text-primary"
                : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1 truncate">
          {runLabel(toolName, calls.length, running)}
        </span>
        {running && (
          <span className="shrink-0 animate-pulse text-[11px] text-primary">
            {inFlight} running…
          </span>
        )}
        {failed > 0 && (
          <span className="shrink-0 text-[11px] text-brick">
            {failed} failed
          </span>
        )}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-border/50 bg-muted/20 p-1.5">
          {calls.map((call, index) => (
            <ToolCard key={index} {...call} />
          ))}
        </div>
      )}
    </div>
  );
};

/* ── the card ────────────────────────────────────────────────── */

export interface ToolCardProps {
  readonly toolName: string;
  readonly state: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly errorText: string | undefined;
}

/**
 * One tool call in the transcript: glyph + one-line summary + status,
 * expandable to per-tool detail. Returns null for unknown tools so the
 * caller can fall back to its generic card.
 */
export const ToolCard = ({
  toolName,
  state,
  input,
  output,
  errorText,
}: ToolCardProps) => {
  const renderer = RENDERERS[toolName];
  const agents = useContext(SubagentsContext);
  const open_ = state === "input-available" || state === "input-streaming";
  const failed = state === "output-error";
  const view = renderer?.(
    (input ?? {}) as Record<string, any>,
    failed ? undefined : outputText(output),
    open_,
    { agents },
  );
  // errors default open — the failure is the story; some cards open
  // by design (eval — the program IS the story)
  const [open, setOpen] = useState(failed || view?.defaultOpen === true);
  const anchored = useAnchoredToggle();

  if (renderer === undefined || view === undefined) return null;

  // an open call the card knows to be over (the thread state says the agent
  // stopped) is not running — no pulse, its verdict where "running…" was
  const running = open_ && view.settled === undefined;

  const expandable = view.body !== undefined || failed;

  return (
    <div
      data-tool={toolName}
      className={cn(
        "callout overflow-hidden text-sm",
        failed ? "callout-danger" : running && "border-primary/40",
      )}
    >
      <button
        type="button"
        disabled={!expandable}
        onClick={(event) => anchored(event.currentTarget, () => setOpen(!open))}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
          expandable && "cursor-pointer hover:bg-accent/50",
        )}
      >
        <view.icon
          className={cn(
            "size-3.5 shrink-0",
            failed
              ? "text-brick"
              : running
                ? "animate-pulse text-primary"
                : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{view.title}</span>
        {running && (
          <span className="shrink-0 animate-pulse text-[11px] text-primary">
            running…
          </span>
        )}
        {open_ && view.settled !== undefined && (
          <span
            data-settled={view.settled}
            className="shrink-0 text-[11px] text-muted-foreground"
          >
            {view.settled}
          </span>
        )}
        {view.badge}
        {expandable && (
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
        )}
      </button>
      {!open && !running && !failed && view.summary !== undefined && (
        <div className="flex items-start gap-2 px-2.5 pb-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="shrink-0">→</span>
          <span className="min-w-0 truncate">{clamp(view.summary, 140)}</span>
        </div>
      )}
      {/* a failure that arrived AFTER mount (a call cut short by the
          operator's stop) stays collapsed — its first line is still
          the story, so it shows where the summary would */}
      {!open && failed && errorText !== undefined && (
        <div className="flex items-start gap-2 px-2.5 pb-1.5 font-mono text-[11px] text-brick/80">
          <span className="shrink-0">→</span>
          <span className="min-w-0 truncate">
            {clamp(firstLine(errorText), 140)}
          </span>
        </div>
      )}
      {open && failed && errorText !== undefined && (
        <div className="border-t border-inherit px-2.5 py-1.5">
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-brick">
            <Ansi text={errorText} />
          </pre>
        </div>
      )}
      {open && !failed && view.body !== undefined && (
        <div className="border-t border-border/50 bg-muted/20">{view.body}</div>
      )}
    </div>
  );
};

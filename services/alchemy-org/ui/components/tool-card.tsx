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
  StickyNote,
  Tag,
  Terminal,
  Upload,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type * as AI from "alchemy/AI";
import { useState, type ReactNode } from "react";
import type { GeneralEngineer } from "../../src/coding/Engineer.ts";
import { useAnchoredToggle } from "@/lib/anchor";
import { Ansi, stripAnsi } from "@/lib/ansi";
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
const parseRecord = (raw: string | undefined): Record<string, any> | undefined => {
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

/** Plain monospace block; string children render their ANSI colors. */
const Mono = ({ children }: { children: ReactNode }) => (
  <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] leading-4">
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
  /** Collapsed result line (`→ …`) — the outcome without expanding. */
  readonly summary?: string;
}

/** The last non-empty line — where a command's verdict usually is.
 *  Plain text: the summary row is truncated by character count. */
const lastLine = (text: string): string | undefined => {
  const lines = stripAnsi(text)
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
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
type Renderer = (
  input: any,
  output: string | undefined,
  running: boolean,
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

/**
 * Cards for the THREAD agent's wire (`src/thread/ThreadAgent.ts`).
 * All of its tools are inline `AI.Tool`s — runtime-only, no tag on
 * any requirement channel — so their names and input shapes are
 * declared by hand here and must be kept in step with the charter.
 */
const THREAD: {
  attach: (
    input: { ref: string; kind: string; title: string },
    output: string | undefined,
  ) => ToolCallView;
  detach: (
    input: { ref: string },
    output: string | undefined,
  ) => ToolCallView;
  worktree: (
    input: { ref: string },
    output: string | undefined,
  ) => ToolCallView;
  spawn: (
    input: { brief: string },
    output: string | undefined,
    running: boolean,
  ) => ToolCallView;
  post_card: (input: { title: string; text: string }) => ToolCallView;
  /** Shared with the channel agent's bookkeeping close — the thread
   *  agent's call carries `why`, the channel's carries `thread`. */
  close_thread: (
    input: { why?: string; thread?: string },
    output: string | undefined,
  ) => ToolCallView;
} = {
  attach: (input, output) => ({
    icon: Paperclip,
    title: (
      <>
        Attach <Ref value={input.ref} />
        {input.title && (
          <>
            <span className="text-muted-foreground"> · </span>
            {clamp(input.title, 100)}
          </>
        )}
      </>
    ),
    summary: output === undefined ? undefined : lastLine(output),
  }),

  detach: (input, output) => ({
    icon: CircleSlash,
    title: (
      <>
        Detach <Ref value={input.ref} />
      </>
    ),
    summary: output === undefined ? undefined : lastLine(output),
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
        record === undefined
          ? undefined
          : `${record.path} (${record.branch})`,
    };
  },

  spawn: (input, output, running) => {
    const report = parseRecord(output)?.report as string | undefined;
    return {
      icon: Hammer,
      title: (
        <>
          Engineer <span className="text-muted-foreground">·</span>{" "}
          {clamp(firstLine(input.brief ?? ""), 110)}
        </>
      ),
      badge: running ? (
        <span className="shrink-0 animate-pulse text-[11px] text-moss">
          working
        </span>
      ) : undefined,
      body: (
        <div className="divide-y divide-border/50">
          {countLines(input.brief ?? "") > 1 && <Prose>{input.brief}</Prose>}
          {report !== undefined && <WindowedText text={report} />}
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
    summary: output === undefined ? undefined : lastLine(output),
    body: input.why === undefined ? undefined : <Why why={input.why} />,
  }),
};

/**
 * Cards for the CHANNEL agent's wire (`src/channel/ChannelAgent.ts`)
 * — inline tools, hand declared like the thread's. Its runs mostly
 * read (search_messages, read_history, read_thread) and route
 * (create_thread, place_messages, attach_entity); every card is one
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
  attach_entity: (
    input: { thread: string; ref: string; kind: string; title: string },
    output: string | undefined,
  ) => ToolCallView;
  detach_entity: (
    input: { thread: string; ref: string },
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

  read_thread: (input, output) => ({
    icon: Waypoints,
    title: (
      <>
        Show <ThreadId id={input.thread} />
      </>
    ),
    body:
      output === undefined ? undefined : (
        <WindowedText text={output} head={20} tail={5} />
      ),
  }),

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
    summary: output === undefined ? undefined : lastLine(output),
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
    summary: output === undefined ? undefined : lastLine(output),
  }),

  attach_entity: (input, output) => ({
    icon: Paperclip,
    title: (
      <>
        Attach <Ref value={input.ref} />{" "}
        <span className="text-muted-foreground">→</span>{" "}
        <ThreadId id={input.thread} />
      </>
    ),
    summary: output === undefined ? undefined : lastLine(output),
  }),

  detach_entity: (input, output) => ({
    icon: CircleSlash,
    title: (
      <>
        Detach <Ref value={input.ref} />{" "}
        <span className="text-muted-foreground">from</span>{" "}
        <ThreadId id={input.thread} />
      </>
    ),
    summary: output === undefined ? undefined : lastLine(output),
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
    summary: output === undefined ? undefined : lastLine(output),
    body:
      countLines(input.text ?? "") > 1 ? <Prose>{input.text}</Prose> : undefined,
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
      countLines(input.text ?? "") > 1 ? <Prose>{input.text}</Prose> : undefined,
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

/**
 * The remainder: driver intrinsics (`skill`, `remind_me` — their
 * schemas live in the driver, not on any agent's wire). Unknown names
 * fall back to the generic collapsible card.
 */
const EXTRAS: Record<string, Renderer> = {
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
  const running = state === "input-available" || state === "input-streaming";
  const failed = state === "output-error";
  // errors default open — the failure is the story
  const [open, setOpen] = useState(failed);
  const anchored = useAnchoredToggle();

  if (renderer === undefined) return null;

  const view = renderer(
    (input ?? {}) as Record<string, any>,
    failed ? undefined : outputText(output),
    running,
  );
  const expandable = view.body !== undefined || failed;

  return (
    <div
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

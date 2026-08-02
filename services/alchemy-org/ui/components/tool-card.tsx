/**
 * Per-tool transcript cards — a REGISTRY keyed by tool name (the
 * OpenCode pattern), each renderer producing a one-line verb summary
 * (the pi/Codex pattern: `$ cmd`, `Read path`, `Edit path +3 −1`)
 * with expandable per-tool detail. Unknown tools fall back to the
 * generic collapsible card.
 */
import {
  AlarmClock,
  CircleCheck,
  CirclePlus,
  CircleX,
  FileDiff,
  FilePen,
  FilePlus2,
  FileText,
  FolderSearch,
  FolderTree,
  GitMerge,
  GitPullRequestArrow,
  Link2,
  MessageSquare,
  Reply,
  ScrollText,
  Search,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { RefHoverCard } from "@/components/ref-hover-card";
import { useAnchoredToggle } from "@/lib/anchor";
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

/** bash output: "exit: N\n--- stdout ---\n…\n--- stderr ---\n…" */
const parseBashOutput = (
  raw: string,
): { exit: number | undefined; stdout: string; stderr: string } => {
  const exit = raw.match(/^exit: (-?\d+)/);
  const stdout =
    raw.split("--- stdout ---\n")[1]?.split("\n--- stderr ---")[0] ?? "";
  const stderr = raw.split("--- stderr ---\n")[1] ?? "";
  return {
    exit: exit ? Number(exit[1]) : undefined,
    stdout: stdout.trim() === "(no output)" ? "" : stdout,
    stderr: stderr.trim() === "(no output)" ? "" : stderr,
  };
};

/** Strip the "[SHA-256: …]" provenance footer off file-tool outputs. */
const stripDigest = (text: string): string =>
  text.replace(/\n?\[SHA-256: [0-9a-f]+\]\s*$/, "");

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

const DiffStatBadge = ({ added, removed }: { added: number; removed: number }) =>
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

const Mono = ({ children }: { children: ReactNode }) => (
  <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] leading-4">
    {children}
  </pre>
);

/** Head+tail window (the Codex convention) for long plain output. */
const WindowedText = ({ text, head = 8, tail = 12 }: {
  text: string;
  head?: number;
  tail?: number;
}) => {
  const lines = text.split("\n");
  if (lines.length <= head + tail + 1) return <Mono>{text}</Mono>;
  const omitted = lines.length - head - tail;
  return (
    <Mono>
      {lines.slice(0, head).join("\n")}
      {"\n"}
      <span className="text-muted-foreground">… +{omitted} lines</span>
      {"\n"}
      {lines.slice(-tail).join("\n")}
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

/** The last non-empty line — where a command's verdict usually is. */
const lastLine = (text: string): string | undefined => {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
};

type Renderer = (
  input: Record<string, any>,
  output: string | undefined,
  running: boolean,
) => ToolCallView;

/** `#N` as a link into GitHub — issues and PRs share the /issues/N
 *  door (GitHub redirects PR numbers), and PullRequestRefs carry an
 *  explicit `url`. */
const RefLink = ({ refValue }: { refValue: any }) => {
  if (
    !refValue ||
    typeof refValue !== "object" ||
    typeof refValue.number !== "number"
  ) {
    return null;
  }
  const href =
    typeof refValue.url === "string" && refValue.url.startsWith("http")
      ? refValue.url
      : typeof refValue.owner === "string" &&
          typeof refValue.repository === "string"
        ? `https://github.com/${refValue.owner}/${refValue.repository}/issues/${refValue.number}`
        : undefined;
  if (href === undefined) return <>#{refValue.number}</>;
  const repo =
    typeof refValue.owner === "string" && typeof refValue.repository === "string"
      ? `${refValue.owner}/${refValue.repository}`
      : href.match(/github\.com\/([\w.-]+\/[\w.-]+)\//)?.[1];
  const anchor = (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
    >
      #{refValue.number}
    </a>
  );
  return repo ? (
    <RefHoverCard repo={repo} number={refValue.number}>
      {anchor}
    </RefHoverCard>
  ) : (
    anchor
  );
};

const outputText = (output: unknown): string | undefined =>
  output === undefined
    ? undefined
    : typeof output === "string"
      ? output
      : JSON.stringify(output, null, 2);

const RENDERERS: Record<string, Renderer> = {
  bash: (input, output, running) => {
    const parsed = output === undefined ? undefined : parseBashOutput(output);
    return {
      icon: Terminal,
      title: (
        <span className="font-mono">{clamp(firstLine(String(input.command ?? "")), 100)}</span>
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
                <div className="px-2 pt-1 font-mono text-[10px] uppercase text-muted-foreground">
                  stderr
                </div>
                <WindowedText text={parsed.stderr} />
              </div>
            )}
          </div>
        ),
    };
  },

  readFile: (input, output) => ({
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
      output === undefined ? undefined : (
        <WindowedText text={stripDigest(output)} head={20} tail={5} />
      ),
  }),

  writeFile: (input, output) => ({
    icon: FilePlus2,
    title: (
      <>
        Write <span className="font-mono text-mist">{input.path}</span>
      </>
    ),
    badge: (
      <DiffStatBadge added={countLines(String(input.content ?? ""))} removed={0} />
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
    const edits: Array<{ oldString: string; newString: string }> = Array.isArray(
      input.edits,
    )
      ? input.edits
      : [];
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
            <span className="text-muted-foreground"> ({edits.length} edits)</span>
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

  applyPatch: (input) => {
    const patch = String(input.patchText ?? "");
    const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
      .map((m) => m[1]);
    const { added, removed } = diffStat(patch);
    return {
      icon: FileDiff,
      title: (
        <>
          Patch{" "}
          <span className="font-mono text-mist">
            {files.length === 1 ? files[0] : `${files.length} files`}
          </span>
        </>
      ),
      badge: <DiffStatBadge added={added} removed={removed} />,
      body: <DiffText text={patch} />,
    };
  },

  grep: (input, output) => ({
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
      output === undefined ? undefined : (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {/no matches/i.test(output) ? "0" : countLines(output)}
        </span>
      ),
    summary: output === undefined ? undefined : firstLine(output),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  glob: (input, output) => ({
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
      output === undefined ? undefined : (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {/no files/i.test(output) ? "0" : countLines(output)}
        </span>
      ),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  listDirectory: (input, output) => ({
    icon: FolderTree,
    title: (
      <>
        ls <span className="font-mono text-mist">{input.path || "."}</span>
      </>
    ),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  readOutput: (input, output) => ({
    icon: ScrollText,
    title: (
      <>
        Read output{" "}
        <span className="font-mono text-muted-foreground">{input.outputId}</span>
      </>
    ),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  readDiff: (input, output) => {
    const stat = output === undefined ? undefined : diffStat(output);
    return {
      icon: FileDiff,
      title: <>Read diff of PR <RefLink refValue={input.pr} /></>,
      badge: stat && <DiffStatBadge added={stat.added} removed={stat.removed} />,
      body: output === undefined ? undefined : <DiffText text={output} />,
    };
  },

  /* ── GitHub verbs ──────────────────────────────────────────── */

  openPullRequest: (input, output) => {
    let pr: { number?: number; url?: string } | undefined;
    try {
      const parsed =
        typeof output === "string" ? JSON.parse(output) : (output as any);
      pr = parsed?.pr;
    } catch {
      // output not JSON — fall through to plain rendering
    }
    return {
      icon: GitPullRequestArrow,
      title: (
        <>
          Open PR{pr?.number !== undefined ? ` #${pr.number}` : ""}:{" "}
          <span className="font-medium">{clamp(String(input.title ?? ""), 80)}</span>
        </>
      ),
      badge: pr?.url ? (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-[11px] text-muted-foreground underline hover:text-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          open ↗
        </a>
      ) : undefined,
      body: input.body ? (
        <Mono>{clamp(String(input.body), 2000)}</Mono>
      ) : undefined,
    };
  },

  mergePullRequest: (input) => ({
    icon: GitMerge,
    title: <>Merge PR <RefLink refValue={input.pr} /></>,
  }),

  approve: (input, output) => ({
    icon: CircleCheck,
    title: <>Approve PR <RefLink refValue={input.pr} /></>,
    body: outputText(output) && <Mono>{outputText(output)}</Mono>,
  }),

  closeIssue: (input) => ({
    icon: CircleX,
    title: <>Close issue <RefLink refValue={input.issue} /></>,
    body: input.reason ? <Mono>{String(input.reason)}</Mono> : undefined,
  }),

  openIssue: (input) => ({
    icon: CirclePlus,
    title: (
      <>
        Open issue: <span className="font-medium">{clamp(String(input.title ?? ""), 80)}</span>
      </>
    ),
    body: input.body ? <Mono>{clamp(String(input.body), 2000)}</Mono> : undefined,
  }),

  readIssue: (input, output) => ({
    icon: FileText,
    title: <>Read issue <RefLink refValue={input.issue} /></>,
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  searchIssues: (input, output) => ({
    icon: Search,
    title: (
      <>
        Search issues{" "}
        <span className="font-mono text-honey">
          {clamp(String(input.pattern ?? ""), 60)}
        </span>
      </>
    ),
    body: output === undefined ? undefined : <WindowedText text={output} />,
  }),

  comment: (input) => ({
    icon: MessageSquare,
    title: <>Comment on <RefLink refValue={input.issue} /></>,
    body: input.message ? <Mono>{String(input.message)}</Mono> : undefined,
  }),

  linkIssues: (input) => ({
    icon: Link2,
    title: (
      <>
        Link <RefLink refValue={input.issue} /> → <RefLink refValue={input.related} />
      </>
    ),
    body: input.reason ? <Mono>{String(input.reason)}</Mono> : undefined,
  }),

  reply: (input) => ({
    icon: Reply,
    title: <>Reply</>,
    body: input.message ? <Mono>{String(input.message)}</Mono> : undefined,
  }),

  /* ── intrinsics ────────────────────────────────────────────── */

  skill: (input, output) => ({
    icon: Sparkles,
    title: (
      <>
        {input.action === "deactivate" ? "Deactivate" : "Activate"} skill{" "}
        <span className="font-medium">{String(input.skill ?? "")}</span>
      </>
    ),
    body: output === undefined ? undefined : <WindowedText text={output} head={12} tail={0} />,
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

/** Whether a compact per-tool card exists for this tool name. */
export const hasToolCard = (toolName: string): boolean =>
  toolName in RENDERERS;

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
        "overflow-hidden rounded-md border text-sm",
        failed
          ? "border-brick/40"
          : running
            ? "border-honey/40"
            : "border-border/60",
      )}
    >
      <button
        type="button"
        disabled={!expandable}
        onClick={(event) =>
          anchored(event.currentTarget, () => setOpen(!open))
        }
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
                ? "animate-pulse text-honey"
                : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{view.title}</span>
        {running && (
          <span className="shrink-0 animate-pulse text-[11px] text-honey">
            running…
          </span>
        )}
        {view.badge}
        {expandable && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {open ? "▾" : "▸"}
          </span>
        )}
      </button>
      {!open && !running && !failed && view.summary !== undefined && (
        <div className="flex items-start gap-2 px-2.5 pb-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="shrink-0">→</span>
          <span className="min-w-0 truncate">{clamp(view.summary, 140)}</span>
        </div>
      )}
      {open && failed && errorText !== undefined && (
        <div className="border-t border-brick/40 bg-brick/10 px-2.5 py-1.5">
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-brick">
            {errorText}
          </pre>
        </div>
      )}
      {open && !failed && view.body !== undefined && (
        <div className="border-t border-border/50 bg-muted/20">{view.body}</div>
      )}
    </div>
  );
};

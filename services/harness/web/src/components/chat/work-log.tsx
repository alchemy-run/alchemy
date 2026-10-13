/**
 * An assistant turn, laid out like t3code's timeline: the work (thinking,
 * tool calls) as compact one-line rows that expand on click, consecutive
 * tool calls grouped under a summary, and a settled turn folded behind
 * "Worked for 1m 12s" so its answer reads first.
 */
import type * as AI from "alchemy/AI/Client";
import {
  BotIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { MessageResponse } from "../ai-elements/message.tsx";
import { Shimmer } from "../ai-elements/shimmer.tsx";

type Part = AI.TranscriptPart;
type ToolPart = Extract<Part, { type: "tool" }>;
type ReasoningPart = Extract<Part, { type: "reasoning" }>;

//#region formatting

/** `850ms`, `4.2s`, `12s`, `1m 12s`, `1h 2m` — zero parts omitted. */
export const formatDuration = (ms: number): string => {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) {
    const tenths = Math.round(ms / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const total = Math.round(ms / 1_000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(" ");
};

/** Re-render every second while `active` (live timers). */
export const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

/** A live timer: whole seconds, then `1m 12s`. */
const liveDuration = (ms: number) =>
  ms < 60_000 ? `${Math.floor(ms / 1000)}s` : formatDuration(ms);

/** A path inside the session's checkout, relative to its root. */
const relPath = (path: string | undefined) => {
  if (!path) return undefined;
  // The last `…/worktrees/<session>/<repo>/` (local) or `/workspace/<repo>/`.
  const match = /^.*\/(?:worktrees\/[^/]+\/[^/]+|workspace\/[^/]+)\/(.*)$/.exec(path);
  return match?.[1] ?? path;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const lines = (text: string | undefined) => (text ? text.split("\n").length : 0);

//#endregion

//#region tool presentation

type Category = "command" | "edit" | "read" | "search" | "web" | "agent" | "other";

interface Presentation {
  readonly category: Category;
  readonly icon: LucideIcon;
  /** Settled label. */
  readonly label: ReactNode;
  /** While running. */
  readonly live: string;
  /** `+added -removed` for edits. */
  readonly stat?: { readonly added: number; readonly removed: number };
}

const input = (tool: AI.ToolCall) => (tool.input ?? {}) as Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const program = (command: string) => command.trim().split(/\s+/)[0] ?? "command";

/** What a tool call is, by its harness-native name and input. */
const present = (tool: AI.ToolCall): Presentation => {
  const args = input(tool);
  const name = tool.name ?? "";
  const path = relPath(str(args.file_path) ?? str(args.notebook_path) ?? str(args.path));
  if (tool.kind === "shell" || name === "Bash") {
    const command = str(args.command) ?? tool.title;
    return {
      category: "command",
      icon: TerminalIcon,
      label: <code className="font-mono text-[13px]">{command}</code>,
      live: `Running ${program(command)}`,
    };
  }
  if (tool.kind === "edit") {
    const edits =
      name === "MultiEdit"
        ? ((args.edits as Array<{ old_string?: string; new_string?: string }>) ?? [])
        : [{ old_string: str(args.old_string), new_string: str(args.new_string ?? args.content) }];
    const stat = {
      added: edits.reduce((n, e) => n + lines(e.new_string), 0),
      removed: edits.reduce((n, e) => n + lines(e.old_string), 0),
    };
    return {
      category: "edit",
      icon: SquarePenIcon,
      label: (
        <>
          {name === "Write" ? "Wrote" : "Edited"} <span className="font-mono">{path}</span>
        </>
      ),
      live: `Editing ${path ?? "file"}`,
      stat,
    };
  }
  if (tool.kind === "read") {
    return {
      category: "read",
      icon: EyeIcon,
      label: (
        <>
          Read <span className="font-mono">{path ?? "file"}</span>
        </>
      ),
      live: `Reading ${path ?? "file"}`,
    };
  }
  if (tool.kind === "search") {
    const pattern = str(args.pattern);
    const glob = str(args.glob);
    const files = name === "Glob";
    return {
      category: "search",
      icon: SearchIcon,
      label: (
        <>
          Searched{files ? " files" : ""} <span className="font-mono">{pattern}</span>
          {glob && (
            <>
              {" "}
              in <span className="font-mono">{glob}</span>
            </>
          )}
          {path && (
            <>
              {" "}
              in <span className="font-mono">{path}</span>
            </>
          )}
        </>
      ),
      live: `Searching ${pattern ?? ""}`.trim(),
    };
  }
  if (tool.kind === "fetch") {
    const query = str(args.query);
    const url = str(args.url);
    return {
      category: "web",
      icon: GlobeIcon,
      label: query ? `Searched the web for "${query}"` : `Fetched ${url ?? tool.title}`,
      live: query ? "Searching the web" : `Fetching ${url ?? ""}`.trim(),
    };
  }
  if (tool.kind === "mcp" || name.startsWith("mcp__")) {
    const [, server, method] = name.split("__");
    return {
      category: "other",
      icon: HammerIcon,
      label: (
        <>
          {server} <span className="text-muted-foreground">·</span> {method ?? tool.title}
        </>
      ),
      live: `Using ${server ?? "tool"}`,
    };
  }
  if (tool.kind === "think") {
    return { category: "other", icon: BrainIcon, label: tool.title, live: tool.title };
  }
  return { category: "other", icon: WrenchIcon, label: tool.title, live: tool.title };
};

const CATEGORY_LABEL: Record<Category, (n: number) => string> = {
  command: (n) => `Ran ${plural(n, "command")}`,
  edit: (n) => `Changed ${plural(n, "file")}`,
  read: (n) => `Read ${plural(n, "file")}`,
  search: (n) => `Searched code ${plural(n, "time")}`,
  web: (n) => `Searched the web ${plural(n, "time")}`,
  agent: (n) => `Ran ${plural(n, "subagent")}`,
  other: (n) => `Used ${plural(n, "tool")}`,
};
const PRIORITY: ReadonlyArray<Category> = [
  "command",
  "edit",
  "read",
  "search",
  "web",
  "agent",
  "other",
];
const CATEGORY_ICON: Record<Category, LucideIcon> = {
  command: TerminalIcon,
  edit: SquarePenIcon,
  read: EyeIcon,
  search: SearchIcon,
  web: GlobeIcon,
  agent: BotIcon,
  other: WrenchIcon,
};

/** `Ran 3 commands and read 2 files` — the two leading categories, the rest counted. */
const summarize = (tools: ReadonlyArray<ToolPart>) => {
  const counts = new Map<Category, number>();
  const files = new Set<string>();
  for (const part of tools) {
    const { category } = present(part.tool);
    if (category === "edit") {
      const path = str(input(part.tool).file_path) ?? part.id;
      if (files.has(path)) continue;
      files.add(path);
    }
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const ordered = PRIORITY.filter((c) => counts.has(c));
  const shown = ordered.slice(0, 2).map((c) => CATEGORY_LABEL[c](counts.get(c)!));
  const rest = ordered.slice(2).reduce((n, c) => n + counts.get(c)!, 0);
  if (rest > 0) shown.push(`performed ${plural(rest, "other action")}`);
  const text = shown
    .map((s, i) => (i === 0 ? s : s[0]!.toLowerCase() + s.slice(1)))
    .join(shown.length > 2 ? ", " : " and ");
  return { text, icon: CATEGORY_ICON[ordered[0] ?? "other"] };
};

//#endregion

//#region rows

/** One line of the work log: icon, label, trailing chevron; expands on click. */
function Row(props: {
  icon: LucideIcon;
  label: ReactNode;
  trailing?: ReactNode;
  live?: boolean;
  error?: boolean;
  children?: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const expandable = props.children !== undefined && props.children !== null;
  const Icon = props.error ? CircleAlertIcon : props.icon;
  return (
    <div className="group/row w-full min-w-0" data-testid={props.testId}>
      {/* biome-ignore lint/a11y/useSemanticElements: a row, not a form button */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (expandable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={cn(
          "flex min-h-6 min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-sm leading-relaxed select-none",
          expandable && "cursor-pointer hover:bg-muted/40",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          <Icon
            className={cn(
              "size-4 shrink-0 stroke-2 opacity-70",
              props.error ? "text-destructive" : "text-muted-foreground",
            )}
          />
        </span>
        <div
          className={cn(
            "min-w-0 flex-1 truncate text-muted-foreground [&_*]:whitespace-nowrap",
            props.live && "live-tool-shine",
          )}
        >
          {props.label}
        </div>
        {props.trailing}
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground opacity-70 transition-transform duration-200",
            open && "rotate-90",
            !expandable && "invisible",
          )}
        />
      </div>
      {expandable && open && <div className="mt-0.5 mb-1.5 ms-7 min-w-0">{props.children}</div>}
    </div>
  );
}

const Pre = (props: { children: ReactNode; className?: string }) => (
  <pre
    className={cn(
      "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-3 py-2 font-mono text-muted-foreground text-xs leading-relaxed select-text",
      props.className,
    )}
  >
    {props.children}
  </pre>
);

const toolText = (part: ToolPart) =>
  part.content
    .map((c) => (c.type === "text" ? c.text : c.type === "terminal" ? c.output : ""))
    .join("\n")
    .trim() || part.output.trim();

/** An edit as removed/added lines. */
function Diff({ tool }: { tool: AI.ToolCall }) {
  const args = input(tool);
  const edits =
    tool.name === "MultiEdit"
      ? ((args.edits as Array<{ old_string?: string; new_string?: string }>) ?? [])
      : [{ old_string: str(args.old_string), new_string: str(args.new_string ?? args.content) }];
  return (
    <div className="max-h-80 overflow-auto rounded-md border font-mono text-xs leading-relaxed">
      {edits.map((edit, i) => (
        <div key={i} className={cn(i > 0 && "border-t")}>
          {edit.old_string?.split("\n").map((line, j) => (
            <div
              key={`-${j}`}
              className="whitespace-pre-wrap bg-destructive/10 px-3 text-destructive"
            >
              - {line}
            </div>
          ))}
          {edit.new_string?.split("\n").map((line, j) => (
            <div key={`+${j}`} className="whitespace-pre-wrap bg-success/10 px-3 text-success">
              + {line}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ToolRow({ part }: { part: ToolPart }) {
  const p = present(part.tool);
  const running = part.state === "running";
  const error = part.state === "error";
  const text = toolText(part);
  const duration =
    part.completedAt !== undefined ? formatDuration(part.completedAt - part.startedAt) : undefined;
  const body =
    p.category === "edit" ? (
      <div className="flex flex-col gap-1.5">
        <Diff tool={part.tool} />
        {error && text && <Pre className="text-destructive">{text}</Pre>}
      </div>
    ) : p.category === "command" ? (
      <div className="flex flex-col gap-1.5">
        <Pre className="text-foreground/85">
          $ {str(input(part.tool).command) ?? part.tool.title}
        </Pre>
        {text && <Pre className={cn(error && "text-destructive")}>{text}</Pre>}
      </div>
    ) : text ? (
      <Pre className={cn(error && "text-destructive")}>{text}</Pre>
    ) : undefined;
  return (
    <Row
      icon={p.icon}
      testId={`tool-${p.category}`}
      live={running}
      error={error}
      label={running ? p.live : p.label}
      trailing={
        <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
          {p.stat && !running && (
            <>
              <span className="text-success">+{p.stat.added}</span>
              <span className="text-destructive">-{p.stat.removed}</span>
            </>
          )}
          {duration && (
            <span className="text-muted-foreground opacity-0 group-hover/row:opacity-100">
              {duration}
            </span>
          )}
        </span>
      }
    >
      {body}
    </Row>
  );
}

/** A one-line preview of a thought. */
const preview = (text: string) =>
  text
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function ReasoningRow({ part }: { part: ReasoningPart }) {
  if (part.streaming) {
    return (
      <Row icon={BrainIcon} testId="thinking" label={<Shimmer as="span">Thinking…</Shimmer>}>
        {part.text ? <ReasoningBody text={part.text} /> : undefined}
      </Row>
    );
  }
  const took =
    part.completedAt !== undefined ? formatDuration(part.completedAt - part.startedAt) : undefined;
  return (
    <Row
      icon={BrainIcon}
      testId="thought"
      label={
        <>
          <span className="text-foreground/80">Thought{took ? ` for ${took}` : ""}</span>
          {part.text && <span className="ms-2">{preview(part.text)}</span>}
        </>
      }
    >
      {part.text ? <ReasoningBody text={part.text} /> : undefined}
    </Row>
  );
}

const ReasoningBody = ({ text }: { text: string }) => (
  <div className="max-h-96 overflow-auto px-0.5 py-1 text-muted-foreground text-sm select-text">
    <MessageResponse>{text}</MessageResponse>
  </div>
);

/** Consecutive tool calls: one row each when alone, else a summary that expands. */
function ToolGroup({ parts }: { parts: ReadonlyArray<ToolPart> }) {
  if (parts.length === 1) return <ToolRow part={parts[0]!} />;
  const running = parts.find((p) => p.state === "running");
  const failed = parts.some((p) => p.state === "error");
  const summary = summarize(parts);
  return (
    <Row
      icon={running ? present(running.tool).icon : summary.icon}
      testId="tool-group"
      live={running !== undefined}
      error={failed && !running}
      label={running ? present(running.tool).live : summary.text}
    >
      <div className="flex max-h-[min(24rem,50dvh)] flex-col overflow-auto">
        {parts.map((part) => (
          <ToolRow key={part.id} part={part} />
        ))}
      </div>
    </Row>
  );
}

//#endregion

//#region turn

/** Parts in order, consecutive tool calls grouped. */
type Block =
  | { readonly kind: "tools"; readonly id: string; readonly parts: ReadonlyArray<ToolPart> }
  | { readonly kind: "part"; readonly id: string; readonly part: Part };

const toBlocks = (parts: ReadonlyArray<Part>): ReadonlyArray<Block> => {
  const blocks: Array<Block> = [];
  for (const part of parts) {
    const last = blocks.at(-1);
    if (part.type === "tool" && last?.kind === "tools") {
      blocks[blocks.length - 1] = { ...last, parts: [...last.parts, part] };
    } else if (part.type === "tool") {
      blocks.push({ kind: "tools", id: part.id, parts: [part] });
    } else {
      blocks.push({ kind: "part", id: part.id, part });
    }
  }
  return blocks;
};

/**
 * An assistant turn. `renderPart` renders what the work log doesn't
 * (answer text, plans, approvals, notices).
 */
export function AssistantTurn(props: {
  message: AI.TranscriptMessage;
  renderPart: (part: Part) => ReactNode;
}) {
  const { message } = props;
  const live = message.status === "streaming";
  const now = useNow(live);
  const [unfolded, setUnfolded] = useState(false);

  const blocks = toBlocks(message.parts);
  const isWork = (b: Block) =>
    b.kind === "tools" || b.part.type === "reasoning" || b.part.type === "subagent";
  // A settled turn folds its work (everything before the answer) behind
  // "Worked for …" — failures and approvals stay out of the fold.
  const lastWork = blocks.findLastIndex(isWork);
  const folded = !live && !unfolded && lastWork >= 0;
  const hidden = (b: Block, i: number) =>
    folded &&
    i <= lastWork &&
    (isWork(b) || (b.kind === "part" && b.part.type === "text")) &&
    !(b.kind === "tools" && b.parts.some((p) => p.state === "error"));

  const elapsed =
    message.startedAt !== undefined ? (message.completedAt ?? now) - message.startedAt : undefined;
  const label = live
    ? `Working for ${elapsed !== undefined ? liveDuration(elapsed) : "…"}`
    : message.status === "interrupted"
      ? `You stopped after ${elapsed !== undefined ? formatDuration(elapsed) : "a while"}`
      : elapsed !== undefined
        ? `Worked for ${formatDuration(elapsed)}`
        : "Worked";

  // While working with nothing else visibly active, the model is thinking.
  const lastPart = message.parts.at(-1);
  const busy =
    lastPart !== undefined &&
    ((lastPart.type === "tool" && lastPart.state === "running") ||
      (lastPart.type === "reasoning" && lastPart.streaming) ||
      (lastPart.type === "text" && lastPart.streaming));

  return (
    <div className="flex w-full min-w-0 flex-col gap-1" data-testid="assistant-turn">
      {(lastWork >= 0 || live) && (
        <div className="mb-1 flex items-center border-border/60 border-b pt-1 pb-2">
          <button
            type="button"
            data-testid="turn-fold"
            aria-expanded={!folded}
            disabled={live}
            onClick={() => setUnfolded((v) => !v)}
            className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-muted-foreground text-sm tabular-nums leading-relaxed transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
          >
            <span>{label}</span>
            {!live &&
              (folded ? (
                <ChevronRightIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              ))}
          </button>
        </div>
      )}
      {blocks.map((block, i) => {
        if (hidden(block, i)) return null;
        if (block.kind === "tools") return <ToolGroup key={block.id} parts={block.parts} />;
        const part = block.part;
        if (part.type === "reasoning") return <ReasoningRow key={part.id} part={part} />;
        if (part.type === "subagent") {
          return (
            <Row
              key={part.id}
              icon={BotIcon}
              live={!part.done}
              label={part.done ? part.title : `Running ${part.title}`}
            />
          );
        }
        return (
          <div key={part.id} className={cn(part.type === "text" && "py-1")}>
            {props.renderPart(part)}
          </div>
        );
      })}
      {live && !busy && (
        <Row icon={BrainIcon} testId="thinking" label={<Shimmer as="span">Thinking…</Shimmer>} />
      )}
    </div>
  );
}

//#endregion

import { useAgent, useChat } from "alchemy/AI/React";
import type { UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
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
import { cn } from "@/lib/utils";

interface BoardThread {
  id: string;
  term: string;
  key: string;
  status: "running" | "idle" | "settled" | "crashed";
  ticks: number;
  createdAt: number;
  updatedAt: number;
  label: string;
}

interface BoardIssue {
  number: number;
  title: string;
  state: "open" | "closed" | "unknown";
  updatedAt: number;
  /** The issue's channel chat id — open this when the issue is clicked. */
  channel: string | undefined;
  /** Workers the owner dispatched, chronological. */
  agents: BoardThread[];
}

interface Board {
  issues: BoardIssue[];
  other: BoardThread[];
}

const STATUS_COLOR: Record<BoardThread["status"], string> = {
  running: "bg-emerald-500",
  idle: "bg-zinc-400",
  settled: "bg-zinc-600",
  crashed: "bg-red-500",
};

const ISSUE_STATE: Record<BoardIssue["state"], string> = {
  open: "text-emerald-400 border-emerald-400/40",
  closed: "text-violet-400 border-violet-400/40",
  unknown: "text-zinc-400 border-zinc-500/40",
};

export const App = () => {
  const [board, setBoard] = useState<Board>({ issues: [], other: [] });
  const [selected, setSelected] = useState<string>();
  // every thread the user has opened STAYS MOUNTED (hidden, socket
  // paused) — switching back restores its state and scroll position
  const [visited, setVisited] = useState<string[]>([]);
  const select = (id: string) => {
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
    setSelected(id);
  };

  // Directory feed: SSE of board snapshots (falls back to polling).
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
      // EventSource retries on its own; also poll as a backstop when
      // the stream is unavailable (old deploys, proxy buffers, …)
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

  const empty = board.issues.length === 0 && board.other.length === 0;

  /** The agents of the issue whose CHANNEL is this chat. */
  const agentsFor = (id: string): BoardThread[] =>
    board.issues.find((issue) => issue.channel === id)?.agents ?? [];

  /** When `id` is a worker, the issue-owner thread to climb back to. */
  const breadcrumbFor = (
    id: string,
  ): { label: string; to: string } | undefined => {
    for (const issue of board.issues) {
      if (
        issue.channel !== undefined &&
        issue.agents.some((agent) => agent.id === id)
      ) {
        return { label: `#${issue.number} ${issue.title}`, to: issue.channel };
      }
    }
    return undefined;
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-border">
        <div className="px-4 py-3 font-mono text-sm font-semibold tracking-tight">
          alchemy-org
        </div>
        {board.issues.map((issue) => {
          const busy =
            issue.agents.some((agent) => agent.status === "running") ||
            undefined;
          return (
            <button
              key={issue.number}
              type="button"
              disabled={issue.channel === undefined}
              onClick={() => issue.channel && select(issue.channel)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-border/50 px-4 py-3 text-left",
                issue.channel !== undefined && "hover:bg-accent",
                selected !== undefined &&
                  (issue.channel === selected ||
                    issue.agents.some((agent) => agent.id === selected)) &&
                  "bg-accent",
              )}
            >
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0 font-mono text-[10px] leading-4",
                  ISSUE_STATE[issue.state],
                )}
              >
                #{issue.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {issue.title}
              </span>
              {busy && (
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
              )}
              {issue.channel === undefined && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  queued
                </span>
              )}
            </button>
          );
        })}
        {board.other.length > 0 && (
          <div className="mt-2">
            <div className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Other threads
            </div>
            {board.other.map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => select(thread.id)}
                className={cn(
                  "flex w-full items-center gap-2 py-1.5 pr-4 pl-6 text-left text-sm hover:bg-accent",
                  selected === thread.id && "bg-accent",
                )}
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    STATUS_COLOR[thread.status],
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{thread.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {thread.ticks} ticks
                </span>
              </button>
            ))}
          </div>
        )}
        {empty && (
          <div className="px-4 py-8 text-sm text-muted-foreground">
            No activity yet — file an issue on test-alchemy.
          </div>
        )}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {visited.map((id) => (
          <div
            key={id}
            className={cn(
              "min-h-0 flex-1 flex-col",
              id === selected ? "flex" : "hidden",
            )}
          >
            <ChatView
              id={id}
              active={id === selected}
              agents={agentsFor(id)}
              breadcrumb={breadcrumbFor(id)}
              onOpenThread={select}
            />
          </div>
        ))}
        {selected === undefined && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            Select an issue
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
  const [initial, setInitial] = useState<UIMessage[]>();

  // snapshot first; the live tail rides the run socket. Drop the
  // snapshot's in-flight `live-*` sample — the socket restates that
  // burst durably, and keeping both renders the reasoning twice (one
  // stuck on "Thinking…" forever).
  useEffect(() => {
    fetch(`/api/chats/${encodeURIComponent(id)}/messages`)
      .then(
        (response) =>
          (response.ok ? response.json() : []) as Promise<UIMessage[]>,
      )
      .then((messages) =>
        setInitial(messages.filter((m) => !m.id.startsWith("live-"))),
      )
      .catch(() => setInitial([]));
  }, [id]);

  if (initial === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  return <Chat id={id} initial={initial} active={active} {...context} />;
};

/** GitHub event families → badge accent. */
const EVENT_STYLE: Array<[RegExp, string]> = [
  [/^Issue(?!Comment)/, "text-emerald-400 border-emerald-400/40"],
  [/^IssueComment/, "text-sky-400 border-sky-400/40"],
  [/^PullRequest/, "text-violet-400 border-violet-400/40"],
  [/^(CheckRun|CheckSuite|WorkflowRun|Push)/, "text-amber-400 border-amber-400/40"],
];

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
    return {
      event: {
        tag,
        repo,
        number: subject?.number,
        title: subject?.title,
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
 * One text part, upgraded: tagged world events render as a compact
 * card (badge + subject + author, raw JSON behind a disclosure) and
 * `<note>` inputs render as a muted aside — never a JSON dump.
 */
const TextPart = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false);
  const note = text.trim().match(/^<note>\n?([\s\S]*?)\n?<\/note>$/);
  if (note) {
    return (
      <div className="whitespace-pre-wrap rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
        {note[1]}
      </div>
    );
  }
  const world = parseWorldEvent(text);
  if (world === undefined) {
    return <div className="whitespace-pre-wrap">{text}</div>;
  }
  const { event, raw } = world;
  const style =
    EVENT_STYLE.find(([family]) => family.test(event.tag))?.[1] ??
    "text-zinc-400 border-zinc-500/40";
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
            style,
          )}
        >
          {/* PascalCase → spaced words: PullRequestOpened → PULL REQUEST OPENED */}
          {event.tag.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")}
        </span>
        {event.title && (
          <span className="min-w-0 truncate font-medium">{event.title}</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 font-mono text-xs text-muted-foreground">
        {event.repo && (
          <span>
            {event.repo}
            {event.number !== undefined ? `#${event.number}` : ""}
          </span>
        )}
        {event.author && <span>by {event.author}</span>}
        {event.url && (
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            open ↗
          </a>
        )}
      </div>
      {event.body && (
        <div className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
          {event.body}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-2 cursor-pointer font-mono text-[10px] text-muted-foreground hover:text-foreground"
      >
        {open ? "▾ raw event" : "▸ raw event"}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-background/60 p-2 text-[10px]">
          {raw}
        </pre>
      )}
    </div>
  );
};

const Chat = ({
  id,
  initial,
  active,
  agents,
  breadcrumb,
  onOpenThread,
}: {
  id: string;
  initial: UIMessage[];
  active: boolean;
} & ChatContext) => {
  // Persistent run socket — subscribe on mount, re-subscribe after
  // each burst so a parked IssueOwner keeps streaming. `history:
  // "live"`: the transcript hydrates from `initial` (the /messages
  // snapshot); a full replay would render every message twice.
  const agent = useAgent({ chatId: id, history: "live" });
  const { messages, sendMessage, status, setMessages, stop } = useChat({
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

  const watchOnly = !id.startsWith("IssueOwner:");

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
                  (thread) => thread.id === `${dispatch.agent}:${dispatch.child}`,
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

  // IssueOwner: world door is a GitHub comment (POST /api/chat); the
  // run socket carries the live view. Other threads steer via submit.
  const onSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text) return;
    if (watchOnly) return;
    if (id.startsWith("IssueOwner:")) {
      void fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          messages: [
            ...messages,
            {
              role: "user",
              parts: [{ type: "text", text }],
            },
          ],
        }),
      }).then(() =>
        // optimistic user bubble — the socket restates from the run
        setMessages([
          ...messages,
          {
            id: `local-${Date.now()}`,
            role: "user",
            parts: [{ type: "text", text }],
          },
        ]),
      );
      return;
    }
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
          {messages.map((message) => (
            <Message from={message.role} key={message.id}>
              <MessageContent>
                {message.parts.map((part, index) => {
                  if (part.type === "reasoning") {
                    const key = traceKey(part.text);
                    const open = expandedTraces.has(key);
                    return (
                      <div
                        key={index}
                        className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                      >
                        <button
                          type="button"
                          onClick={() => toggleTrace(key)}
                          className="flex w-full cursor-pointer items-center gap-1.5 text-left font-medium"
                        >
                          <span className="font-mono">{open ? "▾" : "▸"}</span>
                          {part.state === "streaming" ? (
                            <span className="animate-pulse">Thinking…</span>
                          ) : (
                            "Thought process"
                          )}
                        </button>
                        {open && (
                          <div className="mt-2 whitespace-pre-wrap">
                            {part.text}
                          </div>
                        )}
                      </div>
                    );
                  }
                  if (part.type === "text") {
                    return <TextPart key={index} text={part.text} />;
                  }
                  if (part.type === "dynamic-tool") {
                    const tool = part;
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
                          onClick={() => worker && onOpenThread(worker.id)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-left",
                            worker !== undefined && "hover:bg-accent",
                          )}
                        >
                          <span
                            className={cn(
                              "size-2.5 shrink-0 rounded-full",
                              running
                                ? "animate-pulse bg-emerald-500"
                                : worker?.status === "crashed"
                                  ? "bg-red-500"
                                  : "bg-zinc-500",
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
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4">
        <PromptInput onSubmit={onSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={
                watchOnly
                  ? "Watch-only: this run has no world door"
                  : "Message the issue owner (lands as a GitHub comment)…"
              }
              disabled={watchOnly}
            />
          </PromptInputBody>
          <PromptInputSubmit
            status={status === "streaming" ? "streaming" : undefined}
            disabled={watchOnly}
            className="absolute right-2 bottom-2"
          />
        </PromptInput>
      </div>
    </>
  );
};

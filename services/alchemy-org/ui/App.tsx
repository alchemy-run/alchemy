import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
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
  /** Workers the channel dispatched, chronological. */
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
  // every thread the user has opened STAYS MOUNTED (hidden, polling
  // paused) — switching back restores its state and scroll position
  const [visited, setVisited] = useState<string[]>([]);
  const select = (id: string) => {
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
    setSelected(id);
  };

  useEffect(() => {
    let live = true;
    const tick = () =>
      fetch("/api/board")
        .then((response) => response.json() as Promise<Board>)
        .then((data) => {
          if (live) setBoard(data);
        })
        .catch(() => {});
    tick();
    const interval = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, []);

  const empty = board.issues.length === 0 && board.other.length === 0;

  /** The agents of the issue whose CHANNEL is this chat. */
  const agentsFor = (id: string): BoardThread[] =>
    board.issues.find((issue) => issue.channel === id)?.agents ?? [];

  /** When `id` is a worker, the issue channel to climb back to. */
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

  // snapshot first, then the live tail rides the poll (streaming.md)
  useEffect(() => {
    fetch(`/api/chats/${encodeURIComponent(id)}/messages`)
      .then(
        (response) =>
          (response.ok ? response.json() : []) as Promise<UIMessage[]>,
      )
      .then(setInitial)
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
  const { messages, sendMessage, status, setMessages } = useChat({
    id,
    messages: initial,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  // the LIVE VIEW is snapshot polling: the server accumulates the
  // in-flight sampling's text/thinking deltas and appends them as a
  // streaming-state assistant message, so a 1s re-fetch renders
  // tokens as they arrive. Paused while HIDDEN (the thread stays
  // mounted; polling resumes on re-selection). The SSE stream only
  // exists for the send-message round trip — never clobber it
  // mid-flight.
  useEffect(() => {
    if (!active) return;
    if (status === "streaming" || status === "submitted") return;
    let live = true;
    const interval = setInterval(() => {
      fetch(`/api/chats/${encodeURIComponent(id)}/messages`)
        .then(
          (response) =>
            (response.ok ? response.json() : undefined) as Promise<
              UIMessage[] | undefined
            >,
        )
        .then((fresh) => {
          if (live && fresh !== undefined) setMessages(fresh);
        })
        .catch(() => {});
    }, 1000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [id, status, setMessages, active]);

  const watchOnly =
    !id.startsWith("Channel:") && !id.startsWith("PullRequestReviewer:");

  // dispatch tool-call → worker thread: the channel runs SERIALLY, so
  // the Nth dispatch of agent X is the Nth child run of term X
  const workerByCall = useMemo(() => {
    const counts = new Map<string, number>();
    const byCall = new Map<string, BoardThread>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (
          part.type === "dynamic-tool" &&
          part.toolName === "dispatch" &&
          typeof (part.input as any)?.agent === "string"
        ) {
          const agent = (part.input as any).agent as string;
          const index = counts.get(agent) ?? 0;
          counts.set(agent, index + 1);
          const worker = agents.filter((thread) => thread.term === agent)[
            index
          ];
          if (worker !== undefined) byCall.set(part.toolCallId, worker);
        }
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

  const onSubmit = (message: PromptInputMessage) => {
    if (message.text?.trim()) void sendMessage({ text: message.text });
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
                    return (
                      <div key={index} className="whitespace-pre-wrap">
                        {part.text}
                      </div>
                    );
                  }
                  if (part.type === "dynamic-tool") {
                    const tool = part;
                    if (tool.toolName === "dispatch") {
                      const worker = workerByCall.get(tool.toolCallId);
                      const agent =
                        (tool.input as any)?.agent ?? "subagent";
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
                  : "Message the channel (lands as a GitHub comment)…"
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

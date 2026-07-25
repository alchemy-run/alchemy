import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useState } from "react";
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

interface ChatSummary {
  id: string;
  term: string;
  key: string;
  status: "running" | "settled" | "crashed";
  ticks: number;
  updatedAt: number;
}

const STATUS_COLOR: Record<ChatSummary["status"], string> = {
  running: "bg-emerald-500",
  settled: "bg-zinc-500",
  crashed: "bg-red-500",
};

export const App = () => {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selected, setSelected] = useState<string>();

  // the run index — poll it; the org is the source of truth
  useEffect(() => {
    let live = true;
    const tick = () =>
      fetch("/api/chats")
        .then((response) => response.json() as Promise<ChatSummary[]>)
        .then((data) => {
          if (!live) return;
          setChats(data);
          setSelected((current) => current ?? data[0]?.id);
        })
        .catch(() => {});
    tick();
    const interval = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-border">
        <div className="px-4 py-3 font-mono text-sm font-semibold tracking-tight">
          alchemy-org
        </div>
        {chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            onClick={() => setSelected(chat.id)}
            className={cn(
              "flex w-full flex-col gap-0.5 border-b border-border/50 px-4 py-2.5 text-left text-sm hover:bg-accent",
              selected === chat.id && "bg-accent",
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "size-2 rounded-full",
                  STATUS_COLOR[chat.status],
                )}
              />
              <span className="font-medium">{chat.term}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {chat.ticks} ticks
              </span>
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {chat.key}
            </span>
          </button>
        ))}
        {chats.length === 0 && (
          <div className="px-4 py-8 text-sm text-muted-foreground">
            No runs yet — file an issue on test-alchemy.
          </div>
        )}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <ChatView key={selected} id={selected} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            Select a run
          </div>
        )}
      </main>
    </div>
  );
};

const ChatView = ({ id }: { id: string }) => {
  const [initial, setInitial] = useState<UIMessage[]>();

  // snapshot first, then the live tail rides useChat (streaming.md)
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
  return <Chat id={id} initial={initial} />;
};

const Chat = ({ id, initial }: { id: string; initial: UIMessage[] }) => {
  const { messages, sendMessage, status } = useChat({
    id,
    messages: initial,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const watchOnly = !id.startsWith("Issues:") && !id.startsWith("PullRequests:");

  const onSubmit = (message: PromptInputMessage) => {
    if (message.text?.trim()) void sendMessage({ text: message.text });
  };

  return (
    <>
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto max-w-3xl">
          {messages.map((message) => (
            <Message from={message.role} key={message.id}>
              <MessageContent>
                {message.parts.map((part, index) => {
                  if (part.type === "text") {
                    return (
                      <div key={index} className="whitespace-pre-wrap">
                        {part.text}
                      </div>
                    );
                  }
                  if (part.type === "dynamic-tool") {
                    const tool = part;
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
                  : "Message the desk (lands as a GitHub comment)…"
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

/**
 * The reference alchemy chat app (designs/ai/chat-apps.md): stock
 * `useChat` over the serving tier's AI SDK wire, scroll behavior from
 * `MessageScroller` (anchored turns, live-edge follow, jump-to-latest
 * — never moves the reader against their intent), and one switch over
 * `message.parts`: AI Elements for the standard parts, `AskCard` for
 * the Ask protocol.
 */
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { memo, useEffect, useState } from "react";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { type AskData, AskCard } from "@/components/ask-card";
import { TracePanel } from "@/components/trace-panel";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { ActivityIcon, DicesIcon, PlusIcon } from "lucide-react";
import type { UIMessage } from "ai";

const suggestions = [
  "wager 10 coins on a d20",
  "wager 100 coins on a d6", // over the approval threshold — parks an ask
  "roll two d8s and tell me if I beat a 10",
  "what games can we play here?",
];

type Part = UIMessage["parts"][number];

function MessagePart({ part, index }: { part: Part; index: number }) {
  if (part.type === "text") {
    return <MessageResponse key={index}>{part.text}</MessageResponse>;
  }
  if (part.type === "reasoning") {
    return (
      <Reasoning isStreaming={part.state === "streaming"}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (part.type === "dynamic-tool") {
    return (
      <Tool key={part.toolCallId}>
        <ToolHeader
          type="dynamic-tool"
          toolName={part.toolName}
          state={part.state}
        />
        <ToolContent>
          <ToolInput input={part.input} />
          <ToolOutput
            output={part.state === "output-available" ? part.output : undefined}
            errorText={part.state === "output-error" ? part.errorText : undefined}
          />
        </ToolContent>
      </Tool>
    );
  }
  if (part.type === "data-ask") {
    return <AskCard key={(part as { id?: string }).id} data={part.data as AskData} />;
  }
  return null;
}

/**
 * Memoized on message identity: useChat only replaces the object of the
 * message that changed, so a streaming delta re-renders ONE message row
 * instead of the whole transcript.
 */
const MessageView = memo(function MessageView({
  message,
}: {
  message: UIMessage;
}) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, index) => (
          <MessagePart key={index} part={part} index={index} />
        ))}
      </MessageContent>
    </Message>
  );
});

/**
 * One conversation. Keyed by conversation id from `App`, so switching
 * chats remounts with the saved transcript as initial messages —
 * `defaultScrollPosition="last-anchor"` then reopens the thread at the
 * last user message (scroll rule 11), not the absolute bottom.
 */
function Chat({
  conversationId,
  initialMessages,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
}) {
  const [text, setText] = useState("");
  const { messages, sendMessage, status } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    // batch stream updates to ~20fps: word-paced deltas would otherwise
    // force a React render per word
    experimental_throttle: 50,
  });
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const waiting =
    isBusy &&
    (lastMessage?.role !== "assistant" || lastMessage.parts.length === 0);

  return (
    <div className="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col">
        {messages.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DicesIcon />
              </EmptyMedia>
              <EmptyTitle>The croupier is at the table</EmptyTitle>
              <EmptyDescription>
                Wager imaginary coins, roll real dice. Big wagers need your
                approval.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent aria-busy={isBusy} className="px-4 py-6">
                  {messages.map((message) => (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={message.role === "user"}
                    >
                      <MessageView message={message} />
                    </MessageScrollerItem>
                  ))}
                  {waiting && (
                    <MessageScrollerItem messageId="waiting">
                      <Marker role="status">
                        <MarkerIcon>
                          <Spinner className="size-3" />
                        </MarkerIcon>
                        <MarkerContent>
                          <Shimmer>The croupier is thinking…</Shimmer>
                        </MarkerContent>
                      </Marker>
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
        )}

        <div className="flex flex-col gap-2 px-4 pb-4">
          {messages.length === 0 && (
            <Suggestions>
              {suggestions.map((suggestion) => (
                <Suggestion
                  key={suggestion}
                  suggestion={suggestion}
                  onClick={(s) => sendMessage({ text: s })}
                />
              ))}
            </Suggestions>
          )}
          <PromptInput
            onSubmit={(message) => {
              const value = message.text?.trim();
              if (!value || isBusy) return;
              sendMessage({ text: value });
              setText("");
            }}
          >
            <PromptInputBody>
              <PromptInputTextarea
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
                placeholder="wager 10 coins on a d20…"
              />
            </PromptInputBody>
            <PromptInputFooter className="justify-end">
              <PromptInputSubmit status={status} disabled={!text.trim()} />
            </PromptInputFooter>
          </PromptInput>
        </div>
    </div>
  );
}

interface ConversationSummary {
  id: string;
  title: string;
  messages: number;
}

export function App() {
  const [showTrace, setShowTrace] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string>(() =>
    crypto.randomUUID(),
  );
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);

  const refreshIndex = () =>
    fetch("/api/chats")
      .then((response) => response.json())
      .then((body: { conversations: ConversationSummary[] }) =>
        setConversations(body.conversations),
      )
      .catch(() => {});

  useEffect(() => {
    void refreshIndex();
    const timer = setInterval(refreshIndex, 5_000);
    return () => clearInterval(timer);
  }, []);

  const openConversation = async (id: string) => {
    const body = (await (await fetch(`/api/chat/${id}`)).json()) as {
      messages: UIMessage[];
    };
    setInitialMessages(body.messages);
    setConversationId(id);
  };

  const newConversation = () => {
    setInitialMessages([]);
    setConversationId(crypto.randomUUID());
  };

  return (
    <div className="dark flex h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide">
          the dice parlor
        </h1>
        <Button
          variant={showTrace ? "secondary" : "ghost"}
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setShowTrace((current) => !current)}
        >
          <ActivityIcon className="size-3.5" />
          trace
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 min-h-0 flex-col border-r">
          <div className="p-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5 text-xs"
              onClick={newConversation}
            >
              <PlusIcon className="size-3.5" />
              New chat
            </Button>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => void openConversation(conversation.id)}
                className={`w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-accent ${
                  conversation.id === conversationId
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {conversation.title || conversation.id}
              </button>
            ))}
          </nav>
        </aside>

        <Chat
          key={conversationId}
          conversationId={conversationId}
          initialMessages={initialMessages}
        />

        {showTrace && <TracePanel ring="Croupier" />}
      </div>
    </div>
  );
}

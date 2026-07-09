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
import { useState } from "react";
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
import { DicesIcon } from "lucide-react";
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

export function App() {
  const [text, setText] = useState("");
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const waiting =
    isBusy &&
    (lastMessage?.role !== "assistant" || lastMessage.parts.length === 0);

  return (
    <div className="dark flex h-dvh flex-col bg-background text-foreground">
      <header className="flex items-baseline justify-between border-b px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide">
          the dice parlor
        </h1>
        <span className="text-xs text-muted-foreground">{status}</span>
      </header>

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
          <MessageScrollerProvider autoScroll>
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent aria-busy={isBusy} className="px-4 py-6">
                  {messages.map((message) => (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={message.role === "user"}
                    >
                      <Message from={message.role}>
                        <MessageContent>
                          {message.parts.map((part, index) => (
                            <MessagePart key={index} part={part} index={index} />
                          ))}
                        </MessageContent>
                      </Message>
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
    </div>
  );
}

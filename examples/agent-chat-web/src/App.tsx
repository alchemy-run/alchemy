/**
 * The org workspace (designs/ai/org-chat.md): a Discord/Slack-shaped
 * app whose structure is DERIVED from the term graph — the sidebar is
 * `GET /api/topology` (channels grouped by their user-defined kind,
 * agents as DM targets), a channel's Posts are conversations targeted
 * at its ring, replies join the Post's thread, and each Post is driven
 * to resolution by the Channel process (fan-out to member agents,
 * relayed replies rendered as authored bubbles).
 */
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useState } from "react";
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
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
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
import {
  ActivityIcon,
  ArrowLeftIcon,
  AtSignIcon,
  BotIcon,
  CheckCircleIcon,
  HashIcon,
  PlusIcon,
} from "lucide-react";
import type { UIMessage } from "ai";

// ─── topology (the derived org) ──────────────────────────────────

interface TopologyNode {
  name: string;
  kind: "process" | "agent" | "tool";
  subkind?: string;
  meta?: { category?: string; icon?: string };
  prose: string;
  children: TopologyNode[];
  tools: string[];
}

/** Names of agents anywhere in the org — used to style authored bubbles. */
const collectAgents = (nodes: TopologyNode[]): Set<string> => {
  const out = new Set<string>();
  const walk = (node: TopologyNode) => {
    if (node.kind === "agent") out.add(node.name);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
};

let knownAgents = new Set<string>();

/**
 * Opens the run inspector (right sidebar) on an agent's ring — set by
 * `App`, invoked by delegation pills deep in the message tree.
 */
let openInspector: (agent: string) => void = () => {};

// ─── message parts ───────────────────────────────────────────────

type Part = UIMessage["parts"][number];

/** A member's relayed reply (`post_reply`) renders as an authored bubble. */
function AuthoredReply({ author, text }: { author: string; text: string }) {
  return (
    <div className="my-1 flex gap-2.5">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-bold">
        {author.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold">{author}</div>
        <MessageResponse className="text-sm">{text}</MessageResponse>
      </div>
    </div>
  );
}

function MessagePart({
  part,
  index,
  channelMode,
}: {
  part: Part;
  index: number;
  /**
   * In a channel thread the Process is a coordinator, never a
   * participant: its prose and thinking are invisible (they remain in
   * the trace); only relayed member messages, delegation pills, asks,
   * and the resolution render.
   */
  channelMode: boolean;
}) {
  if (part.type === "text") {
    if (channelMode) return null;
    return <MessageResponse key={index}>{part.text}</MessageResponse>;
  }
  if (part.type === "reasoning") {
    if (channelMode) return null;
    return (
      <Reasoning isStreaming={part.state === "streaming"}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
    // AI SDK has two equivalent wire projections:
    // - `dynamic-tool` + `toolName` for unknown-at-compile-time tools;
    // - `tool-${name}` for named tools reconstructed by useChat.
    // Normalize both before applying our semantic renderers.
    const tool = part as unknown as {
      type: string;
      toolName?: string;
      toolCallId: string;
      state: ToolPart["state"];
      input?: unknown;
      output?: unknown;
      errorText?: string;
    };
    const toolName =
      tool.type === "dynamic-tool"
        ? String(tool.toolName)
        : tool.type.slice("tool-".length);
    const input = tool.input as Record<string, unknown> | undefined;
    // a relayed member reply — the room speaking as a member
    if (toolName === "post_reply" && input?.author !== undefined) {
      return (
        <AuthoredReply
          author={String(input.author)}
          text={String(input.text ?? "")}
        />
      );
    }
    // a delegation to a member agent — an async pill; click to inspect
    // the agent's live run (thinking, tools, messages) in the sidebar
    if (knownAgents.has(toolName)) {
      const working = tool.state !== "output-available";
      return (
        <button
          type="button"
          onClick={() => openInspector(toolName)}
          className="my-1 flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          title={`Inspect ${toolName}'s run`}
        >
          {working ? (
            <Spinner className="size-3" />
          ) : (
            <CheckCircleIcon className="size-3 text-green-600" />
          )}
          {working ? (
            <Shimmer>{`${toolName} is working…`}</Shimmer>
          ) : (
            `${toolName} finished`
          )}
        </button>
      );
    }
    // the resolution marker
    if (toolName === "resolve") {
      return (
        <Marker role="status" className="my-1">
          <MarkerIcon>
            <CheckCircleIcon className="size-3 text-green-600" />
          </MarkerIcon>
          <MarkerContent>
            {tool.state === "output-available"
              ? `resolved: ${String(input?.value ?? "")}`
              : "resolving…"}
          </MarkerContent>
        </Marker>
      );
    }
    return (
      <Tool key={tool.toolCallId}>
        <ToolHeader
          type="dynamic-tool"
          toolName={toolName}
          state={tool.state}
        />
        <ToolContent>
          <ToolInput input={tool.input} />
          <ToolOutput
            output={tool.state === "output-available" ? tool.output : undefined}
            errorText={
              tool.state === "output-error" ? tool.errorText : undefined
            }
          />
        </ToolContent>
      </Tool>
    );
  }
  if (part.type === "data-message") {
    // a deterministic coordinator's ctx.post — an authored bubble
    const data = (part as { data: { author: string; text: string } }).data;
    return <AuthoredReply author={data.author} text={data.text} />;
  }
  if (part.type === "data-run") {
    const data = (
      part as {
        data: {
          agent: string;
          status: "running" | "completed" | "failed";
          error?: string;
        };
      }
    ).data;
    return (
      <button
        type="button"
        onClick={() => openInspector(data.agent)}
        className="my-1 flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
        title={`Inspect ${data.agent}'s run`}
      >
        {data.status === "running" ? (
          <Spinner className="size-3" />
        ) : (
          <CheckCircleIcon
            className={`size-3 ${data.status === "failed" ? "text-red-600" : "text-green-600"}`}
          />
        )}
        {data.status === "running"
          ? `${data.agent} is working…`
          : data.status === "failed"
            ? `${data.agent} failed`
            : `${data.agent} finished`}
      </button>
    );
  }
  if (part.type === "data-resolution") {
    const summary = (part as { data: { summary: string } }).data.summary;
    return (
      <Marker role="status" className="my-1">
        <MarkerIcon>
          <CheckCircleIcon className="size-3 text-green-600" />
        </MarkerIcon>
        <MarkerContent>{`resolved: ${summary}`}</MarkerContent>
      </Marker>
    );
  }
  if (part.type === "data-ask") {
    return (
      <AskCard key={(part as { id?: string }).id} data={part.data as AskData} />
    );
  }
  return null;
}

function MessageView({
  message,
  channelMode = false,
}: {
  message: UIMessage;
  channelMode?: boolean;
}) {
  const hideCoordinatorProse = channelMode && message.role === "assistant";
  const visible = message.parts.some(
    (part) =>
      !hideCoordinatorProse ||
      (part.type !== "text" &&
        part.type !== "reasoning" &&
        part.type !== "step-start"),
  );
  if (!visible && message.role === "assistant") return null;
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, index) => (
          <MessagePart
            key={index}
            part={part}
            index={index}
            channelMode={hideCoordinatorProse}
          />
        ))}
      </MessageContent>
    </Message>
  );
}

// ─── the thread (one conversation — a Post's thread or a DM) ─────

function Thread({
  conversationId,
  initialMessages,
  placeholder,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );
  const { messages, sendMessage, status } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    experimental_throttle: 50,
  });
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const lastPart = lastMessage?.parts.at(-1);
  const streamingNow =
    lastPart !== undefined &&
    (lastPart.type === "text" || lastPart.type === "reasoning") &&
    (lastPart as { state?: string }).state === "streaming";
  const pendingAsk =
    lastMessage?.parts.some(
      (part) =>
        part.type === "data-ask" &&
        (part as { data?: { status?: string } }).data?.status === "pending",
    ) ?? false;
  const waiting = isBusy && !streamingNow && !pendingAsk;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {messages.length === 0 ? (
        <div className="flex-1" />
      ) : (
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent aria-busy={isBusy} className="px-4 py-4">
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
                        <Shimmer>working…</Shimmer>
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
      <div className="px-4 pb-4">
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
              placeholder={placeholder}
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

// ─── the channel (a list of Posts; each opens its thread) ────────

interface ConversationSummary {
  id: string;
  title: string;
  messages: number;
}

function ChannelView({
  channel,
  conversations,
  onRefresh,
}: {
  channel: TopologyNode;
  conversations: ConversationSummary[];
  onRefresh: () => void;
}) {
  const [openPost, setOpenPost] = useState<string | undefined>();
  const posts = conversations.filter((conversation) =>
    conversation.id.startsWith(`${channel.name}/`),
  );

  if (openPost !== undefined) {
    return (
      <PostThread
        conversationId={openPost}
        channel={channel.name}
        onBack={() => {
          setOpenPost(undefined);
          onRefresh();
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <HashIcon className="size-4 text-muted-foreground" />
          {channel.name}
        </div>
        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
          members: {channel.children.map((child) => child.name).join(", ")}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {posts.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HashIcon />
              </EmptyMedia>
              <EmptyTitle>No posts yet</EmptyTitle>
              <EmptyDescription>
                Start a Post below — the channel decides who picks it up.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {posts.map((post) => (
              <button
                key={post.id}
                type="button"
                onClick={() => setOpenPost(post.id)}
                className="rounded-lg border px-3 py-2.5 text-left hover:bg-accent"
              >
                <div className="line-clamp-1 text-sm font-medium">
                  {post.title}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {post.messages} message{post.messages === 1 ? "" : "s"} in
                  thread
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <NewPostComposer
        channel={channel.name}
        onPost={(conversationId) => setOpenPost(conversationId)}
      />
    </div>
  );
}

function NewPostComposer({
  channel,
  onPost,
}: {
  channel: string;
  onPost: (conversationId: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="px-4 pb-4">
      <PromptInput
        onSubmit={(message) => {
          const value = message.text?.trim();
          if (!value) return;
          const conversationId = `${channel}/${crypto.randomUUID().slice(0, 8)}`;
          // Own the chat OUTSIDE the soon-to-mount thread component and
          // send in this user event. The AI SDK Chat retains stream state
          // across React remounts / index polling; mount-triggered sends
          // lost their hook state while the backend kept running.
          const chat = new Chat<UIMessage>({
            id: conversationId,
            transport: new DefaultChatTransport({ api: "/api/chat" }),
          });
          activeChats.set(conversationId, chat);
          pendingOutbound.set(conversationId, value);
          setText("");
          onPost(conversationId);
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            placeholder={`Start a Post in #${channel}…`}
          />
        </PromptInputBody>
        <PromptInputFooter className="justify-end">
          <PromptInputSubmit status="ready" disabled={!text.trim()} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

/** Live Chat owners keyed by Post id; views subscribe but do not own them. */
const activeChats = new Map<string, Chat<UIMessage>>();
const pendingOutbound = new Map<string, string>();

function PostThread({
  conversationId,
  channel,
  onBack,
}: {
  conversationId: string;
  channel: string;
  onBack: () => void;
}) {
  const [chat, setChat] = useState<Chat<UIMessage> | undefined>(() =>
    activeChats.get(conversationId),
  );

  useEffect(() => {
    if (chat !== undefined) return;
    void fetch(`/api/chat/${encodeURIComponent(conversationId)}`)
      .then((response) => response.json())
      .then((body: { messages: UIMessage[] }) => {
        const restored = new Chat<UIMessage>({
          id: conversationId,
          messages: body.messages,
          transport: new DefaultChatTransport({ api: "/api/chat" }),
        });
        activeChats.set(conversationId, restored);
        setChat(restored);
      })
      .catch(() => {
        const empty = new Chat<UIMessage>({
          id: conversationId,
          transport: new DefaultChatTransport({ api: "/api/chat" }),
        });
        activeChats.set(conversationId, empty);
        setChat(empty);
      });
  }, [chat, conversationId]);

  if (chat === undefined) {
    return <div className="flex-1 p-4 text-sm text-muted-foreground">…</div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <span className="text-sm font-semibold">
          Thread in #{channel}
        </span>
      </div>
      <ThreadWithChat
        chat={chat}
        placeholder="Reply to this Post…"
      />
    </div>
  );
}

/** A thread view subscribing to a persistent AI SDK Chat owner. */
function ThreadWithChat({
  chat,
  placeholder,
}: {
  chat: Chat<UIMessage>;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const { messages, sendMessage, status } = useChat({
    chat,
    experimental_throttle: 50,
  });

  useEffect(() => {
    const pending = pendingOutbound.get(chat.id);
    // The external Chat is the idempotency guard: send only after this
    // view has subscribed, and only while the persistent owner is still
    // empty. Remounts see the already-added user message and do nothing.
    if (pending !== undefined && chat.messages.length === 0) {
      pendingOutbound.delete(chat.id);
      void chat.sendMessage({ text: pending });
    }
  }, [chat]);

  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const lastPart = lastMessage?.parts.at(-1);
  const streamingNow =
    lastPart !== undefined &&
    (lastPart.type === "text" || lastPart.type === "reasoning") &&
    (lastPart as { state?: string }).state === "streaming";
  const pendingAsk =
    lastMessage?.parts.some(
      (part) =>
        part.type === "data-ask" &&
        (part as { data?: { status?: string } }).data?.status === "pending",
    ) ?? false;
  const waiting = isBusy && !streamingNow && !pendingAsk;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <script
        type="application/json"
        data-debug-chat
        dangerouslySetInnerHTML={{ __html: JSON.stringify(messages) }}
      />
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent aria-busy={isBusy} className="px-4 py-4">
              {messages.map((message) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                >
                  <MessageView message={message} channelMode />
                </MessageScrollerItem>
              ))}
              {waiting && (
                <MessageScrollerItem messageId="waiting">
                  <Marker role="status">
                    <MarkerIcon>
                      <Spinner className="size-3" />
                    </MarkerIcon>
                    <MarkerContent>
                      <Shimmer>the channel is working…</Shimmer>
                    </MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="px-4 pb-4">
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
              placeholder={placeholder}
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

// ─── the DM (1:1 with an agent) ──────────────────────────────────

function DmView({ agent }: { agent: TopologyNode }) {
  const conversationId = `dm:${agent.name}/main`;
  const [initial, setInitial] = useState<UIMessage[] | undefined>();

  useEffect(() => {
    setInitial(undefined);
    void fetch(`/api/chat/${encodeURIComponent(conversationId)}`)
      .then((response) => response.json())
      .then((body: { messages: UIMessage[] }) => setInitial(body.messages))
      .catch(() => setInitial([]));
  }, [conversationId]);

  if (initial === undefined) {
    return <div className="flex-1 p-4 text-sm text-muted-foreground">…</div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <AtSignIcon className="size-4 text-muted-foreground" />
          {agent.name}
        </div>
        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
          {agent.prose}
        </p>
      </div>
      <Thread
        key={conversationId}
        conversationId={conversationId}
        initialMessages={initial}
        placeholder={`Message ${agent.name}…`}
      />
    </div>
  );
}

// ─── the app shell ───────────────────────────────────────────────

type Selection =
  | { type: "channel"; name: string }
  | { type: "dm"; name: string };

export function App() {
  const [topology, setTopology] = useState<TopologyNode[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selection, setSelection] = useState<Selection | undefined>();
  const [showTrace, setShowTrace] = useState(false);
  // the run inspector: which agent's ring the right sidebar follows
  const [inspecting, setInspecting] = useState<string | undefined>();
  openInspector = (agent) => {
    setShowTrace(false);
    setInspecting(agent);
  };

  const refreshChats = () =>
    fetch("/api/chats")
      .then((response) => response.json())
      .then((body: { conversations: ConversationSummary[] }) =>
        setConversations(body.conversations),
      )
      .catch(() => {});

  useEffect(() => {
    void fetch("/api/topology")
      .then((response) => response.json())
      .then((body: { topology: TopologyNode[] }) => {
        setTopology(body.topology);
        knownAgents = collectAgents(body.topology);
        const firstChannel = body.topology.find(
          (node) => node.kind === "process",
        );
        if (firstChannel !== undefined) {
          setSelection({ type: "channel", name: firstChannel.name });
        }
      })
      .catch(() => {});
    void refreshChats();
    const timer = setInterval(refreshChats, 4_000);
    return () => clearInterval(timer);
  }, []);

  const channels = topology.filter((node) => node.kind === "process");
  const agents = topology.filter((node) => node.kind === "agent");
  const selected =
    selection?.type === "channel"
      ? channels.find((node) => node.name === selection.name)
      : agents.find((node) => node.name === selection?.name);

  return (
    <div className="dark flex h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h1 className="text-sm font-semibold tracking-wide">the workspace</h1>
        <Button
          variant={showTrace ? "secondary" : "ghost"}
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => {
            setInspecting(undefined);
            setShowTrace((current) => !current);
          }}
        >
          <ActivityIcon className="size-3.5" />
          trace
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 min-h-0 flex-col gap-4 overflow-y-auto border-r p-3">
          {/* channels, grouped by their process kind */}
          {[...new Set(channels.map((node) => node.subkind ?? "process"))].map(
            (subkind) => (
              <div key={subkind}>
                <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {subkind}s
                </div>
                {channels
                  .filter((node) => (node.subkind ?? "process") === subkind)
                  .map((node) => (
                    <button
                      key={node.name}
                      type="button"
                      onClick={() =>
                        setSelection({ type: "channel", name: node.name })
                      }
                      className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm ${
                        selection?.type === "channel" &&
                        selection.name === node.name
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50"
                      }`}
                    >
                      <HashIcon className="size-3.5 shrink-0" />
                      {node.name}
                    </button>
                  ))}
              </div>
            ),
          )}
          {/* agents = DM targets */}
          <div>
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              agents
            </div>
            {agents.map((node) => (
              <button
                key={node.name}
                type="button"
                onClick={() => setSelection({ type: "dm", name: node.name })}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm ${
                  selection?.type === "dm" && selection.name === node.name
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                <BotIcon className="size-3.5 shrink-0" />
                {node.name}
              </button>
            ))}
          </div>
        </aside>

        {selected === undefined ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlusIcon />
              </EmptyMedia>
              <EmptyTitle>Pick a channel or an agent</EmptyTitle>
              <EmptyDescription>
                The sidebar is derived from the org's process terms.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : selection?.type === "channel" ? (
          <ChannelView
            key={selected.name}
            channel={selected}
            conversations={conversations}
            onRefresh={() => void refreshChats()}
          />
        ) : (
          <DmView key={selected.name} agent={selected} />
        )}

        {inspecting !== undefined && (
          <TracePanel
            key={`inspector:${inspecting}`}
            ring={inspecting}
            title={`${inspecting}'s run`}
            onClose={() => setInspecting(undefined)}
          />
        )}
        {showTrace && selection !== undefined && (
          <TracePanel key={`trace:${selection.name}`} ring={selection.name} />
        )}
      </div>
    </div>
  );
}

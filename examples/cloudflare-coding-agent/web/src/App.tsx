import type * as AI from "alchemy/AI/Client";
import {
  BotIcon,
  BrainIcon,
  CircleDotIcon,
  CpuIcon,
  FolderGit2Icon,
  GitBranchIcon,
  PanelRightIcon,
  PlusIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { agents, useSession, useSnapshot } from "./agents.ts";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./components/ai-elements/confirmation.tsx";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./components/ai-elements/conversation.tsx";
import { Message, MessageContent, MessageResponse } from "./components/ai-elements/message.tsx";
import {
  Plan,
  PlanContent,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "./components/ai-elements/plan.tsx";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputButton,
} from "./components/ai-elements/prompt-input.tsx";
import { Shimmer } from "./components/ai-elements/shimmer.tsx";
import { AssistantTurn } from "./components/chat/work-log.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
];

/** The repository each session's container has checked out. */
const WORKDIR = "/workspace/alchemy";

//#region sessions list (persisted in the browser)

const useSessionIds = () => {
  const [ids, setIds] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("sessions") ?? "[]"),
  );
  const add = (id: string) =>
    setIds((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)];
      localStorage.setItem("sessions", JSON.stringify(next));
      return next;
    });
  return [ids, add] as const;
};

/** Re-render every second while something is running (elapsed timers). */
const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

const elapsed = (from: number | undefined, now: number) => {
  if (from === undefined) return "";
  const s = Math.max(0, Math.round((now - from) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};

//#endregion

//#region sidebar

function SessionStatus({ transcript, now }: { transcript: AI.Transcript; now: number }) {
  switch (transcript.state) {
    case "running":
      return (
        <span className="flex items-center gap-1.5 text-info">
          <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
          Working {elapsed(transcript.turnStartedAt, now)}
        </span>
      );
    case "awaiting_input":
      return <span className="text-warning">Needs input</span>;
    case "new":
      return <span className="text-muted-foreground">Connecting…</span>;
    default:
      return <span className="text-muted-foreground">Idle</span>;
  }
}

function SidebarRow(props: { id: string; active: boolean; onSelect: () => void }) {
  const snapshot = useSnapshot(props.id);
  const now = useNow(snapshot?.transcript.state === "running");
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-sidebar-accent",
        props.active && "bg-sidebar-accent",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="grid size-4 place-items-center rounded bg-white/8 font-semibold text-[9px] text-foreground">
            CA
          </span>
          coding-agents
        </span>
        {snapshot ? (
          <SessionStatus transcript={snapshot.transcript} now={now} />
        ) : (
          <span className="text-muted-foreground">Settled</span>
        )}
      </div>
      <div className="truncate text-[15px] text-foreground">{props.id}</div>
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <FolderGit2Icon className="size-3" />
        <span className="truncate">{WORKDIR}</span>
        {snapshot && snapshot.transcript.usage.costUsd ? (
          <span className="ml-auto tabular-nums">
            ${snapshot.transcript.usage.costUsd.toFixed(3)}
          </span>
        ) : null}
      </div>
    </button>
  );
}

function Sidebar(props: {
  ids: string[];
  current: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <BotIcon className="size-5 text-primary" />
        <span className="font-semibold text-[15px]">Coding Agents</span>
      </div>
      <div className="px-3 pb-2">
        <Button variant="secondary" className="w-full justify-start gap-2" onClick={props.onCreate}>
          <PlusIcon className="size-4" /> New session
        </Button>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {props.ids.map((id) => (
          <SidebarRow
            key={id}
            id={id}
            active={id === props.current}
            onSelect={() => props.onSelect(id)}
          />
        ))}
      </nav>
      <div className="border-t px-4 py-3 text-muted-foreground text-xs">
        Each session runs in its own container.
      </div>
    </aside>
  );
}

//#endregion

//#region transcript parts

function Part({ sessionId, part }: { sessionId: string; part: AI.TranscriptPart }) {
  switch (part.type) {
    case "text":
      return <MessageResponse>{part.text}</MessageResponse>;
    case "reasoning":
    case "tool":
      // Rendered by the work log (AssistantTurn).
      return null;
    case "plan":
      return (
        <Plan defaultOpen>
          <PlanHeader>
            <PlanTitle>Plan</PlanTitle>
            <PlanTrigger />
          </PlanHeader>
          <PlanContent>
            <ul className="space-y-1 text-sm">
              {part.entries.map((entry, i) => (
                <li key={i} className="flex items-center gap-2">
                  <CircleDotIcon
                    className={cn(
                      "size-3.5",
                      entry.status === "completed"
                        ? "text-success"
                        : entry.status === "in_progress"
                          ? "text-info"
                          : "text-muted-foreground",
                    )}
                  />
                  <span
                    className={
                      entry.status === "completed" ? "text-muted-foreground line-through" : ""
                    }
                  >
                    {entry.content}
                  </span>
                </li>
              ))}
            </ul>
          </PlanContent>
        </Plan>
      );
    case "permission":
      return (
        <Confirmation approval={{ id: part.requestId }} state="approval-requested">
          <ConfirmationTitle>
            <ConfirmationRequest>
              Allow <code className="rounded bg-muted px-1">{part.tool.title}</code>?
            </ConfirmationRequest>
          </ConfirmationTitle>
          <ConfirmationActions>
            {part.options.map((option) => (
              <ConfirmationAction
                key={option.id}
                variant={option.kind.startsWith("allow") ? "default" : "outline"}
                onClick={() =>
                  void agents.respond(sessionId, part.requestId, {
                    type: "permission",
                    optionId: option.id,
                  })
                }
              >
                {option.name}
              </ConfirmationAction>
            ))}
          </ConfirmationActions>
        </Confirmation>
      );
    case "question":
      return <div className="rounded-lg border bg-card p-3 text-sm">{part.question}</div>;
    case "subagent":
      return (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <BotIcon className="size-4" />
          {part.done ? part.title : <Shimmer>{part.title}</Shimmer>}
        </div>
      );
    case "notice":
      return (
        <div
          className={cn(
            "text-xs",
            part.level === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {part.text}
        </div>
      );
  }
}

//#endregion

//#region chat

function Composer({ id, transcript }: { id: string; transcript: AI.Transcript }) {
  const running = transcript.state === "running" || transcript.state === "awaiting_input";
  const [model, setModel] = useState(transcript.model ?? MODELS[0]!.id);
  useEffect(() => {
    if (transcript.model) setModel(transcript.model);
  }, [transcript.model]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <PromptInput
        className="rounded-2xl border bg-card shadow-lg"
        onSubmit={({ text }) => {
          const message = text.trim();
          if (!message) return;
          void (running ? agents.steer(id, message) : agents.prompt(id, message));
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            placeholder={running ? "Steer the running turn…" : "Ask the agent to do something…"}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputSelect
              value={model}
              onValueChange={(next) => {
                setModel(next);
                void agents.setModel(id, next);
              }}
            >
              <PromptInputSelectTrigger className="gap-2">
                <span className="text-[#d97757]">✳</span>
                <PromptInputSelectValue />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                {MODELS.map((m) => (
                  <PromptInputSelectItem key={m.id} value={m.id}>
                    {m.label}
                  </PromptInputSelectItem>
                ))}
              </PromptInputSelectContent>
            </PromptInputSelect>
            {running && (
              <PromptInputButton onClick={() => void agents.interrupt(id)}>
                <SquareIcon className="size-3.5" /> Interrupt
              </PromptInputButton>
            )}
          </PromptInputTools>
          <PromptInputSubmit status={running ? "streaming" : "ready"} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function Chat({ id }: { id: string }) {
  const { transcript, error, connected, pending } = useSession(id);
  const running = transcript.state === "running";
  const last = transcript.messages.at(-1);
  // Sent, but the turn hasn't started yet (a started turn shows its own progress).
  const waiting = running && last?.role !== "assistant";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
          {transcript.messages.length === 0 && pending.length === 0 ? (
            <ConversationEmptyState
              icon={<TerminalIcon className="size-8" />}
              title="Start a session"
              description={`The agent works in ${WORKDIR}, in its own container.`}
            />
          ) : (
            transcript.messages.map((message) =>
              message.role === "assistant" ? (
                <Message key={message.id} from="assistant">
                  <AssistantTurn
                    message={message}
                    renderPart={(part) => <Part sessionId={id} part={part} />}
                  />
                </Message>
              ) : (
                <Message key={message.id} from="user">
                  <MessageContent className="gap-3">
                    {message.parts.map((part) => (
                      <Part key={part.id} sessionId={id} part={part} />
                    ))}
                  </MessageContent>
                </Message>
              ),
            )
          )}
          {pending.map((text, i) => (
            <Message key={`pending-${i}`} from="user">
              <MessageContent>{text}</MessageContent>
            </Message>
          ))}
          {!connected && !error && <Shimmer className="text-sm">Preparing workspace…</Shimmer>}
          {waiting && (
            <div className="flex items-center gap-1.5 px-0.5 text-sm" data-testid="thinking">
              <span className="flex size-6 items-center justify-center">
                <BrainIcon className="size-4 text-muted-foreground opacity-70" />
              </span>
              <Shimmer as="span">Thinking…</Shimmer>
            </div>
          )}
          {error && <div className="text-destructive text-xs">{error}</div>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <Composer id={id} transcript={transcript} />
    </div>
  );
}

//#endregion

//#region inspector

function Row(props: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{props.icon}</span>
      <span className="flex-1 text-muted-foreground">{props.label}</span>
      <span className="truncate text-right">{props.value}</span>
    </div>
  );
}

function Inspector({ id }: { id: string }) {
  const { transcript, connected } = useSession(id);
  const now = useNow(transcript.state === "running");
  const { usage } = transcript;
  return (
    <aside className="hidden w-80 shrink-0 p-4 xl:block">
      <div className="rounded-2xl border bg-card">
        <Row icon={<CpuIcon className="size-4" />} label="Container" value={id} />
        <Row icon={<FolderGit2Icon className="size-4" />} label="Workspace" value={WORKDIR} />
        <Row icon={<GitBranchIcon className="size-4" />} label="Branch" value="main" />
        <div className="border-t" />
        <Row
          icon={
            <CircleDotIcon
              className={cn("size-4", connected ? "text-success" : "text-destructive")}
            />
          }
          label="State"
          value={
            <Badge variant="secondary" className="capitalize">
              {transcript.state === "running"
                ? `working ${elapsed(transcript.turnStartedAt, now)}`
                : transcript.state.replace("_", " ")}
            </Badge>
          }
        />
        <Row
          icon={<BotIcon className="size-4" />}
          label="Model"
          value={transcript.model ?? "default"}
        />
        <div className="border-t" />
        <Row
          icon={<span className="text-xs">↑↓</span>}
          label="Tokens"
          value={
            <span className="tabular-nums">
              {(usage.inputTokens + (usage.cacheReadTokens ?? 0)).toLocaleString()} /{" "}
              {usage.outputTokens.toLocaleString()}
            </span>
          }
        />
        <Row
          icon={<span className="text-xs">$</span>}
          label="Cost"
          value={<span className="tabular-nums">${(usage.costUsd ?? 0).toFixed(4)}</span>}
        />
        <Row
          icon={<span className="text-xs">#</span>}
          label="Events"
          value={<span className="tabular-nums">{transcript.cursor}</span>}
        />
      </div>
    </aside>
  );
}

//#endregion

export function App() {
  const [ids, addId] = useSessionIds();
  const [current, setCurrent] = useState<string | undefined>(ids[0]);
  const [inspector, setInspector] = useState(true);

  // Connect to sessions as they are viewed; their status keeps updating in the sidebar.
  useEffect(() => {
    if (current) agents.open(current, MODELS[0]!.id);
  }, [current]);

  const create = () => {
    const id = `session-${Date.now().toString(36)}`;
    addId(id);
    setCurrent(id);
  };

  return (
    <div className="flex h-full">
      <Sidebar ids={ids} current={current} onSelect={setCurrent} onCreate={create} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-sm">
          <span className="text-muted-foreground">coding-agents</span>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium">{current ?? "No session"}</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-8"
            onClick={() => setInspector((v) => !v)}
          >
            <PanelRightIcon className="size-4" />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          {current ? (
            <Chat key={current} id={current} />
          ) : (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Button onClick={create}>
                <PlusIcon className="size-4" /> New session
              </Button>
            </div>
          )}
          {current && inspector && <Inspector id={current} />}
        </div>
      </main>
    </div>
  );
}

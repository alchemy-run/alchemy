import type * as AI from "alchemy/AI/Client";
import {
  BotIcon,
  BrainIcon,
  CircleDotIcon,
  CpuIcon,
  FolderGit2Icon,
  GitBranchIcon,
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PanelRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Machine } from "../../src/rpcs.ts";
import { agents, type ListedSession, listSessions, useSession, useSnapshot } from "./agents.ts";
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
import { SessionTerminal } from "./components/terminal/terminal.tsx";
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

//#region sessions list (kept on the server)

/**
 * Every session, from the server (refreshed every 10 seconds). Sessions
 * created here show at once, before the server lists them.
 */
const useSessionIds = () => {
  const [listed, setListed] = useState<ReadonlyArray<ListedSession>>([]);
  const [created, setCreated] = useState<ReadonlyArray<string>>([]);
  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void listSessions()
        .then((sessions) => {
          if (!cancelled) setListed(sessions);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshes]);
  const listedIds = listed.map((session) => session.id);
  const ids = [...created.filter((id) => !listedIds.includes(id)), ...listedIds];
  // Settled here: shown as settled until the server's list catches up (a
  // new prompt can unsettle it again, so this never outlives that).
  const [settled, setSettled] = useState<Record<string, number>>({});
  const pending = (id: string) => {
    const at = settled[id];
    return at !== undefined && Date.now() - at < 30_000 ? at : undefined;
  };
  const byId: Record<string, ListedSession> = Object.fromEntries(
    listed.map((session) => {
      const at = pending(session.id);
      return [
        session.id,
        at !== undefined && !session.settledAt ? { ...session, settledAt: at } : session,
      ];
    }),
  );
  const add = (id: string) => setCreated((prev) => [id, ...prev.filter((x) => x !== id)]);
  const refresh = () => setRefreshes((n) => n + 1);
  const markSettled = (id: string) => setSettled((prev) => ({ ...prev, [id]: Date.now() }));
  const unmarkSettled = (id: string) => setSettled(({ [id]: _, ...rest }) => rest);
  // Once the server lists a session as settled, it alone decides (so a new
  // prompt that unsettles it shows at once).
  useEffect(() => {
    const confirmed = new Set(
      listed.filter((session) => session.settledAt && settled[session.id]).map((s) => s.id),
    );
    if (confirmed.size > 0) {
      setSettled((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([id]) => !confirmed.has(id))),
      );
    }
  }, [listed]);
  return { ids, listed: byId, add, refresh, markSettled, unmarkSettled };
};

/** How long ago, briefly: "now", "5m", "3h", "2d". */
const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60
    ? "now"
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86_400
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86_400)}d`;
};

const bytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;

const duration = (seconds: number) =>
  seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

/** A running or suspended machine, as a dot. */
function MachineDot({ state }: { state: ListedSession["state"] | undefined }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "running" ? "bg-success" : "bg-muted-foreground/40",
      )}
      title={
        state === "running"
          ? "Machine running"
          : state === "suspended"
            ? "Machine suspended"
            : "Machine state unknown"
      }
      data-testid="machine-dot"
      data-state={state ?? "unknown"}
    />
  );
}

/** The session's machine, polled while shown (with live usage when it runs). */
const useMachine = (id: string) => {
  const [machine, setMachine] = useState<Machine | undefined>();
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      void agents
        .machine(id, true)
        .then((m) => {
          if (!cancelled) setMachine(m);
        })
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, polls]);
  return [machine, setMachine, () => setPolls((n) => n + 1)] as const;
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

/** A session's status as the server last recorded it (not open in this tab). */
function ListedStatus({ agent }: { agent: ListedSession["agent"] }) {
  switch (agent) {
    case "running":
      return <span className="text-info">Working</span>;
    case "awaiting_input":
      return <span className="text-warning">Needs input</span>;
    case undefined:
      return null;
    default:
      return <span className="text-muted-foreground capitalize">{agent}</span>;
  }
}

function SidebarRow(props: {
  id: string;
  listed: ListedSession | undefined;
  active: boolean;
  onSelect: () => void;
  onSettle: () => void;
}) {
  const snapshot = useSnapshot(props.id);
  const now = useNow(snapshot?.transcript.state === "running");
  const cost = snapshot?.transcript.usage.costUsd ?? props.listed?.costUsd;
  return (
    <div className="group relative">
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
          {/* Live when open in this tab; otherwise as the server last recorded it. */}
          {snapshot ? (
            <SessionStatus transcript={snapshot.transcript} now={now} />
          ) : (
            <ListedStatus agent={props.listed?.agent} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <MachineDot state={props.listed?.state} />
          <span className="truncate text-[15px] text-foreground">{props.id}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <FolderGit2Icon className="size-3" />
          <span className="truncate">{WORKDIR}</span>
          {cost ? <span className="ml-auto tabular-nums">${cost.toFixed(3)}</span> : null}
        </div>
      </button>
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-1.5 right-2 hidden h-6 gap-1 bg-sidebar px-2 text-muted-foreground text-xs group-hover:flex"
        onClick={props.onSettle}
        aria-label={`Settle ${props.id}`}
      >
        <ArchiveIcon className="size-3" /> Settle
      </Button>
    </div>
  );
}

/** A settled session: one compact line, out of the way. */
function SettledRow(props: {
  id: string;
  settledAt: number;
  now: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-muted-foreground text-sm transition-colors hover:bg-sidebar-accent",
        props.active && "bg-sidebar-accent text-foreground",
      )}
      data-testid="settled-session"
    >
      <ArchiveIcon className="size-3.5 shrink-0 opacity-70" />
      <span className="flex-1 truncate">{props.id}</span>
      <span className="shrink-0 text-xs tabular-nums">{ago(props.settledAt, props.now)}</span>
    </button>
  );
}

function Sidebar(props: {
  ids: ReadonlyArray<string>;
  listed: Record<string, ListedSession>;
  current: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onSettle: (id: string) => void;
}) {
  const [showSettled, setShowSettled] = useStored("harness:show-settled", false);
  const now = useNow(true);
  const active = props.ids.filter((id) => !props.listed[id]?.settledAt);
  const settled = props.ids
    .filter((id) => props.listed[id]?.settledAt)
    .sort((a, b) => props.listed[b]!.settledAt! - props.listed[a]!.settledAt!);
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
      {/* Two panes: active sessions scroll on their own, and Settled is always
          at the bottom — collapsed to its header, or open at its own height. */}
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {active.map((id) => (
          <SidebarRow
            key={id}
            id={id}
            listed={props.listed[id]}
            active={id === props.current}
            onSelect={() => props.onSelect(id)}
            onSettle={() => props.onSettle(id)}
          />
        ))}
      </nav>
      {settled.length > 0 && (
        <div
          className={cn("flex shrink-0 flex-col border-t px-2 pt-2", showSettled && "h-[40%]")}
          data-testid="settled"
        >
          <button
            type="button"
            onClick={() => setShowSettled((open) => !open)}
            className="flex w-full shrink-0 items-center gap-2 px-3 py-1.5 text-muted-foreground text-xs"
          >
            <span>
              Settled <span className="tabular-nums">({settled.length})</span>
            </span>
            <span className="h-px flex-1 bg-border" />
            {showSettled ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </button>
          {showSettled && (
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2">
              {settled.map((id) => (
                <SettledRow
                  key={id}
                  id={id}
                  settledAt={props.listed[id]!.settledAt!}
                  now={now}
                  active={id === props.current}
                  onSelect={() => props.onSelect(id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
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

/** The machine behind the session, with a pause / resume button. */
function MachineSection({ id, onChange }: { id: string; onChange: () => void }) {
  const [machine, setMachine, poll] = useMachine(id);
  const [busy, setBusy] = useState(false);
  const running = machine?.state === "running";
  const toggle = () => {
    setBusy(true);
    void (running ? agents.suspend(id) : agents.resume(id))
      .then(setMachine)
      .catch(() => {})
      .finally(() => {
        setBusy(false);
        poll();
        onChange();
      });
  };
  return (
    <div data-testid="machine">
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <MachineDot state={machine?.state} />
        <span className="flex-1 font-medium" data-testid="machine-state">
          {machine === undefined
            ? "Machine"
            : busy
              ? running
                ? "Suspending…"
                : "Resuming…"
              : running
                ? "Running"
                : "Suspended"}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1.5"
          disabled={machine === undefined || busy}
          onClick={toggle}
          data-testid="machine-toggle"
        >
          {running ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          {running ? "Pause" : "Resume"}
        </Button>
      </div>
      {machine && (
        <>
          <Row icon={<CpuIcon className="size-4" />} label="Platform" value={machine.platform} />
          <Row
            icon={<span className="text-xs">▣</span>}
            label="Instance"
            value={`${machine.instance} · ${machine.vcpus} vCPU`}
          />
          <Row
            icon={<span className="text-xs">≡</span>}
            label="Memory"
            value={
              <span className="tabular-nums">
                {machine.usage ? `${bytes(machine.usage.memoryUsedBytes)} / ` : ""}
                {bytes(machine.memoryBytes)}
              </span>
            }
          />
          <Row
            icon={<span className="text-xs">◫</span>}
            label="Disk"
            value={
              <span className="tabular-nums">
                {machine.usage ? `${bytes(machine.usage.diskUsedBytes)} / ` : ""}
                {bytes(machine.diskBytes)}
              </span>
            }
          />
          <Row
            icon={<span className="text-xs">⌖</span>}
            label="Location"
            value={machine.location ?? "—"}
          />
          {machine.usage && (
            <Row
              icon={<span className="text-xs">◷</span>}
              label="Uptime"
              value={<span className="tabular-nums">{duration(machine.usage.uptimeSeconds)}</span>}
            />
          )}
        </>
      )}
    </div>
  );
}

function Inspector({ id, onMachineChange }: { id: string; onMachineChange: () => void }) {
  const { transcript, connected } = useSession(id);
  const now = useNow(transcript.state === "running");
  const { usage } = transcript;
  return (
    <aside className="hidden w-80 shrink-0 p-4 xl:block">
      <div className="rounded-2xl border bg-card">
        <MachineSection id={id} onChange={onMachineChange} />
        <div className="border-t" />
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

//#region terminal panel

const TERMINAL_OPEN = "harness:terminal-open";
const TERMINAL_HEIGHT = "harness:terminal-height";

/** A setting kept across reloads. */
const useStored = <A,>(key: string, initial: A) => {
  const [value, setValue] = useState<A>(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : (JSON.parse(stored) as A);
  });
  useEffect(() => localStorage.setItem(key, JSON.stringify(value)), [key, value]);
  return [value, setValue] as const;
};

/** The session's shell, docked under the conversation; drag its top edge to resize. */
function TerminalPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [height, setHeight] = useStored(TERMINAL_HEIGHT, 280);

  const resize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (e: PointerEvent) =>
      setHeight(
        Math.round(
          Math.min(Math.max(startHeight + startY - e.clientY, 120), window.innerHeight * 0.8),
        ),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className="relative flex shrink-0 flex-col border-t bg-[#0a0a0a]"
      style={{ height }}
      data-testid="terminal-panel"
    >
      <div
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
        onPointerDown={resize}
      />
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1 right-2 z-10 size-6 text-muted-foreground"
        onClick={onClose}
        aria-label="Close terminal"
      >
        <XIcon className="size-3.5" />
      </Button>
      <div className="min-h-0 flex-1">
        <SessionTerminal key={id} sessionId={id} />
      </div>
    </div>
  );
}

//#endregion

export function App() {
  const {
    ids,
    listed,
    add: addId,
    refresh: refreshSessions,
    markSettled,
    unmarkSettled,
  } = useSessionIds();
  const settle = (id: string) => {
    markSettled(id);
    void agents
      .settle(id)
      // Didn't settle: put it back.
      .catch(() => unmarkSettled(id))
      .finally(refreshSessions);
  };
  // The open session is in the URL, so a reload (or a link) opens it again.
  const [current, setCurrentState] = useState<string | undefined>(
    () => decodeURIComponent(location.hash.slice(1)) || undefined,
  );
  const setCurrent = (id: string | undefined) => {
    setCurrentState(id);
    history.replaceState(null, "", id ? `#${encodeURIComponent(id)}` : location.pathname);
  };
  // Follow the URL when only its hash changes (a pasted link, back / forward).
  useEffect(() => {
    const onHashChange = () =>
      setCurrentState(decodeURIComponent(location.hash.slice(1)) || undefined);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  // Nothing in the URL: open the newest session once the list arrives.
  useEffect(() => {
    if (current === undefined && ids[0] !== undefined) setCurrent(ids[0]);
  }, [current, ids[0]]);
  const [inspector, setInspector] = useState(true);
  const [terminalOpen, setTerminalOpen] = useStored(TERMINAL_OPEN, false);

  // Ctrl+` toggles the terminal, as in VS Code and T3 Code.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        setTerminalOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTerminalOpen]);

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
      <Sidebar
        ids={ids}
        listed={listed}
        current={current}
        onSelect={setCurrent}
        onCreate={create}
        onSettle={settle}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-sm">
          <span className="text-muted-foreground">coding-agents</span>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium">{current ?? "No session"}</span>
          {current &&
            (listed[current]?.settledAt ? (
              <span className="ml-auto flex items-center gap-1.5 text-muted-foreground text-xs">
                <ArchiveIcon className="size-3.5" /> Settled
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-8 gap-1.5 text-muted-foreground"
                onClick={() => settle(current)}
                data-testid="settle"
              >
                <ArchiveIcon className="size-3.5" /> Settle
              </Button>
            ))}
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-8", !current && "ml-auto")}
            onClick={() => setTerminalOpen((open) => !open)}
            aria-label="Toggle terminal"
            aria-pressed={terminalOpen}
            disabled={!current}
          >
            <TerminalIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
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
          {current && inspector && <Inspector id={current} onMachineChange={refreshSessions} />}
        </div>
        {current && terminalOpen && (
          <TerminalPanel id={current} onClose={() => setTerminalOpen(false)} />
        )}
      </main>
    </div>
  );
}

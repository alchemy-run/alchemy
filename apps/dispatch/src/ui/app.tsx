import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConvEntry,
  ServerEvent,
  TaskCard,
  TaskQuestion,
} from "../types.ts";

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

interface DispatchState {
  conversation: ConvEntry[];
  tasks: Record<string, TaskCard>;
  connected: boolean;
}

function useDispatch(): DispatchState {
  const [state, setState] = useState<DispatchState>({
    conversation: [],
    tasks: {},
    connected: false,
  });

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => setState((s) => ({ ...s, connected: true }));
    source.onerror = () => setState((s) => ({ ...s, connected: false }));
    source.onmessage = (raw) => {
      const event = JSON.parse(raw.data) as ServerEvent;
      setState((s) => {
        switch (event.type) {
          case "snapshot": {
            const tasks: Record<string, TaskCard> = {};
            for (const card of event.tasks) tasks[card.id] = card;
            return { ...s, conversation: event.conversation, tasks };
          }
          case "conv": {
            const conversation = [...s.conversation];
            const i = conversation.findIndex((e) => e.id === event.entry.id);
            if (i === -1) conversation.push(event.entry);
            else conversation[i] = event.entry;
            return { ...s, conversation };
          }
          case "conv-remove":
            return {
              ...s,
              conversation: s.conversation.filter((e) => e.id !== event.id),
            };
          case "task":
            return { ...s, tasks: { ...s.tasks, [event.card.id]: event.card } };
          default:
            return s;
        }
      });
    };
    return () => source.close();
  }, []);

  return state;
}

async function post(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<TaskCard["status"], string> = {
  starting: "starting",
  running: "running",
  needs_input: "needs you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

function minutesSince(from: number, to?: number | null): string {
  const ms = (to ?? Date.now()) - from;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/** parse "fix(r2): bound retry schedule" into colored tokens */
function TitleTokens({ title }: { title: string }) {
  const match = title.match(/^(\w+)(\(([^)]+)\))?(!)?:\s*(.*)$/);
  if (!match) return <span className="tt-rest">{title}</span>;
  const [, type, , scope, bang, rest] = match;
  return (
    <>
      <span className={`tt-type tt-${type}`}>{type}</span>
      {scope ? <span className="tt-scope">({scope})</span> : null}
      {bang ? <span className="tt-bang">!</span> : null}
      <span className="tt-colon">: </span>
      <span className="tt-rest">{rest}</span>
    </>
  );
}

function DiffStatView({ card }: { card: TaskCard }) {
  if (!card.diff || (card.diff.additions === 0 && card.diff.deletions === 0)) {
    return null;
  }
  return (
    <span className="diffstat">
      <span className="add">+{card.diff.additions}</span>{" "}
      <span className="del">−{card.diff.deletions}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* task card                                                           */
/* ------------------------------------------------------------------ */

function QuestionBlock({ card, question }: { card: TaskCard; question: TaskQuestion }) {
  const [custom, setCustom] = useState("");
  const answer = (value: string) =>
    post(`/api/tasks/${card.id}/answer`, { questionId: question.id, value });

  return (
    <div className={`ask ${question.kind}`}>
      <p className="q">{question.text}</p>
      <div className="opts">
        {question.options.map((option) => (
          <button
            key={option.label}
            className="opt"
            onClick={() => answer(option.label)}
          >
            <b>{option.label}</b>
            {option.description ? <span className="hint">{option.description}</span> : null}
          </button>
        ))}
      </div>
      {question.freeform ? (
        <form
          className="freeform"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) answer(custom.trim());
          }}
        >
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Or type an answer…"
            aria-label="Custom answer"
          />
        </form>
      ) : null}
    </div>
  );
}

function TaskRow({ card }: { card: TaskCard }) {
  const [open, setOpen] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [followUpText, setFollowUpText] = useState("");
  const attention = card.status === "needs_input";

  // a blocked task demands eyes: pop it open
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);

  const active = card.status === "running" || card.status === "starting";

  return (
    <section className={`card ${attention ? "wait-state" : ""} ${open ? "open" : ""}`}>
      <button
        className="card-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={`sdot ${card.status}`} aria-hidden="true" />
        <span className="card-title" title={card.title}>
          <TitleTokens title={card.title} />
        </span>
        <span className="line-meta">
          <DiffStatView card={card} />
          <span className={`status-word ${card.status}`}>{STATUS_LABEL[card.status]}</span>
          <span className="dur">{minutesSince(card.startedAt, active ? null : card.endedAt)}</span>
          <span className="chev" aria-hidden="true">▸</span>
        </span>
      </button>

      {open ? (
        <div className="card-body">
          <div className="card-sub">
            <span className="agent">{card.agent}</span>
            <span className="cwd" title={card.cwd}>{card.cwd.split("/").slice(-2).join("/")}</span>
            {card.filesTouched.length > 0 ? <span>{card.filesTouched.length} files</span> : null}
            {card.turns ? <span>{card.turns} turns</span> : null}
            {card.costUsd ? <span>${card.costUsd.toFixed(2)}</span> : null}
          </div>

          <div className="card-activity">{card.activity}</div>

          {card.question ? <QuestionBlock card={card} question={card.question} /> : null}

          {card.status === "done" && card.summary ? (
            <div className="summary">{card.summary}</div>
          ) : null}

          {card.transcript.length > 0 ? (
            <div className="peek">
              <div className="peek-label">
                thread · last {Math.min(6, card.transcript.length)} of {card.transcript.length}
              </div>
              {card.transcript.slice(-6).map((entry, i) => (
                <div className="pm" key={i}>
                  <span className={`pwho ${entry.role}`}>
                    {entry.role === "dispatch" ? "dispatch ›" : entry.role}
                  </span>
                  <span className="ptext">{entry.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="card-foot">
            {followUp ? (
              <form
                className="followup"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!followUpText.trim()) return;
                  void post(`/api/tasks/${card.id}/message`, { text: followUpText.trim() });
                  setFollowUpText("");
                  setFollowUp(false);
                }}
              >
                <input
                  autoFocus
                  value={followUpText}
                  onChange={(e) => setFollowUpText(e.target.value)}
                  placeholder="Message this task…"
                  aria-label="Message this task"
                />
              </form>
            ) : (
              <>
                <button className="chip-btn" onClick={() => setFollowUp(true)}>
                  Message task
                </button>
                {active || attention ? (
                  <button
                    className="chip-btn danger"
                    onClick={() => void post(`/api/tasks/${card.id}/stop`, {})}
                  >
                    Stop
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* conversation                                                        */
/* ------------------------------------------------------------------ */

function Entry({ entry, tasks }: { entry: ConvEntry; tasks: Record<string, TaskCard> }) {
  if (entry.role === "user") {
    return (
      <div className="msg user">
        <div className="body">
          {entry.parts.map((part, i) =>
            part.t === "text" ? <p key={i}>{part.text}</p> : null,
          )}
        </div>
      </div>
    );
  }
  if (entry.role === "system") {
    return (
      <div className="sysnote">
        {entry.parts.map((part) => (part.t === "text" ? part.text : "")).join("")}
      </div>
    );
  }
  return (
    <div className="msg orch">
      <div className="avatar" aria-hidden="true" />
      <div className="body">
        <div className="who">Dispatch</div>
        {entry.parts.map((part, i) =>
          part.t === "text" ? (
            <p key={i} className="orch-text">
              {part.text}
              {!entry.done && i === entry.parts.length - 1 ? (
                <span className="cursor" aria-hidden="true" />
              ) : null}
            </p>
          ) : tasks[part.taskId] ? (
            <TaskRow key={part.taskId} card={tasks[part.taskId]!} />
          ) : (
            <div key={i} className="sysnote">
              starting task…
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* app                                                                 */
/* ------------------------------------------------------------------ */

export function App() {
  const { conversation, tasks, connected } = useDispatch();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const ticker = useMemo(() => {
    const cards = Object.values(tasks);
    return {
      running: cards.filter((c) => c.status === "running" || c.status === "starting").length,
      waiting: cards.filter((c) => c.status === "needs_input").length,
      done: cards.filter((c) => c.status === "done").length,
    };
  }, [tasks]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [conversation, tasks]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void post("/api/message", { text });
    setDraft("");
    stick.current = true;
  };

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <div className="logo" aria-hidden="true" />
          <h1>Dispatch</h1>
          <span className={`conn ${connected ? "ok" : "down"}`}>
            {connected ? "live" : "reconnecting…"}
          </span>
        </div>
        <div className="ticker">
          {ticker.running > 0 ? (
            <span className="tick run"><span className="dot" />{ticker.running} running</span>
          ) : null}
          {ticker.waiting > 0 ? (
            <span className="tick wait"><span className="dot" />{ticker.waiting} needs you</span>
          ) : null}
          {ticker.done > 0 ? (
            <span className="tick done"><span className="dot" />{ticker.done} done</span>
          ) : null}
        </div>
      </header>

      <div
        className="scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="thread">
          {conversation.length === 0 ? (
            <div className="empty">
              <div className="empty-logo" aria-hidden="true" />
              <h2>One agent for all your threads.</h2>
              <p>
                Describe work and Dispatch spawns coding-agent tasks that show up
                as live cards right here — no thread list to babysit.
              </p>
            </div>
          ) : (
            conversation.map((entry) => (
              <Entry key={entry.id} entry={entry} tasks={tasks} />
            ))
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <div className="composer-box">
            <textarea
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Talk to Dispatch — it runs the threads so you don't have to…"
              aria-label="Message Dispatch"
            />
            <button className="send" onClick={send} aria-label="Send">↑</button>
          </div>
        </div>
      </div>
    </div>
  );
}

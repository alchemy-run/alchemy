import React from "react";
import ReactDOM from "react-dom/client";
import * as api from "./api.ts";
import type { SessionEvent } from "./api.ts";
import "./styles.css";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { id: "claude-opus-4-5", label: "Opus 4.5" },
];

/** One row of the transcript, folded from the event log. */
type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "reasoning"; key: string; text: string }
  | { kind: "tool"; key: string; title: string; status: "running" | "ok" | "error" }
  | { kind: "note"; key: string; text: string; error?: boolean };

interface View {
  items: Item[];
  state: string;
  model: string | undefined;
  cost: number;
}

const empty: View = { items: [], state: "new", model: undefined, cost: 0 };

const text = (content: ReadonlyArray<{ type: string; text?: string }>) =>
  content.map((c) => c.text ?? "").join("");

/** Fold one event into the view (events arrive in log order). */
const reduce = (view: View, e: SessionEvent): View => {
  const items = view.items;
  const upsert = (key: string, f: (prev: Item | undefined) => Item): Item[] => {
    const i = items.findIndex((item) => item.key === key);
    return i === -1 ? [...items, f(undefined)] : items.with(i, f(items[i]));
  };
  switch (e.type) {
    case "state":
      return { ...view, state: e.state };
    case "turn.started":
      return { ...view, state: "running" };
    case "message.completed":
      return e.role === "user"
        ? { ...view, items: [...items, { kind: "user", key: e.itemId, text: text(e.content) }] }
        : view;
    case "message.delta":
      return {
        ...view,
        items: upsert(e.itemId, (prev) => ({
          kind: "assistant",
          key: e.itemId,
          text: (prev?.kind === "assistant" ? prev.text : "") + e.text,
        })),
      };
    case "reasoning.delta":
      return {
        ...view,
        items: upsert(`r:${e.itemId}`, (prev) => ({
          kind: "reasoning",
          key: `r:${e.itemId}`,
          text: (prev?.kind === "reasoning" ? prev.text : "") + e.text,
        })),
      };
    case "tool.started":
      return {
        ...view,
        items: upsert(`t:${e.itemId}`, () => ({
          kind: "tool",
          key: `t:${e.itemId}`,
          title: e.tool.title,
          status: "running",
        })),
      };
    case "tool.completed":
      return {
        ...view,
        items: upsert(`t:${e.itemId}`, (prev) => ({
          kind: "tool",
          key: `t:${e.itemId}`,
          title: prev?.kind === "tool" ? prev.title : "tool",
          status: e.status,
        })),
      };
    case "model.changed":
      return {
        ...view,
        model: e.model,
        items: [...items, { kind: "note", key: `m:${e.cursor}`, text: `switched to ${e.model}` }],
      };
    case "error":
      return {
        ...view,
        items: [...items, { kind: "note", key: `e:${e.cursor}`, text: e.message, error: true }],
      };
    case "turn.completed":
      return {
        ...view,
        state: "idle",
        cost: view.cost + (e.result.usage.costUsd ?? 0),
        items:
          e.result.status === "completed"
            ? items
            : [
                ...items,
                {
                  kind: "note",
                  key: `c:${e.cursor}`,
                  text: `turn ${e.result.status}${e.result.error ? `: ${e.result.error}` : ""}`,
                  error: e.result.status === "failed",
                },
              ],
      };
    default:
      return view;
  }
};

/** A session's live view: replays its log, then follows it. */
const useSession = (id: string) => {
  const [view, setView] = React.useState<View>(empty);
  React.useEffect(() => {
    setView(empty);
    void api.info(id).then((info) => {
      if (info) setView((v) => ({ ...v, model: v.model ?? info.model }));
    });
    const stop = api.follow(id, (event) => setView((v) => reduce(v, event)));
    return () => stop();
  }, [id]);
  return view;
};

const useSessions = () => {
  const [sessions, setSessions] = React.useState<string[]>(() =>
    JSON.parse(localStorage.getItem("sessions") ?? "[]"),
  );
  const add = (id: string) =>
    setSessions((prev) => {
      const next = prev.includes(id) ? prev : [id, ...prev];
      localStorage.setItem("sessions", JSON.stringify(next));
      return next;
    });
  return [sessions, add] as const;
};

function Session({ id }: { id: string }) {
  const view = useSession(id);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string>();
  const end = React.useRef<HTMLDivElement>(null);
  const running = view.state === "running" || view.state === "awaiting_input";

  React.useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [view.items]);

  const act = (f: () => Promise<unknown>) => {
    setError(undefined);
    f().catch((e: unknown) => setError(String(e)));
  };
  const send = () => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    act(() => (running ? api.steer(id, message) : api.prompt(id, message)));
  };

  return (
    <section className="session">
      <header>
        <h2>{id}</h2>
        <span className={`badge ${view.state}`}>{view.state}</span>
        <select
          value={view.model ?? MODELS[0]!.id}
          onChange={(e) => act(() => api.setModel(id, e.target.value))}
          disabled={view.state === "new"}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="cost">${view.cost.toFixed(4)}</span>
      </header>

      <div className="transcript">
        {view.items.length === 0 && (
          <p className="hint">Ask the agent to do something in the repository.</p>
        )}
        {view.items.map((item) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={item.key} className="msg user">
                  {item.text}
                </div>
              );
            case "assistant":
              return (
                <div key={item.key} className="msg assistant">
                  {item.text}
                </div>
              );
            case "reasoning":
              return (
                <details key={item.key} className="reasoning">
                  <summary>thinking</summary>
                  {item.text}
                </details>
              );
            case "tool":
              return (
                <div key={item.key} className={`tool ${item.status}`}>
                  <span>{item.status === "running" ? "⋯" : item.status === "ok" ? "✓" : "✗"}</span>
                  <code>{item.title}</code>
                </div>
              );
            case "note":
              return (
                <div key={item.key} className={`note${item.error ? " error" : ""}`}>
                  {item.text}
                </div>
              );
          }
        })}
        <div ref={end} />
      </div>

      {error && <div className="note error">{error}</div>}
      <footer>
        <textarea
          value={draft}
          placeholder={running ? "Steer the running turn…" : "Message the agent…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="actions">
          <button onClick={send} disabled={!draft.trim()}>
            {running ? "Steer" : "Send"}
          </button>
          {running && (
            <button className="secondary" onClick={() => act(() => api.interrupt(id))}>
              Interrupt
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

function App() {
  const [sessions, addSession] = useSessions();
  const [current, setCurrent] = React.useState<string | undefined>(sessions[0]);
  const [name, setName] = React.useState("");

  const create = () => {
    const id = name.trim().replace(/[^\w-]/g, "-") || `session-${Date.now().toString(36)}`;
    addSession(id);
    setCurrent(id);
    setName("");
  };

  return (
    <div className="app">
      <aside>
        <h1>Coding Agents</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input value={name} placeholder="new session" onChange={(e) => setName(e.target.value)} />
          <button type="submit">+</button>
        </form>
        <nav>
          {sessions.map((id) => (
            <button
              key={id}
              className={id === current ? "active" : ""}
              onClick={() => setCurrent(id)}
            >
              {id}
            </button>
          ))}
        </nav>
        <p className="hint">Each session runs in its own container.</p>
      </aside>
      <main>
        {current ? (
          <Session key={current} id={current} />
        ) : (
          <p className="hint">Create a session to start.</p>
        )}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

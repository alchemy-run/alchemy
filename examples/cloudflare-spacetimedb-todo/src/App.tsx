import { useCallback, useRef, useState } from "react";
import {
  useReducer,
  useSpacetimeDB,
  useTable,
} from "spacetimedb/react";
import { reducers, tables } from "./module_bindings/index.ts";

const apiUrl = import.meta.env.VITE_API_URL || "";

export function App() {
  const { isActive } = useSpacetimeDB();
  const [todos, ready] = useTable(tables.todo);
  const [activity] = useTable(tables.activity);
  const addTodo = useReducer(reducers.addTodo);
  const toggleTodo = useReducer(reducers.toggleTodo);
  const removeTodo = useReducer(reducers.removeTodo);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const value = text.trim();
      if (!value || busy) return;
      setBusy(true);
      try {
        let attachmentKey: string | undefined;
        const file = fileRef.current?.files?.[0];
        if (file && apiUrl) {
          const res = await fetch(
            `${apiUrl}/upload?filename=${encodeURIComponent(file.name)}`,
            {
              method: "PUT",
              headers: {
                "content-type": file.type || "application/octet-stream",
              },
              body: file,
            },
          );
          if (!res.ok) throw new Error(`upload failed: ${res.status}`);
          const json = (await res.json()) as { key: string };
          attachmentKey = json.key;
        }
        await addTodo({ text: value, attachmentKey });
        setText("");
        if (fileRef.current) fileRef.current.value = "";
      } catch (err) {
        console.error(err);
        alert(String(err));
      } finally {
        setBusy(false);
      }
    },
    [addTodo, busy, text],
  );

  const recent = [...activity]
    .sort((a, b) => Number(b.at.microsSinceUnixEpoch - a.at.microsSinceUnixEpoch))
    .slice(0, 10);

  return (
    <main className="app">
      <header>
        <h1>Alchemy × SpacetimeDB</h1>
        <p className="sub">
          Real-time todos — state lives in SpacetimeDB tables, UI is a live
          replica. Optional attachments go to R2 via a Cloudflare Worker.
        </p>
        <p className={`status ${isActive ? "on" : "off"}`}>
          {isActive ? "connected" : "connecting…"}
          {!ready && isActive ? " · loading rows" : ""}
        </p>
        {import.meta.env.VITE_SPACETIMEDB_DASHBOARD_URL ? (
          <p className="dash">
            <a
              href={import.meta.env.VITE_SPACETIMEDB_DASHBOARD_URL}
              target="_blank"
              rel="noreferrer"
            >
              Open SpacetimeDB dashboard ↗
            </a>
          </p>
        ) : null}
      </header>

      <form className="composer" onSubmit={onSubmit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What needs doing?"
          autoFocus
        />
        <input ref={fileRef} type="file" accept="image/*,.pdf,.txt" />
        <button type="submit" disabled={busy || !text.trim()}>
          Add
        </button>
      </form>

      <ul className="list">
        {[...todos]
          .sort((a, b) => Number(b.id) - Number(a.id))
          .map((todo) => (
            <li key={String(todo.id)} className={todo.done ? "done" : ""}>
              <button
                type="button"
                className="check"
                onClick={() => toggleTodo({ id: todo.id })}
                aria-label="toggle"
              >
                {todo.done ? "✓" : "○"}
              </button>
              <span className="text">{todo.text}</span>
              {todo.attachmentKey ? (
                <a
                  className="attach"
                  href={
                    apiUrl
                      ? `${apiUrl}/file/${encodeURIComponent(todo.attachmentKey)}`
                      : undefined
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  📎
                </a>
              ) : null}
              <button
                type="button"
                className="x"
                onClick={() => removeTodo({ id: todo.id })}
                aria-label="delete"
              >
                ×
              </button>
            </li>
          ))}
      </ul>

      {ready && todos.length === 0 ? (
        <p className="empty">No todos yet — add one above.</p>
      ) : null}

      <section className="activity">
        <h2>Recent activity</h2>
        {recent.length === 0 ? (
          <p className="empty">No activity yet.</p>
        ) : (
          <ul>
            {recent.map((a, i) => (
              <li key={i}>
                <span className="msg">{a.message}</span>
                <time>{new Date(Number(a.at.microsSinceUnixEpoch) / 1000).toLocaleTimeString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

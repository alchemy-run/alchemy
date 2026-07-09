/**
 * The whole client is stock `useChat` — the server speaks the AI SDK
 * UI message stream verbatim, so there is no custom transport, no
 * adapter, nothing agent-specific here except rendering two part
 * kinds: `dynamic-tool` (the kernel's tool calls) and `data-ask`
 * (the Ask protocol's approval card, answered via the control plane).
 */
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";

type AskData = {
  askId: string;
  status: "pending" | "answered";
  payload: { kind: string; text: string };
  verdict?: string;
};

const answerAsk = (askId: string, verdict: "approved" | "denied") =>
  fetch(`/api/asks/${encodeURIComponent(askId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict }),
  });

function AskCard({ data }: { data: AskData }) {
  return (
    <div className="card ask">
      <div className="card-title">
        {data.status === "pending" ? "approval needed" : `ask ${data.verdict}`}
      </div>
      <div className="card-body">{data.payload.text}</div>
      {data.status === "pending" && (
        <div className="ask-actions">
          <button onClick={() => answerAsk(data.askId, "approved")}>
            Approve
          </button>
          <button
            className="deny"
            onClick={() => answerAsk(data.askId, "denied")}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

function ToolCard(part: {
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}) {
  return (
    <div className="card tool">
      <div className="card-title">
        {part.toolName} <span className="state">{part.state}</span>
      </div>
      <div className="card-body mono">
        {JSON.stringify(part.input)}
        {part.output !== undefined && <> → {JSON.stringify(part.output)}</>}
        {part.errorText !== undefined && <> ✗ {part.errorText}</>}
      </div>
    </div>
  );
}

const suggestions = [
  "wager 10 coins on a d20",
  "wager 100 coins on a d6", // over the approval threshold — parks an ask
  "roll two d8s and tell me if I beat a 10",
  "what games can we play here?",
];

export function App() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  return (
    <div className="chat">
      <header>
        <h1>the dice parlor</h1>
        <span className="status">{status}</span>
      </header>
      <main>
        {messages.length === 0 && (
          <div className="suggestions">
            <p className="suggestions-hint">
              The croupier is at the table. Try one of these:
            </p>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                className="suggestion"
                onClick={() => sendMessage({ text: suggestion })}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.parts.map((part, index) => {
              if (part.type === "text") {
                return <p key={index}>{part.text}</p>;
              }
              if (part.type === "dynamic-tool") {
                return <ToolCard key={index} {...(part as object)} />;
              }
              if (part.type === "data-ask") {
                return (
                  <AskCard
                    key={(part as { id?: string }).id ?? index}
                    data={(part as { data: AskData }).data}
                  />
                );
              }
              return null;
            })}
          </div>
        ))}
      </main>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim().length === 0) return;
          sendMessage({ text: input });
          setInput("");
        }}
      >
        <input
          value={input}
          placeholder="wager 10 coins on a d20…"
          onChange={(event) => setInput(event.currentTarget.value)}
        />
        <button type="submit" disabled={status !== "ready"}>
          Send
        </button>
      </form>
    </div>
  );
}

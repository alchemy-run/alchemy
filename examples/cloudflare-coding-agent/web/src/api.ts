import type { SessionEvent, SessionInfo } from "alchemy/AI";

export type { SessionEvent, SessionInfo };

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:1337";

const agent = (id: string, path = "") => `${API_URL}/agents/${encodeURIComponent(id)}${path}`;

const post = async (url: string, body?: unknown) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res;
};

/** Start the session if needed and begin a turn (returns once it has started). */
export const prompt = (id: string, text: string) =>
  post(`${agent(id)}?wait=false`, { prompt: text });

export const steer = (id: string, text: string) => post(agent(id, "/steer"), { prompt: text });

export const interrupt = (id: string) => post(agent(id, "/interrupt"));

export const setModel = (id: string, model: string) => post(agent(id, "/model"), { model });

export const info = async (id: string): Promise<SessionInfo | undefined> => {
  const res = await fetch(agent(id));
  return res.ok ? ((await res.json()) as SessionInfo) : undefined;
};

/**
 * Follow a session's events. `EventSource` reconnects on its own and resumes
 * from the last cursor (`Last-Event-ID`), so a dropped connection never
 * loses or repeats an event.
 */
export const follow = (id: string, onEvent: (event: SessionEvent) => void) => {
  const source = new EventSource(agent(id, "/events"));
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as SessionEvent);
  return () => source.close();
};

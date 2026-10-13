import { expect, test } from "@playwright/test";

const API_URL = process.env.API_URL ?? "http://localhost:1338";

/** A fresh session per test (sessions are cheap; their ids are not reused). */
const sessionId = (name: string) => `e2e-${name}-${Date.now().toString(36)}`;

interface TurnResult {
  readonly status: string;
  readonly message: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

const text = (result: TurnResult) =>
  result.message.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");

test("a prompt runs a turn and returns its result", async ({ request }) => {
  const id = sessionId("prompt");
  const res = await request.post(`${API_URL}/agents/${id}`, {
    data: { prompt: "Reply with exactly the word: pong" },
    timeout: 5 * 60_000,
  });
  expect(res.status(), await res.text()).toBe(200);
  const result = (await res.json()) as TurnResult;
  expect(result.status).toBe("completed");
  expect(text(result).toLowerCase()).toContain("pong");

  const info = await (await request.get(`${API_URL}/agents/${id}`)).json();
  expect(info).toMatchObject({ id, state: "idle" });
  expect(info.cursor).toBeGreaterThan(0);
});

test("the agent works in its own checkout of the repository", async ({ request }) => {
  const id = sessionId("repo");
  const res = await request.post(`${API_URL}/agents/${id}`, {
    data: {
      prompt:
        "Run `git remote get-url origin` and `git branch --show-current`, then reply with only their two outputs, one per line.",
    },
    timeout: 5 * 60_000,
  });
  expect(res.status(), await res.text()).toBe(200);
  const reply = text((await res.json()) as TurnResult);
  expect(reply).toContain("alchemy-run/alchemy");
  // Under `alchemy dev` each session works on its own worktree branch.
  if (API_URL.includes("localhost")) expect(reply).toContain(`session/${id}`);
});

test("the model can be switched mid-session", async ({ request }) => {
  const id = sessionId("model");
  const first = await request.post(`${API_URL}/agents/${id}`, {
    data: { prompt: "Reply with exactly: one" },
    timeout: 5 * 60_000,
  });
  expect(first.status(), await first.text()).toBe(200);

  const model = "claude-sonnet-4-5";
  const switched = await request.post(`${API_URL}/agents/${id}/model`, { data: { model } });
  expect(switched.status(), await switched.text()).toBe(202);
  const info = await (await request.get(`${API_URL}/agents/${id}`)).json();
  expect(info.model).toBe(model);

  const second = await request.post(`${API_URL}/agents/${id}`, {
    data: { prompt: "Reply with exactly: two" },
    timeout: 5 * 60_000,
  });
  expect(second.status(), await second.text()).toBe(200);
  expect(((await second.json()) as TurnResult).status).toBe("completed");
});

test("events replay as server-sent events from a cursor", async ({ request }) => {
  const id = sessionId("events");
  const res = await request.post(`${API_URL}/agents/${id}`, {
    data: { prompt: "Reply with exactly: hello" },
    timeout: 5 * 60_000,
  });
  expect(res.status(), await res.text()).toBe(200);

  // The stream stays open for live events: read until the turn's end replays.
  const abort = new AbortController();
  const stream = await fetch(`${API_URL}/agents/${id}/events?after=0`, { signal: abort.signal });
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
  const types: string[] = [];
  let buffer = "";
  while (!types.includes("turn.completed")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const frames = buffer.split("\n\n");
    buffer = frames.pop()!;
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) types.push(JSON.parse(data.slice(6)).type);
    }
  }
  abort.abort();
  expect(types).toContain("message.completed");
  expect(types).toContain("turn.completed");
});

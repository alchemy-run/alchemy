import { expect, test } from "@playwright/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { API_URL, Api, listed, run, settleCreated, text, turn } from "./api.ts";

// Every session a test starts is settled after it: no machine is left running.
test.afterEach(settleCreated);

/** A fresh session per test (sessions are cheap; their ids are not reused). */
const sessionId = (name: string) => `e2e-${name}-${Date.now().toString(36)}`;

test("a prompt runs a turn and returns its result", async () => {
  const id = sessionId("prompt");
  const result = await run(turn(id, "Reply with exactly the word: pong"));
  expect(result.status).toBe("completed");
  expect(text(result).toLowerCase()).toContain("pong");

  const info = await run(Api.use((api) => api.info({ sessionId: id })));
  expect(info).toMatchObject({ id, state: "idle" });
  expect(info.cursor).toBeGreaterThan(0);
});

test("sessions are listed by the server", async () => {
  const id = sessionId("listed");
  await run(turn(id, "Reply with exactly the word: listed"));
  expect(await run(listed(id))).toMatchObject({ id });
});

test("the agent works in its own checkout of the repository", async () => {
  const id = sessionId("repo");
  const reply = text(
    await run(
      turn(
        id,
        "Run `git remote get-url origin` and `git branch --show-current`, then reply with only their two outputs, one per line.",
      ),
    ),
  );
  expect(reply).toContain("alchemy-run/alchemy");
  // Under `alchemy dev` each session works on its own worktree branch.
  if (API_URL.includes("localhost")) expect(reply).toContain(`session/${id}`);
});

test("the model can be switched mid-session", async () => {
  const id = sessionId("model");
  await run(turn(id, "Reply with exactly: one"));

  const model = "claude-sonnet-4-5";
  await run(Api.use((api) => api.setModel({ sessionId: id, model })));
  const info = await run(Api.use((api) => api.info({ sessionId: id })));
  expect(info.model).toBe(model);

  const second = await run(turn(id, "Reply with exactly: two"));
  expect(second.status).toBe("completed");
});

test("events replay from a cursor", async () => {
  const id = sessionId("events");
  await run(turn(id, "Reply with exactly: hello"));

  // The stream stays open for live events: read until the turn's end replays.
  const types = await run(
    Api.use((api) =>
      api.events({ sessionId: id, after: 0 }).pipe(
        Stream.map((event) => event.type),
        Stream.takeUntil((type) => type === "turn.completed"),
        Stream.runCollect,
        Effect.timeout("60 seconds"),
      ),
    ),
  );
  expect(types).toContain("message.completed");
  expect(types).toContain("turn.completed");
});

/**
 * Cloudflare integration test for the OpenCode {@link CodingAgentContainer}
 * behind a Durable Object. It deploys the stack (Worker → Agent DO → embedded
 * OpenCode container), then exercises the full agent surface end to end:
 *
 *   - events stream over a **hibernatable WebSocket** (the DO holds a streaming
 *     RPC connection open to the container and fans every event out as a frame),
 *   - `send` / `interrupt` / `file` / `files` over HTTP RPC,
 *   - interrupt-then-recover across turns.
 *
 * Deploy + container build can take many minutes, so the hooks get a generous
 * budget. Run with the Anthropic key injected via Doppler:
 *
 *   cd packages/@alchemy.run/harness-opencode
 *   doppler run -- bun test test/integ.test.ts
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Socket from "effect/unstable/socket/Socket";
import Stack from "./stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

/** The model the agent drives. Override with `OPENCODE_TEST_MODEL`. */
const MODEL = process.env.OPENCODE_TEST_MODEL ?? "anthropic/claude-sonnet-4-5";

const WRITE_HELLO =
  "Create a file named hello.txt (use the relative path hello.txt, not an absolute path) in your current working directory, containing exactly the text 'hello world'. Then you are done.";
const LONG_ESSAY =
  "Write a detailed, thorough essay of at least 1500 words about the history of relational databases into a file named essay.txt (use the relative path essay.txt). Take your time and be comprehensive — cover the relational model, SQL, ACID, NoSQL, and NewSQL.";
const WRITE_DONE =
  "Create a file named done.txt (use the relative path done.txt, not an absolute path) containing exactly the text 'done'. Then you are done.";

// Building + pushing the container image and provisioning the DO can take well
// over the default hook budget, so give deploy/destroy generous room.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

/** A normalized event, streamed verbatim from the agent over the WebSocket. */
type Event = { _tag: string; [key: string]: unknown };

/**
 * Open a WebSocket to the agent and drain every JSON event frame into `seen`.
 * Blocks until the socket handshake completes so the caller can `send`
 * immediately without racing the connection.
 */
const connect = (wsUrl: string, seen: Ref.Ref<ReadonlyArray<Event>>) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(wsUrl);
    const opened = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      socket.runString(
        (frame) =>
          Effect.suspend(() => {
            const event = JSON.parse(frame) as Event;
            return Ref.update(seen, (all) => [...all, event]);
          }),
        { onOpen: Deferred.succeed(opened, undefined) },
      ),
    );
    yield* Deferred.await(opened);
  });

test(
  "deployed agent: websocket events / send / file / files / interrupt / recovery",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = `${url}/agent/integ`;
    const wsUrl = `${url.replace(/^http/, "ws")}/agent/integ/connect`;
    const http = yield* HttpClient.HttpClient;

    const seen = yield* Ref.make<ReadonlyArray<Event>>([]);
    yield* connect(wsUrl, seen);
    // Give the DO's streaming-RPC forwarder a moment to subscribe to the
    // container's event pub/sub before we enqueue the first turn.
    yield* Effect.sleep("2 seconds");

    const countTag = (tag: string) =>
      Ref.get(seen).pipe(
        Effect.map((events) => events.filter((e) => e._tag === tag).length),
      );
    const total = Ref.get(seen).pipe(Effect.map((events) => events.length));

    const waitForCount = (tag: string, n: number, times = 240) =>
      countTag(tag).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (count) => count >= n,
          times,
        }),
      );

    const send = (prompt: string) =>
      http
        .post(
          `${base}/send?prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(MODEL)}`,
        )
        .pipe(
          Effect.retry({
            schedule: Schedule.exponential("500 millis"),
            times: 10,
          }),
        );
    const interrupt = http.post(`${base}/interrupt`);
    const readFile = (path: string) =>
      http
        .get(`${base}/file?path=${encodeURIComponent(path)}`)
        .pipe(Effect.flatMap((res) => res.json))
        .pipe(
          Effect.map((body) => (body as { contents: string | null }).contents),
        );
    const listFiles = http
      .get(`${base}/files`)
      .pipe(Effect.flatMap((res) => res.json))
      .pipe(
        Effect.map((body) => (body as { files: ReadonlyArray<string> }).files),
      );

    // ── Turn 1: send → events (over WS) → readFile → listFiles ────────────────
    yield* send(WRITE_HELLO);
    yield* waitForCount("Finish", 1);

    const tags1 = (yield* Ref.get(seen)).map((e) => e._tag);
    yield* Effect.log(`turn 1 events: ${tags1.join(", ")}`);
    expect(tags1).toContain("ToolCall");
    expect(tags1).toContain("Finish");
    expect(tags1).not.toContain("Error");

    const hello = yield* readFile("hello.txt");
    expect(hello?.trim()).toBe("hello world");

    const missing = yield* readFile("does-not-exist.txt");
    expect(missing).toBeNull();

    const files = yield* listFiles;
    yield* Effect.log(`workspace files: ${files.join(", ")}`);
    expect(files).toContain("hello.txt");

    // ── Turn 2: interrupt a long-running turn before it finishes ───────────────
    const lenBeforeLong = yield* total;
    yield* send(LONG_ESSAY);
    yield* total.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (len) => len > lenBeforeLong,
        times: 240,
      }),
    );

    const finishesBeforeInterrupt = yield* countTag("Finish");
    expect(finishesBeforeInterrupt).toBe(1);

    yield* interrupt;

    yield* Effect.sleep("6 seconds");
    const finishesAfterInterrupt = yield* countTag("Finish");
    expect(finishesAfterInterrupt).toBe(1);

    // ── Turn 3: the persistent agent recovers and processes the next input ─────
    yield* send(WRITE_DONE);
    yield* waitForCount("Finish", 2);

    const done = yield* readFile("done.txt");
    expect(done?.trim()).toBe("done");
  }).pipe(
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  ),
  { timeout: 600_000 },
);

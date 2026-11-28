import * as Domain from "@alchemy.run/domain";
import { Board, BoardHandlers } from "@board/domain/Board.model";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { BoardRoutes } from "../src/BoardRoutes.ts";
import { BoardToken, SessionLive } from "../src/Session.ts";
import { mcpClient, runCli } from "./harness.ts";

const TOKEN = "test-token";

/** The board hosted in memory, with the real Session middleware. */
const World = SessionLive.pipe(
  Layer.provideMerge(Layer.succeed(BoardToken, Effect.succeed(Redacted.make(TOKEN)))),
  Layer.provideMerge(Board.layer(BoardHandlers)),
  Layer.provide(Domain.InMemory),
);

// ---------------------------------------------------------------- MCP

/** The Worker's routes served in process: `fetch` reaches them as it reaches the Worker. */
const served = Effect.gen(function* () {
  const { handler, dispose } = HttpRouter.toWebHandler(BoardRoutes.pipe(Layer.provide(World)), {
    disableLogger: true,
  });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof globalThis.fetch;
});

const mcpOver = Effect.map(served, (fetch) => mcpClient("http://board.test", TOKEN, fetch));

describe("the board over MCP", () => {
  it.live("an agent finds a task, claims it, and finishes it", () =>
    Effect.gen(function* () {
      const mcp = yield* mcpOver;
      const listed = yield* mcp.tools;
      expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(
        expect.arrayContaining([
          "BoardApi_CreateTask_send",
          "BoardApi_ReadyTasks_ask",
          "BoardApi_ClaimTask_send",
          "BoardApi_ThreadTimeline_list",
        ]),
      );

      const created = yield* mcp.call("sam", "BoardApi_CreateTask_send", {
        input: {
          threadId: "t-1",
          channel: "dev",
          title: "Checkout 500s",
          text: "POST /checkout fails for EU carts",
          labels: ["kind=bug"],
        },
      });
      expect(created.isError).toBe(false);

      const ready = yield* mcp.call("fixer", "BoardApi_ReadyTasks_ask", {
        input: { channel: "dev", labels: ["kind=bug"] },
      });
      expect(ready.structuredContent).toMatchObject({ value: [{ threadId: "t-1" }] });

      const claimed = yield* mcp.call("fixer", "BoardApi_ClaimTask_send", {
        input: { threadId: "t-1" },
      });
      expect(claimed.isError).toBe(false);

      // Another agent loses the race, with a typed rejection it can act on.
      const lost = yield* mcp.call("reviewer", "BoardApi_ClaimTask_send", {
        input: { threadId: "t-1" },
      });
      expect(lost.isError).toBe(true);
      expect(JSON.parse(lost.content[0].text)).toMatchObject({
        _tag: "AlreadyClaimed",
        by: "fixer",
      });

      yield* mcp.call("fixer", "BoardApi_PostMessage_send", {
        input: { threadId: "t-1", text: "Working on it." },
      });
      const done = yield* mcp.call("fixer", "BoardApi_CompleteTask_send", {
        input: { threadId: "t-1", note: "Can I get a review? #812" },
      });
      expect(done.isError).toBe(false);

      const timeline = yield* mcp.call("sam", "BoardApi_ThreadTimeline_list", {
        key: "t-1",
      });
      expect(
        timeline.structuredContent.entries.map(
          (entry: { event: { kind: string; author: string } }) =>
            `${entry.event.author}: ${entry.event.kind}`,
        ),
      ).toEqual(["sam: started", "fixer: claimed", "fixer: message", "fixer: completed"]);

      const channel = yield* mcp.call("sam", "BoardApi_ChannelBoard_get", {
        key: "dev",
      });
      // A view's state may be absent, so MCP carries it as `{ value }`.
      expect(channel.structuredContent).toMatchObject({
        value: {
          threads: { "t-1": { title: "Checkout 500s", task: { _tag: "Done", by: "fixer" } } },
        },
      });
    }).pipe(Effect.scoped),
  );

  it.live("a call without the board's token is refused", () =>
    Effect.gen(function* () {
      const mcp = yield* mcpOver;
      const anonymous = yield* mcp.call(undefined, "BoardApi_ReadyTasks_ask", {
        input: { channel: "dev" },
      });
      expect(anonymous.isError).toBe(true);
      expect(JSON.parse(anonymous.content[0].text)).toEqual({ _tag: "Unauthorized" });
    }).pipe(Effect.scoped),
  );
});

// ---------------------------------------------------------------- CLI

/** `board` against the Api on `/api`, over its HTTP protocol. */
const cliOver = Effect.map(served, (fetch) => runCli("http://board.test", TOKEN, fetch));

describe("the board from the CLI", () => {
  it.live("people and agents work through tasks from a shell", () =>
    Effect.gen(function* () {
      const run = yield* cliOver;
      const created = yield* run("sam", [
        "create-task",
        "--thread-id",
        "t-1",
        "--channel",
        "dev",
        "--title",
        "Checkout 500s",
        "--text",
        "POST /checkout fails for EU carts",
        "--labels",
        '["kind=bug"]',
      ]);
      expect(created.stdout).toMatchObject({ stream: "Thread/t-1", version: 1 });

      const ready = yield* run("fixer", [
        "ready-tasks",
        "--channel",
        "dev",
        "--labels",
        '["kind=bug"]',
      ]);
      expect(ready.stdout).toMatchObject([{ threadId: "t-1", title: "Checkout 500s" }]);

      const claimed = yield* run("fixer", ["claim-task", "--thread-id", "t-1"]);
      expect(claimed.stdout.reply.leaseUntil).toBeGreaterThan(Date.now());

      const lost = yield* run("reviewer", ["claim-task", "--thread-id", "t-1"]);
      expect(JSON.parse(lost.stderr)).toMatchObject({ _tag: "AlreadyClaimed", by: "fixer" });

      const renewed = yield* run("fixer", [
        "renew-lease",
        "--thread-id",
        "t-1",
        "--lease-seconds",
        "3600",
      ]);
      expect(renewed.stdout.reply.leaseUntil).toBeGreaterThan(claimed.stdout.reply.leaseUntil);

      yield* run("fixer", ["complete-task", "--thread-id", "t-1", "--note", "Review? #812"]);
      const summary = yield* run("sam", ["thread-summary", "get", "--key", "t-1"]);
      expect(summary.stdout).toMatchObject({ task: { _tag: "Done", by: "fixer" } });
    }).pipe(Effect.scoped),
  );
});

// ---------------------------------------------------------------- the web app

describe("the web app's session", () => {
  it.live("a browser signs in with the token, and its cookies act as its name", () =>
    Effect.gen(function* () {
      const fetch = yield* served;
      const session = (init?: RequestInit) =>
        Effect.promise(() => fetch("http://board.test/api/session", init));
      const signIn = (token: string) =>
        session({ method: "POST", body: JSON.stringify({ token, actor: "sam" }) });

      expect((yield* signIn("wrong")).status).toBe(401);
      expect((yield* session()).status).toBe(401);

      const signedIn = yield* signIn(TOKEN);
      expect(signedIn.status).toBe(200);
      const setCookies = signedIn.headers.getSetCookie();
      expect(setCookies.every((c) => /HttpOnly/i.test(c) && /SameSite=Strict/i.test(c))).toBe(true);
      // What the browser sends back on every request and WebSocket upgrade.
      const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

      const whoAmI = yield* session({ headers: { cookie } });
      expect(yield* Effect.promise(() => whoAmI.json())).toEqual({ actor: "sam" });

      const mcp = mcpClient("http://board.test", TOKEN, fetch);
      const created = yield* mcp.callWith({ cookie }, "BoardApi_StartThread_send", {
        input: { threadId: "t-1", channel: "dev", title: "Hello", text: "From the web" },
      });
      expect(created.isError).toBe(false);
      const summary = yield* mcp.call("fixer", "BoardApi_ThreadSummary_get", { key: "t-1" });
      expect(summary.structuredContent).toMatchObject({ value: { author: "sam" } });

      const signedOut = yield* session({ method: "DELETE", headers: { cookie } });
      expect(signedOut.headers.getSetCookie().every((c) => /Max-Age=0/i.test(c))).toBe(true);
    }).pipe(Effect.scoped),
  );
});

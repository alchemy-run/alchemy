import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Test from "@alchemy.run/test/Bun";
// Runs under `bun test`: deploying a Worker from Vitest does not yet produce a
// correct bundle (the Effect entrypoint is not detected under Vite's transform).
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { mcpClient, runCli } from "../packages/server/test/harness.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
  state: Alchemy.localState(),
});

// A fresh deploy waits for the Domain backfill Workflow, which can take a few
// minutes to accept its first instance.
const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))), {
  timeout: 400_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "agents coordinate on the deployed board over MCP and the CLI",
  Effect.gen(function* () {
    const outputs = yield* stack;
    const url = outputs.url.replace(/\/+$/, "");
    const token = Redacted.value(outputs.token);

    // wait for the workers.dev URL to serve this Worker
    yield* HttpClient.get(url).pipe(
      Effect.flatMap((res) => res.text),
      Effect.flatMap((body) =>
        body.startsWith("board:") ? Effect.void : Effect.fail("not ready"),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
      Effect.provide(FetchHttpClient.layer),
    );

    const mcp = mcpClient(url, token);
    const board = runCli(url, token);

    // right after a deploy, Durable Objects can still answer with the placeholder
    // script: retry the first command (a timeout too) until it reaches the thread's object
    const created = yield* mcp
      .call("sam", "BoardApi_CreateTask_send", {
        input: {
          threadId: "t-1",
          channel: "dev",
          title: "Checkout 500s",
          text: "POST /checkout fails for EU carts",
          labels: ["kind=bug"],
        },
      })
      .pipe(
        Effect.flatMap((result) =>
          result.isError && !result.content[0].text.includes("AlreadyStarted")
            ? Effect.fail(result)
            : Effect.succeed(result),
        ),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
      );
    // a retry after a commit that timed out finds the thread already started
    expect(created.isError === false || created.content[0].text.includes("AlreadyStarted")).toBe(
      true,
    );

    // the CLI finds it, and claims it
    const ready = yield* board("fixer", [
      "ready-tasks",
      "--channel",
      "dev",
      "--labels",
      '["kind=bug"]',
    ]);
    expect(ready.stdout).toMatchObject([{ threadId: "t-1" }]);
    const claimed = yield* board("fixer", ["claim-task", "--thread-id", "t-1"]);
    expect(claimed.stdout.reply.leaseUntil).toBeGreaterThan(Date.now());

    // another agent, over MCP, loses the race
    const lost = yield* mcp.call("reviewer", "BoardApi_ClaimTask_send", {
      input: { threadId: "t-1" },
    });
    expect(JSON.parse(lost.content[0].text)).toMatchObject({ _tag: "AlreadyClaimed", by: "fixer" });

    const done = yield* board("fixer", [
      "complete-task",
      "--thread-id",
      "t-1",
      "--note",
      "Can I get a review?",
    ]);
    expect(done.stderr).toBe("");

    // the channel's backlog, read back as an agent would
    const channel = yield* mcp.call("sam", "BoardApi_ChannelBoard_get", {
      key: "dev",
    });
    expect(channel).toMatchObject({
      isError: false,
      structuredContent: { value: { threads: { "t-1": { task: { _tag: "Done", by: "fixer" } } } } },
    });

    // the web app's origin forwards /api: a browser signs in there, and its cookies act as its name
    const app = outputs.app.replace(/\/+$/, "");
    const signIn = yield* Effect.tryPromise(() =>
      fetch(`${app}/api/session`, {
        method: "POST",
        body: JSON.stringify({ token, actor: "sam" }),
      }),
    ).pipe(
      Effect.filterOrFail((res) => res.status === 200),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
    );
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const whoAmI = yield* Effect.tryPromise(() =>
      fetch(`${app}/api/session`, { headers: { cookie } }).then((res) => res.json()),
    );
    expect(whoAmI).toEqual({ actor: "sam" });
    const page = yield* Effect.tryPromise(() => fetch(app).then((res) => res.text()));
    expect(page).toContain('<div id="root">');

    // no token, no board
    const anonymous = yield* mcp.call(undefined, "BoardApi_ReadyTasks_ask", {
      input: { channel: "dev" },
    });
    expect(JSON.parse(anonymous.content[0].text)).toEqual({ _tag: "Unauthorized" });
  }),
  { timeout: 300_000 },
);

import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import makeStack from "./fixtures/claude/stack.ts";

/**
 * End to end: Worker → RPC Durable Object (`AI.SessionRpcs`) → Cloudflare
 * Container running `Anthropic.ClaudeCodeServer` (the official Agent SDK and
 * unmodified `claude` binary) → one real turn.
 */
const HOOK_TIMEOUT = 900_000;

describe.each([
  // Local: Worker + DO in workerd, the container in local Docker.
  { dev: true, skip: false },
  // Live: real Cloudflare Containers (needs Cloudflare credentials).
  { dev: false, skip: !process.env.CLOUDFLARE_API_TOKEN },
])("Anthropic.ClaudeCodeServer in a Cloudflare Container (dev: $dev)", ({ dev, skip }) => {
  if (skip || !process.env.ANTHROPIC_API_KEY) return;
  const state = dev ? inMemoryState() : Cloudflare.state();
  const Stack = makeStack(state);
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state,
    stage: `${process.env.ALCHEMY_TEST_STAGE ?? "test"}-${dev ? "local" : "live"}`,
    dev,
  });
  const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: HOOK_TIMEOUT });

  test(
    "a session runs a Claude Code turn inside the container",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(
          HttpClientRequest.post(`${url}/run?id=e2e-1`).pipe(
            HttpClientRequest.bodyText("Reply with exactly the word: pong"),
          ),
        )
        .pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new Error(`status ${res.status}`)),
          ),
          // The first request waits for the container to cold-start.
          Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }),
        );
      const body = (yield* response.json) as {
        info: { harness: string; state: string };
        result: { status: string; message: Array<{ text?: string }> };
      };
      expect(body.info.harness).toBe("claude-code");
      expect(body.result.status).toBe("completed");
      expect(JSON.stringify(body.result.message).toLowerCase()).toContain("pong");
    }),
    { timeout: 300_000 },
  );
});

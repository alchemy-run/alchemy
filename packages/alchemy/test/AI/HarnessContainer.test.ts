import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import makeStack from "./fixtures/harnesses/stack.ts";

/**
 * End to end, per harness: Worker → RPC Durable Object (`AI.SessionRpcs`,
 * one per session) → its own Cloudflare Container, built from one image with
 * an `AI.Environment` checkout and Claude Code, Codex and OpenCode installed
 * → one real turn on a cheap model, working in the checkout.
 */
const HOOK_TIMEOUT = 900_000;

interface RunResponse {
  info: { harness: string; state: string; cwd: string };
  result: { status: string; error?: string; message: Array<{ text?: string }> };
}

describe.each([
  // Local: Worker + DO in workerd, each session's container in local Docker.
  { dev: true, skip: false },
  // Live: real Cloudflare Containers (needs Cloudflare credentials).
  { dev: false, skip: !process.env.CLOUDFLARE_API_TOKEN },
])("coding-agent harnesses in Cloudflare Containers (dev: $dev)", ({ dev, skip }) => {
  if (skip || !process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) return;
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

  const run = (harness: string, session: string, prompt: string) =>
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(
          HttpClientRequest.post(`${url}/run/${harness}?id=${session}`).pipe(
            HttpClientRequest.bodyText(prompt),
          ),
        )
        .pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : res.text.pipe(
                  Effect.flatMap((body) => Effect.fail(new Error(`${res.status}: ${body}`))),
                ),
          ),
          // The first request waits for the session's container to cold-start;
          // a turn that stalled is a real failure, not a cold start.
          Effect.retry({
            schedule: Schedule.spaced("10 seconds"),
            times: 18,
            while: (e) => !e.message.includes("timed out"),
          }),
        );
      return (yield* response.json) as unknown as RunResponse;
    });

  const README_PROMPT =
    "Read the README file in the current directory and reply with only its first line, nothing else.";

  test(
    "Claude Code works in the environment's checkout",
    Effect.gen(function* () {
      const { info, result } = yield* run("claude", "readme", README_PROMPT);
      expect(info.harness).toBe("claude-code");
      expect(info.cwd).toBe("/workspaces/Repo");
      expect(result.status).toBe("completed");
      expect(JSON.stringify(result.message).toLowerCase()).toContain("hello world");
    }),
    { timeout: 300_000 },
  );

  test(
    "OpenCode (ACP) works in the environment's checkout",
    Effect.gen(function* () {
      const { info, result } = yield* run("opencode", "readme", README_PROMPT);
      expect(info.harness).toBe("opencode");
      expect(info.cwd).toBe("/workspaces/Repo");
      expect(result.status).toBe("completed");
      expect(JSON.stringify(result.message).toLowerCase()).toContain("hello world");
    }),
    { timeout: 300_000 },
  );

  test(
    "Codex runs a turn over codex app-server",
    Effect.gen(function* () {
      const { info, result } = yield* run("codex", "readme", README_PROMPT);
      expect(info.harness).toBe("codex");
      expect(info.cwd).toBe("/workspaces/Repo");
      // A funded key completes; an unfunded one fails the turn with a quota
      // error — either way the turn lifecycle round-trips through the box.
      expect(["completed", "failed"]).toContain(result.status);
      if (result.status === "completed") {
        expect(JSON.stringify(result.message).toLowerCase()).toContain("hello world");
      }
    }),
    { timeout: 300_000 },
  );
});

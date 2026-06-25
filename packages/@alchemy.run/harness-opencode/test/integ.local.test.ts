/**
 * Local integration test for the OpenCode {@link CodingAgent} — no Cloudflare,
 * no container, no deploy. It builds the persistent-agent actor
 * ({@link makeCodingAgent}) over the OpenCode runtime ({@link OpenCodeAgent})
 * against the host Bun platform, then exercises the full actor surface:
 *
 *   - `events()` — one persistent, decoupled subscription across every turn,
 *   - `send` — fire-and-forget inputs (three turns),
 *   - `readFile` / `listFiles` — workspace queries (incl. a missing-file `null`),
 *   - `interrupt()` — stop a long-running turn before it finishes,
 *   - recovery — the agent processes the next input after an interrupt.
 *
 * Run with the Anthropic key injected via Doppler:
 *
 *   cd packages/@alchemy.run/harness-opencode
 *   doppler run -- bun test test/integ.local.test.ts
 *
 * The OpenCode bridge bootstraps itself with a hardcoded `pnpm install`; both
 * pnpm and Bun block its `opencode-ai` postinstall (which installs the ~119 MB
 * opencode binary). To stay self-contained, the test installs a `pnpm` shim on
 * PATH that runs `bun install` + the postinstall — mirroring the container image.
 */
import { OpenCodeAgent } from "@alchemy.run/harness-opencode";
import { layer as BunServices } from "@effect/platform-bun/BunServices";
import { type CodingAgentEvent, CodingAgentRuntime } from "alchemy/AI";
import { expect, test } from "bun:test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const MODEL = process.env.OPENCODE_TEST_MODEL ?? "anthropic/claude-sonnet-4-5";

const WRITE_HELLO =
  "Create a file named hello.txt (use the relative path hello.txt, not an absolute path) in your current working directory, containing exactly the text 'hello world'. Then you are done.";

/** A long task — enough streaming to reliably interrupt mid-turn. */
const LONG_ESSAY =
  "Write a detailed, thorough essay of at least 1500 words about the history of relational databases into a file named essay.txt (use the relative path essay.txt). Take your time and be comprehensive — cover the relational model, SQL, ACID, NoSQL, and NewSQL.";

const WRITE_DONE =
  "Create a file named done.txt (use the relative path done.txt, not an absolute path) containing exactly the text 'done'. Then you are done.";

/** Bootstrap shim: translate the harness's `pnpm --dir D install …` into a Bun
 * install plus the mandatory `opencode-ai` postinstall, and prepend it to PATH. */
const PNPM_SHIM = [
  "#!/bin/sh",
  'dir="."',
  'while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2;; --store-dir) shift 2;; install|--frozen-lockfile) shift;; *) shift;; esac; done',
  'cd "$dir" || exit 1',
  "bun install || exit 1",
  "if [ -f node_modules/opencode-ai/postinstall.mjs ]; then node node_modules/opencode-ai/postinstall.mjs || exit 1; fi",
  "exit 0",
  "",
].join("\n");

const installPnpmShim = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectory({ prefix: "opencode-pnpm-shim-" });
  const shim = `${dir}/pnpm`;
  yield* fs.writeFileString(shim, PNPM_SHIM);
  yield* fs.chmod(shim, 0o755);
  yield* Effect.sync(() => {
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  });
});

const drive = Effect.gen(function* () {
  const agent = yield* CodingAgentRuntime;

  // One persistent subscription for the whole test — `events()` is decoupled
  // from `send`, so a single observer sees every turn. Accumulate into a Ref.
  const seen = yield* Ref.make<ReadonlyArray<CodingAgentEvent>>([]);
  yield* agent.events().pipe(
    Stream.runForEach((event) =>
      Ref.update(seen, (events) => [...events, event]),
    ),
    Effect.forkScoped,
  );
  // Give the pub/sub subscription a moment to attach before we enqueue work.
  yield* Effect.sleep("250 millis");

  const countTag = (tag: CodingAgentEvent["_tag"]) =>
    Ref.get(seen).pipe(
      Effect.map((events) => events.filter((e) => e._tag === tag).length),
    );
  const total = Ref.get(seen).pipe(Effect.map((events) => events.length));

  /** Block until at least `n` events with `_tag` have been observed. */
  const waitForCount = (tag: CodingAgentEvent["_tag"], n: number) =>
    countTag(tag).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (count) => count >= n,
        times: 240,
      }),
    );

  // ── Turn 1: send (fire-and-forget) → events → readFile → listFiles ────────
  yield* agent.send({ prompt: WRITE_HELLO });
  yield* waitForCount("Finish", 1);

  const afterTurn1 = yield* Ref.get(seen);
  const tags1 = afterTurn1.map((e) => e._tag);
  yield* Effect.log(`turn 1 events: ${tags1.join(", ")}`);
  expect(tags1).toContain("ToolCall");
  expect(tags1).toContain("Finish");
  expect(tags1).not.toContain("Error");

  const hello = yield* agent.readFile("hello.txt");
  expect(hello?.trim()).toBe("hello world");

  const missing = yield* agent.readFile("does-not-exist.txt");
  expect(missing).toBeNull();

  const files = yield* agent.listFiles();
  yield* Effect.log(`workspace files: ${files.join(", ")}`);
  expect(files).toContain("hello.txt");

  // ── Turn 2: interrupt a long-running turn before it finishes ───────────────
  const lenBeforeLong = yield* total;
  yield* agent.send({ prompt: LONG_ESSAY });
  // Wait until the long turn has actually started streaming.
  yield* total.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("250 millis"),
      until: (len) => len > lenBeforeLong,
      times: 240,
    }),
  );

  // The long turn must still be in flight (not yet finished) when we interrupt.
  const finishesBeforeInterrupt = yield* countTag("Finish");
  expect(finishesBeforeInterrupt).toBe(1);

  yield* agent.interrupt();

  // After interrupting, the turn must stop: no additional `Finish` shows up
  // (the next turn gets its own bridge port, so the count below is turn 3's).
  yield* Effect.sleep("6 seconds");
  const finishesAfterInterrupt = yield* countTag("Finish");
  expect(finishesAfterInterrupt).toBe(1);

  // ── Turn 3: the persistent agent recovers and processes the next input ─────
  yield* agent.send({ prompt: WRITE_DONE });
  yield* waitForCount("Finish", 2);

  const done = yield* agent.readFile("done.txt");
  expect(done?.trim()).toBe("done");
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* installPnpmShim;
  const workspace = yield* fs.makeTempDirectory({ prefix: "opencode-integ-" });
  yield* Effect.log(`workspace=${workspace} model=${MODEL}`);

  yield* drive.pipe(
    Effect.provide(
      OpenCodeAgent({
        workspace,
        model: MODEL,
        anthropic: { apiKey: Config.redacted("ANTHROPIC_API_KEY") },
      }),
    ),
  );
}).pipe(Effect.scoped, Effect.provide(BunServices));

test(
  "opencode agent: send / events / readFile / listFiles / interrupt / recovery",
  async () => {
    await Effect.runPromise(program);
  },
  { timeout: 240_000 },
);

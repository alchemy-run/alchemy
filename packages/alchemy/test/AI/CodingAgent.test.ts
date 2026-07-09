/**
 * The capstone: a locally running CODING agent, end to end. A bounded
 * Process (`FixTests`) with real local physics — filesystem + shell,
 * sandboxed to a temp workspace — diagnoses a failing test suite, fixes
 * the source bug, verifies with `bun test`, and resolves via
 * halt-as-tool. The test then re-verifies out of band: the suite really
 * passes, the source really changed, and the test file was never
 * touched.
 *
 * Gated on `ANTHROPIC_API_KEY`:
 *
 *   ANTHROPIC_API_KEY=sk-… bun vitest run test/AI/CodingAgent.test.ts
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as NodeChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ChildProcess } from "effect/unstable/process";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import {
  Bash,
  Grep,
  localToolbox,
  ReadFile,
  WriteFile,
} from "./fixtures/coding/toolbox.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;

// ─── the charter ─────────────────────────────────────────────────

class FixTests extends AI.Process<FixTests>()("FixTests")`
You are a careful software engineer working alone in a sandboxed
workspace. The test suite is failing. Diagnose and fix it:

- run the suite with ${Bash} (\`bun test\`) to see the failures
- locate the bug with ${Grep} and ${ReadFile}
- fix the SOURCE under test with ${WriteFile}
- NEVER modify test files — the tests are the specification
- re-run the suite to verify

${AI.until`\`bun test\` exits 0 — every test passes`}
${AI.budget({ iterations: 8 })}` {}

// ─── the workspace fixture ───────────────────────────────────────

const BUGGY_SOURCE = `export const add = (a: number, b: number): number => a - b;
export const scale = (values: number[], factor: number): number[] =>
  values.map((value) => value * factor);
`;

const TEST_FILE = `import { expect, test } from "bun:test";
import { add, scale } from "./calc.ts";

test("add sums its operands", () => {
  expect(add(2, 3)).toBe(5);
  expect(add(-1, 1)).toBe(0);
});

test("scale multiplies every element", () => {
  expect(scale([1, 2, 3], 2)).toEqual([2, 4, 6]);
});
`;

const makeWorkspace = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-coder-" });
  yield* fs.writeFileString(path.join(root, "calc.ts"), BUGGY_SOURCE);
  yield* fs.writeFileString(path.join(root, "calc.test.ts"), TEST_FILE);
  return root;
});

const runSuite = Effect.fn(function* (root: string) {
  const handle = yield* ChildProcess.make("sh", ["-c", "bun test"], {
    cwd: root,
  });
  const [exitCode, stderr] = yield* Effect.all(
    [handle.exitCode, Stream.mkString(Stream.decodeText(handle.stderr))],
    { concurrency: 2 },
  );
  return { exitCode, stderr };
});

// ─── physics ─────────────────────────────────────────────────────

const PlatformLive = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  NodeChildProcessSpawner.layer.pipe(
    Layer.provide([BunFileSystem.layer, Path.layer]),
  ),
);

const KernelLive = AI.memory.pipe(
  Layer.provide(
    AnthropicLanguageModel.layer({ model: "claude-haiku-4-5" }).pipe(
      Layer.provide(
        AnthropicClient.layer({
          apiKey: apiKey === undefined ? undefined : Redacted.make(apiKey),
        }),
      ),
      Layer.provide(FetchHttpClient.layer),
    ),
  ),
);

// ─── the capstone ────────────────────────────────────────────────

describe("the local coding agent", () => {
  it.effect.skipIf(apiKey === undefined)(
    "diagnoses, fixes, and verifies a failing suite end to end",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeWorkspace();

        // the bug is real: the suite fails before the agent starts
        const before = yield* runSuite(root);
        expect(before.exitCode).not.toBe(0);
        const testFileBefore = yield* fs.readFileString(
          path.join(root, "calc.test.ts"),
        );

        // one bounded loop run, local physics, real model
        yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const coder = yield* kernel.interpret(FixTests);
            return yield* coder.dispatch(
              "The test suite in this workspace is failing. " +
                "Files: calc.ts (source), calc.test.ts (tests). " +
                "Find the bug, fix it, and verify.",
            );
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              KernelLive,
              localToolbox(root).pipe(Layer.provide(PlatformLive)),
              RuntimeContext.phantom,
            ),
          ),
        );

        // out-of-band verification: don't trust the agent's word
        const after = yield* runSuite(root);
        expect(after.exitCode).toBe(0);
        // the source was fixed…
        const source = yield* fs.readFileString(path.join(root, "calc.ts"));
        expect(source).not.toContain("a - b");
        // …and the specification was never touched
        const testFileAfter = yield* fs.readFileString(
          path.join(root, "calc.test.ts"),
        );
        expect(testFileAfter).toBe(testFileBefore);
      }).pipe(Effect.provide(PlatformLive)),
    { timeout: 300_000 },
  );
});

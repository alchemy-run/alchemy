import { NonInteractiveTerminal } from "@/Interaction.ts";
import { makeRuntime } from "@/Cli/CliKit/headless.ts";
import { nodeLoaderArgs } from "@/Util/Node.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const capabilities = {
  input: false,
  columns: 80,
  rows: 24,
  colors: false,
  unicode: true,
  alternateScreen: false,
};

describe("CliKit headless runtime", () => {
  it.effect("writes plain output and rejects prompts", () =>
    Effect.gen(function* () {
      const chunks: string[] = [];
      const stdout = {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
        isTTY: false,
      } as unknown as NodeJS.WriteStream;
      const { service, dispose } = makeRuntime(
        { stdout, input: false },
        capabilities,
      );
      yield* service.output.info("hello");
      const prompt = yield* service.prompt
        .confirm({ message: "go?" })
        .pipe(Effect.flip);
      expect(prompt).toBeInstanceOf(NonInteractiveTerminal);
      expect(chunks.join("")).toContain("hello");
      yield* Effect.promise(dispose);
    }),
  );
});

const FIXTURE = fileURLToPath(
  new URL("./fixtures/node-clikit-layer.ts", import.meta.url),
);

const hasBin = (bin: string): boolean => {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(probe, [bin], { encoding: "utf-8" });
    return result.status === 0 && Boolean(result.stdout?.trim());
  } catch {
    return false;
  }
};

// Same spawn as the Vite child: bun `run` vs node + the Oxc loader.
// Node is not gated on `process.features.typescript === "transform"` —
// ViteChild still prefers a Node binary whenever one is on PATH, and the
// crash is `.tsx` under that Node, not missing type-stripping.
const childRuntimes = [
  {
    name: "bun",
    available: hasBin("bun"),
    argv: (entry: string) => ["bun", "run", entry],
  },
  {
    name: "node",
    available: hasBin("node"),
    argv: (entry: string) => ["node", ...nodeLoaderArgs(entry), entry],
  },
] as const;

for (const runtime of childRuntimes) {
  describe.skipIf(!runtime.available)(
    `CliKit.layer under ${runtime.name} from TypeScript source`,
    () => {
      it.live("constructs without loading Runtime.tsx", () =>
        Effect.gen(function* () {
          const [bin, ...args] = runtime.argv(FIXTURE);
          const child = yield* ChildProcess.make(bin, args, {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "10 seconds",
          });
          const { code, stdout, stderr } = yield* Effect.all(
            {
              code: child.exitCode.pipe(Effect.orDie),
              stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
              stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
            },
            { concurrency: "unbounded" },
          );
          expect(stderr, stderr).not.toContain('Unknown file extension ".tsx"');
          expect(code, stderr || stdout).toBe(0);
          expect(stdout).toContain("CLIKIT_READY");
        }).pipe(Effect.provide(PlatformServices)),
      );
    },
  );
}

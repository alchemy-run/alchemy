/**
 * The `Sandbox` CONTRACT, asserted against the trusted-host
 * implementation — a new implementation (the Cloudflare container
 * guest, a MicroVM) can copy these assertions as its conformance
 * test.
 *
 * What the contract guarantees (what the sandbox-agnostic toolbox
 * relies on):
 *
 * - `exec` runs a shell string (args shell-quoted when provided),
 *   collects both streams, retains the NEWEST bytes under the
 *   retention cap, and reports drops via the truncation flags;
 * - a timeout is a model-visible failure, not a hang;
 * - file operations are contained under the workspace root and fail
 *   model-visibly (strings) on escapes, binaries, and missing paths;
 * - `writeFile` creates parent directories and lands atomically.
 */
import { Sandbox } from "@/AI/Sandbox.ts";
import { SandboxLocal } from "@/AI/SandboxLocal.ts";
import * as Workspace from "@/Workspace/index.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const withSandbox = <A, E>(
  program: Effect.Effect<A, E, Sandbox | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-sandbox-test-",
    });
    return yield* program.pipe(
      Effect.provide(SandboxLocal.pipe(Layer.provide(Workspace.fixed(root)))),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("SandboxLocal", () => {
  it.effect("exec runs shell strings and quotes args", () =>
    withSandbox(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;

        const plain = yield* sandbox.exec("echo hello && echo oops 1>&2");
        expect(plain.success).toBe(true);
        expect(plain.exitCode).toBe(0);
        expect(plain.stdout.trim()).toBe("hello");
        expect(plain.stderr.trim()).toBe("oops");
        expect(plain.stdoutTruncated).toBe(false);
        expect(plain.durationMs).toBeGreaterThanOrEqual(0);

        // args are quoted: the $ and spaces survive as ONE literal arg
        const quoted = yield* sandbox.exec("printf", ["%s", "a b $HOME"]);
        expect(quoted.stdout).toBe("a b $HOME");

        const failing = yield* sandbox.exec("exit 3");
        expect(failing.success).toBe(false);
        expect(failing.exitCode).toBe(3);
      }),
    ),
  );

  it.effect("exec overlays env and resolves cwd inside the root", () =>
    withSandbox(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        yield* sandbox.mkdir("nested/dir");

        const result = yield* sandbox.exec("echo $MARKER && pwd", undefined, {
          env: { MARKER: "sentinel" },
          cwd: "nested/dir",
        });
        const [marker, cwd] = result.stdout.trim().split("\n");
        expect(marker).toBe("sentinel");
        expect(cwd).toContain("nested/dir");

        // escaping cwd is a model-visible failure
        const escaped = yield* sandbox
          .exec("pwd", undefined, { cwd: "../.." })
          .pipe(Effect.flip);
        expect(escaped).toContain("escapes");
      }),
    ),
  );

  it.effect("exec retains the NEWEST bytes under the cap and flags drops", () =>
    withSandbox(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const result = yield* sandbox.exec(
          "i=1; while [ $i -le 500 ]; do echo line-$i; i=$((i+1)); done",
          undefined,
          { maxRetainedBytes: 1000 },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdoutTruncated).toBe(true);
        expect(result.stdout).toContain("line-500");
        expect(result.stdout).not.toContain("line-1\n");
      }),
    ),
  );

  // live clock: the timeout race sleeps for real alongside a real process
  it.live("exec timeout is a model-visible failure", () =>
    withSandbox(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const error = yield* sandbox
          .exec("sleep 5", undefined, { timeout: 300 })
          .pipe(Effect.flip);
        expect(error).toContain("timed out after 300ms");
      }),
    ),
  );

  it.effect("file physics: write creates parents, read round-trips", () =>
    withSandbox(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;

        yield* sandbox.writeFile("a/b/hello.txt", "hi there\n");
        expect(yield* sandbox.readFile("a/b/hello.txt")).toBe("hi there\n");
        expect(yield* sandbox.exists("a/b/hello.txt")).toBe(true);
        expect(yield* sandbox.exists("a/b/missing.txt")).toBe(false);

        const entries = yield* sandbox.listFiles("a");
        expect(entries).toEqual([{ name: "b", type: "directory" }]);

        yield* sandbox.deleteFile("a/b/hello.txt");
        expect(yield* sandbox.exists("a/b/hello.txt")).toBe(false);

        // missing files and escapes fail model-visibly
        expect(yield* sandbox.readFile("nope.txt").pipe(Effect.flip)).toContain(
          "nope.txt",
        );
        expect(
          yield* sandbox.readFile("../outside").pipe(Effect.flip),
        ).toContain("escapes");
      }),
    ),
  );

  it.effect("readFile rejects binaries and invalid UTF-8", () =>
    withSandbox(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sandbox = yield* Sandbox;
        yield* sandbox.mkdir(".");
        yield* sandbox.writeFile("marker.txt", "x");
        // place a real binary next to it, out-of-band
        const root = (yield* sandbox.listFiles(".")).length; // force layer built
        expect(root).toBeGreaterThan(0);
        const dir = path.dirname(
          // resolve through the sandbox's own view: write, then locate
          // the file via exec (pwd of the root)
          (yield* sandbox.exec("pwd")).stdout.trim() + "/marker.txt",
        );
        yield* fs.writeFile(
          path.join(dir, "binary.dat"),
          new Uint8Array([1, 0, 2]),
        );
        expect(
          yield* sandbox.readFile("binary.dat").pipe(Effect.flip),
        ).toContain("binary");
      }),
    ),
  );
});

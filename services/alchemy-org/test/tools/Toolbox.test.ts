import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import { SandboxLocal } from "alchemy/AI";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ToolOutputStoreLive } from "../../src/lib/ToolOutputStore.ts";
import {
  Bash,
  BashLive,
  Glob,
  GlobLive,
  Grep,
  GrepLive,
  ListDirectory,
  ListDirectoryLive,
  ReadFile,
  ReadFileLive,
  ReadOutput,
  ReadOutputLive,
} from "../../src/tools/index.ts";
import { Workspace, fixed as workspace } from "alchemy/Workspace";

const withWorkspace = <A, E>(program: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-org-tools-",
      });
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(root, "src"), { recursive: true });
      // rg activates repository ignore semantics when a git root exists.
      yield* fs.makeDirectory(path.join(root, ".git"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "src", "one.ts"),
        "export const one = 1;\nexport const shared = true;\n",
      );
      yield* fs.writeFileString(
        path.join(root, "src", "two.ts"),
        "export const two = 2;\nexport const shared = true;\n",
      );
      yield* fs.writeFileString(path.join(root, ".gitignore"), "ignored/\n");
      yield* fs.makeDirectory(path.join(root, "ignored"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "ignored", "secret.ts"),
        "secret marker\n",
      );

      const WorkspaceLayer = workspace(root);
      const Support = Layer.mergeAll(
        WorkspaceLayer,
        SandboxLocal.pipe(Layer.provide(WorkspaceLayer)),
        ToolOutputStoreLive,
      );
      const Tools = Layer.mergeAll(
        GrepLive,
        GlobLive,
        ListDirectoryLive,
        ReadFileLive,
        BashLive,
        ReadOutputLive,
      ).pipe(Layer.provide(Support));
      return yield* program.pipe(
        Effect.provide(Layer.mergeAll(Tools, Support, RuntimeContext.phantom)),
      );
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped) as Effect.Effect<
      A,
      E
    >,
  );

test("Workspace contains lexical and symlink escapes", () =>
  withWorkspace(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* Workspace;
      expect(yield* ws.resolveExisting("src/one.ts")).toContain("src/one.ts");
      expect(yield* ws.resolve("../outside").pipe(Effect.flip)).toContain(
        "escapes",
      );
      expect(yield* ws.resolve("/etc/passwd").pipe(Effect.flip)).toContain(
        "workspace-relative",
      );

      const outside = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-outside-",
      });
      yield* fs.writeFileString(path.join(outside, "secret.txt"), "outside");
      yield* fs.symlink(outside, path.join(yield* ws.root, "escape-link"));
      expect(
        yield* ws.resolveExisting("escape-link/secret.txt").pipe(Effect.flip),
      ).toContain("symlink");
      expect(
        yield* ws.resolveForCreate("escape-link/new.txt").pipe(Effect.flip),
      ).toContain("symlink");
    }),
  ));

test("ReadFile pages, numbers lines, rejects binary, and returns digest", () =>
  withWorkspace(
    Effect.gen(function* () {
      const read = yield* ReadFile;
      const page = yield* (read as any)({
        path: "src/one.ts",
        offset: 1,
        limit: 1,
      });
      expect(page).toContain("1: export const one");
      expect(page).toContain("Use offset=2");
      expect(page).toMatch(/SHA-256: [a-f0-9]{64}/);
      expect(
        yield* (read as any)({
          path: "src/one.ts",
          offset: -1,
          limit: 1,
        }),
      ).toContain("3: ");

      const fs = yield* FileSystem.FileSystem;
      const ws = yield* Workspace;
      yield* fs.writeFile(
        yield* ws.resolveForCreate("binary.dat"),
        new Uint8Array([1, 0, 2]),
      );
      expect(
        yield* (read as any)({ path: "binary.dat" }).pipe(Effect.flip),
      ).toContain("binary");
    }),
  ));

test("Grep, Glob, and ListDirectory use deterministic local physics", () =>
  withWorkspace(
    Effect.gen(function* () {
      const grep = yield* Grep;
      const glob = yield* Glob;
      const list = yield* ListDirectory;
      const matches = yield* (grep as any)({
        pattern: "shared",
        glob: "*.ts",
      });
      expect(matches).toContain("src/one.ts:2");
      expect(matches).toContain("src/two.ts:2");
      expect(matches).not.toContain("ignored/secret");
      expect(
        yield* (grep as any)({ pattern: "[" }).pipe(Effect.flip),
      ).toContain("grep failed");

      const paths = yield* (glob as any)({ pattern: "**/*.ts" });
      expect(paths.split("\n")).toEqual(["src/one.ts", "src/two.ts"]);

      const entries = yield* (list as any)({ path: "." });
      expect(entries).toContain(".gitignore");
      expect(entries).toContain("src/");
    }),
  ));

test("Bash truncates to a readable opaque full-output artifact", () =>
  withWorkspace(
    Effect.gen(function* () {
      const bash = yield* Bash;
      const readOutput = yield* ReadOutput;
      const result = yield* (bash as any)({
        command:
          "i=1; while [ $i -le 2105 ]; do echo line-$i; i=$((i+1)); done",
      });
      expect(result).toContain("exit: 0");
      expect(result).toContain("line-2105");
      const id = /Full stdout: (output-[^\n]+)/.exec(result)![1]!;
      const beginning = yield* (readOutput as any)({
        outputId: id,
        offset: 1,
        limit: 2,
      });
      expect(beginning).toContain("line-1");
      expect(beginning).toContain("line-2");
    }),
  ));

test("Bash timeout is model-visible and terminates the process", () =>
  withWorkspace(
    Effect.gen(function* () {
      const bash = yield* Bash;
      expect(
        yield* (bash as any)({
          command: "sleep 5",
          timeout: 1,
        }).pipe(Effect.flip),
      ).toContain("timed out after 1000ms");
    }),
  ));

import * as AI from "@alchemy.run/ai";
import type { ToolResult } from "@alchemy.run/ai/Tool";
import * as OpenCode from "@alchemy.run/opencode";
import * as Pi from "@alchemy.run/pi";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel } from "effect/ai";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { recording } from "./fixtures/recording.ts";

class Smart extends AI.Model<Smart>()("smart") {}
/** No test here reaches a model. */
const ModelsLive = Smart.layer(Layer.succeed(LanguageModel.LanguageModel, undefined as never));

class Searcher extends (AI.Process<Searcher>()("Searcher", { description: "Search files." })`
  Search with ${AI.Grep} and ${AI.Glob}.
`) {}

/** `glob` needs bash 4 (`globstar`), which a sandbox has and macOS's own bash does not. */
const globstar = Bun.spawnSync(["bash", "-O", "globstar", "-c", "true"]).exitCode === 0;

/** A sandbox that is this machine, with `home` as its home directory. */
const machine = (home: string): AI.Sandbox["Service"] => {
  const exec: AI.Sandbox["Service"]["exec"] = (command, options) =>
    Effect.promise(async () => {
      const child = Bun.spawn(
        typeof command === "string" ? ["bash", "-c", command] : [...command],
        {
          cwd: options?.cwd ?? home,
          env: { ...process.env, ...options?.env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    });
  return { exec } as AI.Sandbox["Service"];
};

/** A home directory with a repository in it, as the issues example's sandbox has. */
const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "coding-tools-" });
  yield* fs.makeDirectory(path.join(dir, "repo", "src"), { recursive: true });
  yield* fs.writeFileString(
    path.join(dir, "repo", "src", "export.ts"),
    "export const needle = 7391;\n",
  );
  yield* fs.writeFileString(path.join(dir, "repo", "README.md"), "nothing here\n");
  return dir;
});

for (const [name, tools] of [
  ["Pi", Layer.mergeAll(Pi.Grep, Pi.Glob)],
  ["OpenCode", Layer.mergeAll(OpenCode.Grep, OpenCode.Glob)],
] as const) {
  describe(`${name}'s search tools`, { tags: ["local"] }, () => {
    const run = <A, E>(
      effect: (
        call: (
          tool: string,
          parameters: unknown,
        ) => Effect.Effect<ToolResult, never, RuntimeContext>,
      ) => Effect.Effect<A, E, RuntimeContext>,
    ) =>
      Effect.suspend(() => {
        const harness = recording();
        return Effect.gen(function* () {
          const dir = yield* home;
          // Sending a message opens the harness, which is given the tools.
          yield* (yield* Searcher).get("s").send("search");
          return yield* effect((tool, parameters) =>
            Effect.orDie(harness.call(tool, parameters, "call-1", "c", machine(dir))),
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              harness.layer,
              AI.DefaultModel(Smart),
              tools,
              RuntimeContext.phantom,
            ).pipe(
              Layer.provideMerge(
                // The tools ask for a place to open sandboxes. None is opened here.
                Layer.mergeAll(ModelsLive, Layer.succeed(AI.Sandboxes, undefined as never)),
              ),
            ),
          ),
          Effect.provide(NodeServices.layer),
        );
      });

    it.live("grep searches a path under ~, as a process's prose names it", () =>
      run((call) =>
        Effect.gen(function* () {
          const found = yield* call("grep", { pattern: "needle", path: "~/repo" });
          expect(found.isError).toBe(false);
          expect(found.text).toContain("src/export.ts:1:export const needle = 7391;");
        }),
      ),
    );

    it.live("a parameter a model sends as null is read as left out", () =>
      run((call) =>
        Effect.gen(function* () {
          // What Llama 3.3 sends for the optional `include` and `path`.
          const found = yield* call("grep", { pattern: "needle", path: "~/repo", include: null });
          expect(found.text).toContain("export.ts");
          const everywhere = yield* call("grep", { pattern: "needle", path: null, include: null });
          expect(everywhere.text).toContain("repo/src/export.ts");
        }),
      ),
    );

    it.live("grep narrows to the files a glob includes", () =>
      run((call) =>
        Effect.gen(function* () {
          const none = yield* call("grep", { pattern: "needle", path: "~/repo", include: "*.md" });
          expect(JSON.parse(none.text)).toEqual({ matches: [], truncated: false });
        }),
      ),
    );

    it.live("a search of a path that is not there fails, and says why", () =>
      run((call) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(call("grep", { pattern: "needle", path: "~/missing" }));
          expect(String(exit)).toContain("No such file or directory");
        }),
      ),
    );

    it.live.skipIf(!globstar)("a glob of a path that is not there fails, and says why", () =>
      run((call) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(call("glob", { pattern: "*", path: "~/missing" }));
          expect(String(exit)).toContain("No such file or directory");
        }),
      ),
    );

    it.live.skipIf(!globstar)("glob finds files under ~", () =>
      run((call) =>
        Effect.gen(function* () {
          const found = yield* call("glob", { pattern: "**/*.ts", path: "~/repo" });
          expect(JSON.parse(found.text)).toEqual({ matches: ["src/export.ts"], truncated: false });
        }),
      ),
    );
  });
}

/**
 * The sandbox bake stager (`src/SandboxBake.ts`): the LOCAL repo is
 * staged — no network — as a worktree the image copies verbatim: the
 * committed HEAD tree (+ distilled), a REAL depth-1 `.git` derived
 * from the local object store, origin re-pointed at the publishable
 * remote, clean `git status`, and a commit-keyed fingerprint that
 * makes restaging a no-op until HEAD moves.
 */
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as AI from "alchemy/AI";
import { fixed as workspace } from "alchemy/Workspace";
import * as Effect from "effect/Effect";
import { ORG_REMOTE, stageBake } from "../src/SandboxBake.ts";

const run = <A, E>(program: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    program.pipe(Effect.provide(BunServices.layer), Effect.scoped) as Effect.Effect<
      A,
      E
    >,
  );

const execIn =
  (sandbox: AI.Sandbox["Service"]) =>
  (command: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* sandbox.exec(command, args, { timeout: 60_000 });
      if (!result.success) {
        return yield* Effect.fail(
          `${command} ${args.join(" ")} (exit ${result.exitCode}):\n${result.stderr}`,
        );
      }
      return result.stdout.trim();
    });

test(
  "stageBake stages the local repo as a publishable shallow worktree",
  () =>
    run(
      Effect.gen(function* () {
        const bake = yield* stageBake;

        const sandbox = yield* AI.makeSandboxLocal.pipe(
          Effect.provide(workspace(bake.dir)),
        );
        const sh = execIn(sandbox);

        // a REAL repo, on the branch, tracking the publishable origin
        expect(yield* sh("git", ["rev-parse", "--is-inside-work-tree"])).toBe(
          "true",
        );
        expect(yield* sh("git", ["remote", "get-url", "origin"])).toBe(
          ORG_REMOTE,
        );

        // the staged tree IS HEAD's tree by CONTENT — modes are
        // deliberately normalized (the artifact zip drops exec bits;
        // the image restores them via `git checkout -- .`)
        expect(
          yield* sh("git", [
            "-c",
            "core.filemode=false",
            "status",
            "--porcelain",
          ]),
        ).toBe("");

        // depth-1: the 100GB local object store did NOT come along
        expect(yield* sandbox.exists(".git/shallow")).toBe(true);

        // the repo content is really there (root + distilled)
        expect(yield* sandbox.exists("packages/alchemy/package.json")).toBe(
          true,
        );
        expect(yield* sandbox.exists("distilled/package.json")).toBe(true);

        // staged HEAD == the source repo's HEAD
        const source = yield* AI.makeSandboxLocal.pipe(
          Effect.provide(workspace(process.cwd())),
        );
        const sourceHead = yield* execIn(source)("git", ["rev-parse", "HEAD"]);
        expect(yield* sh("git", ["rev-parse", "HEAD"])).toBe(sourceHead);

        // restaging is a marker hit: same fingerprint, no re-derive
        const again = yield* stageBake;
        expect(again.fingerprint).toBe(bake.fingerprint);
        expect(again.dir).toBe(bake.dir);
      }),
    ),
  240_000,
);

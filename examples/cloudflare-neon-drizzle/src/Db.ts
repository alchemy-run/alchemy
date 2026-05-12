import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

/**
 * A Drizzle schema + Neon project + feature branch. The branch's
 * `migrationsDir` is wired to the schema resource's `out` output, so the
 * provider order becomes:
 *
 *   1. `Drizzle.Schema` regenerates pending migration SQL files.
 *   2. `Neon.Branch` scans the directory and applies any new migrations
 *      transactionally.
 */
export const NeonDb = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  // Stages are organised in two tiers:
  //
  //   - `staging-*` stages own the long-lived Neon project (the data
  //     plane). They're deployed once per PR / preview namespace.
  //   - `pr-*` stages reference the parallel `staging-pr-*` project
  //     and only own ephemeral compute (branch + Hyperdrive + Worker).
  //
  // Deriving `staging-${stage}` instead of a single global `"staging"`
  // keeps each test / PR isolated — two concurrent PRs never race on
  // the same Neon project. Locally (`dev_<user>`, etc.) we just create
  // a fresh project.
  const project = stage.startsWith("pr-")
    ? yield* Neon.Project.ref("app-db", { stage: `staging-${stage}` })
    : yield* Neon.Project("app-db", {
        region: "aws-us-east-1",
      });

  const branch = yield* Neon.Branch("app-branch", {
    project,
    migrationsDir: schema.out,
  });

  return { project, branch, schema };
});

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDb;
  return yield* Cloudflare.Hyperdrive("app-hyperdrive", {
    origin: branch.origin,
  });
});

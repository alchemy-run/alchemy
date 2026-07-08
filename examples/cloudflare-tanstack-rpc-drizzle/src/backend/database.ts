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
export const NeonDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/backend/schema.ts",
    out: "./migrations",
  });

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

/**
 * A Hyperdrive pool in front of the Neon branch. The backend worker binds to
 * this so Drizzle talks to Postgres through Cloudflare's connection pooler.
 */
export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDatabase;
  return yield* Cloudflare.Hyperdrive.Connection("app-hyperdrive", {
    origin: branch.origin,
    caching: {
      disabled: true,
    },
  });
});

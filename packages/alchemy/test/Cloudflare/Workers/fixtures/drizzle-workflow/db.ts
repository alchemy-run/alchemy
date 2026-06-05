import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Effect from "effect/Effect";
import path from "node:path";

/**
 * Neon + Cloudflare wiring for the Drizzle-in-Workflow regression test. A
 * Neon project + feature branch (migrated from the shared `migrations/`
 * directory, which only defines the `alchemy_postgres_widgets` table), fronted
 * by a Cloudflare Hyperdrive pointed at the branch's Postgres origin.
 */
export const NeonDb = Effect.gen(function* () {
  // Resolved inside the effect (not at module scope) so it only runs at
  // deploy time — `import.meta.filename` is undefined in the bundled worker.
  const migrationsDir = yield* Effect.sync(() =>
    path.join(import.meta.filename ?? ".", "..", "migrations"),
  );

  const project = yield* Neon.Project("DrizzleWorkflowProject", {
    region: "aws-us-east-1",
  });

  const branch = yield* Neon.Branch("DrizzleWorkflowBranch", {
    project,
    migrationsDir,
  });

  return { project, branch };
});

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDb;
  return yield* Cloudflare.Hyperdrive("DrizzleWorkflowEdge", {
    origin: branch.origin,
  });
});

import * as PgClient from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { relations } from "./schema.ts";

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
  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  const project = yield* Neon.Project("app-db", {
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

export const Postgres = makeWithDefaults({
  relations,
});

export const layerPgClient = (hyperdrive: Cloudflare.HyperdriveBindingClient) =>
  hyperdrive.connectionString.pipe(
    Effect.map((url) => PgClient.layer({ url })),
    Layer.unwrap,
  );

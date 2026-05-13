import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Drizzle from "@/Drizzle/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Effect from "effect/Effect";

const FIXTURES_DIR = new URL(".", import.meta.url).pathname;

export const Schema = Drizzle.Schema("BetterAuthPgSchema", {
  schema: `${FIXTURES_DIR}schema.ts`,
  out: `${FIXTURES_DIR}migrations`,
});

export const Project = Neon.Project("BetterAuthPgProject", {
  region: "aws-us-east-1",
});

export const Branch = Effect.gen(function* () {
  const project = yield* Project;
  const schema = yield* Schema;
  return yield* Neon.Branch("BetterAuthPgBranch", {
    project,
    migrationsDir: schema.out,
  });
});

export const Hyperdrive = Effect.gen(function* () {
  const branch = yield* Branch;
  return yield* Cloudflare.Hyperdrive("BetterAuthPgHyperdrive", {
    origin: branch.origin,
  });
});

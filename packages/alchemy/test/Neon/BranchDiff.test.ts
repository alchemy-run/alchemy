import { Branch, BranchProvider, type BranchProps } from "@/Neon/Branch";
import type { PostgresOrigin } from "@/Neon/PostgresOrigin";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({
  providers: BranchProvider().pipe(
    Layer.provideMerge(
      Layer.succeed(
        SDK.Credentials,
        Effect.succeed({
          apiKey: Redacted.make("branch-diff-test"),
          apiBaseUrl: "https://neon.example.com",
        }),
      ),
    ),
  ),
  state: inMemoryState(),
});

const origin: PostgresOrigin = {
  scheme: "postgresql",
  host: "ep-example.us-east-2.aws.neon.tech",
  port: 5432,
  database: "neondb",
  user: "neondb_owner",
  password: Redacted.make("password"),
};

const output = {
  branchId: "br-existing",
  branchName: "preview",
  projectId: "project",
  parentBranchId: "br-main",
  parentLsn: undefined,
  parentTimestamp: undefined,
  initSource: "parent-data" as const,
  protected: false,
  default: false,
  expiresAt: undefined,
  databaseName: "neondb",
  roleName: "neondb_owner",
  connectionUri: "postgresql://ep-example.us-east-2.aws.neon.tech/neondb",
  pooledConnectionUri:
    "postgresql://ep-example-pooler.us-east-2.aws.neon.tech/neondb",
  origin,
  pooledOrigin: origin,
  migrationsDir: undefined,
  migrationsTable: undefined,
  migrationsHashes: {},
  importHashes: {},
};

const olds: BranchProps = {
  project: { projectId: "project" },
  name: "preview",
  parentBranch: { branchId: "br-main" },
};

const diff = (news: Record<string, unknown>) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Branch);
    return yield* provider.diff!({
      id: "Preview",
      fqn: "Preview",
      instanceId: "instance",
      olds,
      news: { ...olds, ...news } as BranchProps,
      output,
      oldBindings: [],
      newBindings: [],
    });
  });

test.provider(
  "diff replaces a branch whose fork point is unknown until apply",
  () =>
    Effect.gen(function* () {
      for (const news of [
        { parentTimestamp: Output.literal("2026-01-01T00:00:00Z") },
        { parentLsn: Output.literal("0/3FA01B0") },
        { initSource: Output.literal("schema-only") },
        { parentBranch: Output.literal({ branchId: "br-new" }) },
      ]) {
        expect(yield* diff(news)).toEqual({
          action: "replace",
          deleteFirst: true,
        });
      }
      expect(
        yield* diff({
          name: undefined,
          parentTimestamp: Output.literal("2026-01-01T00:00:00Z"),
        }),
      ).toEqual({ action: "replace", deleteFirst: false });
    }),
  { tags: ["unit", "provider:neon", "provider:neon:branch", "local"] },
);

test.provider(
  "diff does not replace for a known fork point or other unresolved inputs",
  () =>
    Effect.gen(function* () {
      expect(yield* diff({})).toBeUndefined();
      expect(
        yield* diff({ expiresAt: Output.literal("2027-01-01T00:00:00Z") }),
      ).toBeUndefined();
    }),
  { tags: ["unit", "provider:neon", "provider:neon:branch", "local"] },
);

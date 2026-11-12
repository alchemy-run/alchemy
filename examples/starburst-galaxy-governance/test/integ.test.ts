import { expect } from "bun:test";
import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Test from "@alchemy.run/test/Bun";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

// Read Galaxy as the deploying profile's API client.
const galaxyApi = StarburstGalaxy.fromAuthProvider().pipe(
  Layer.provideMerge(StarburstGalaxy.StarburstGalaxyAuth),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "the policy filters EU rows and hashes emails for the analysts' role",
  Effect.gen(function* () {
    const { policyId, roleId, rowFilterId, columnMaskId } = yield* stack;
    const policy = yield* galaxy.policy.getPolicy({ policyId });
    expect(policy.roleId).toBe(roleId);
    expect(policy.scopes.flatMap((scope) => scope.rowFilterIds ?? [])).toEqual([rowFilterId]);
    expect(policy.scopes.flatMap((scope) => scope.columnMaskIds ?? [])).toEqual([columnMaskId]);
  }).pipe(Effect.provide(galaxyApi)),
  { timeout: 60_000 },
);

test(
  "the email column carries the pii tag",
  Effect.gen(function* () {
    const { catalogId, tagId } = yield* stack;
    const column = yield* galaxy.discovery.getCatalogSchemaTableColumn({
      catalogId,
      schemaId: "crm",
      tableId: "customers",
      columnId: "email",
    });
    expect(column.tags.map((tag) => tag.tagId)).toContain(tagId);
  }).pipe(Effect.provide(galaxyApi)),
  { timeout: 60_000 },
);

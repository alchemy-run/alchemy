import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const currentTeamId = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId;
});

/** Read the config's items out-of-band as a plain record. */
const fetchItems = (edgeConfigId: string, teamId: string | undefined) =>
  globalConfig
    .getEdgeConfigItems({ edgeConfigId, teamId })
    .pipe(
      Effect.map((items) =>
        Object.fromEntries(items.map((item) => [item.key, item.value])),
      ),
    );

/** Bounded typed wait until the config is gone. */
const waitUntilGone = (edgeConfigId: string, teamId: string | undefined) =>
  Effect.gen(function* () {
    const state = yield* globalConfig
      .getEdgeConfig({ edgeConfigId, teamId })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (s) => s === "gone",
          times: 8,
        }),
      );
    expect(state).toEqual("gone");
  });

/** Read one item from the Edge Config data plane (edge-config.vercel.com). */
const readDataPlaneItem = (edgeConfigId: string, token: string, key: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(
        `https://edge-config.vercel.com/${edgeConfigId}/item/${key}`,
      ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`)),
    );
    const text = yield* response.text;
    return { status: response.status, text };
  });

test.provider(
  "create, update, and delete an Edge Config with declarative items",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const teamId = yield* currentTeamId;

      const created = yield* stack.deploy(
        Vercel.EdgeConfig("Lifecycle", {
          items: {
            greeting: "hello",
            flags: { beta: true, limit: 10 },
          },
        }),
      );

      expect(created.edgeConfigId).toMatch(/^ecfg_/);
      expect(created.slug).toBeDefined();
      expect(created.digest).toBeDefined();
      expect(created.itemCount).toEqual(2);

      // Out-of-band verification via distilled (management API).
      const observed = yield* globalConfig.getEdgeConfig({
        edgeConfigId: created.edgeConfigId,
        teamId,
      });
      expect(observed.slug).toEqual(created.slug);
      const items = yield* fetchItems(created.edgeConfigId, teamId);
      expect(items).toEqual({
        greeting: "hello",
        flags: { beta: true, limit: 10 },
      });

      // Update: change one value, add a key, remove a key.
      const updated = yield* stack.deploy(
        Vercel.EdgeConfig("Lifecycle", {
          items: {
            greeting: "hi",
            newKey: [1, 2, 3],
          },
        }),
      );
      // Same physical config — items updates never replace.
      expect(updated.edgeConfigId).toEqual(created.edgeConfigId);
      expect(updated.slug).toEqual(created.slug);
      const updatedItems = yield* fetchItems(created.edgeConfigId, teamId);
      expect(updatedItems).toEqual({
        greeting: "hi",
        newKey: [1, 2, 3],
      });

      // No-op redeploy converges without churn.
      const noop = yield* stack.deploy(
        Vercel.EdgeConfig("Lifecycle", {
          items: {
            greeting: "hi",
            newKey: [1, 2, 3],
          },
        }),
      );
      expect(noop.edgeConfigId).toEqual(created.edgeConfigId);
      expect(noop.digest).toEqual(updated.digest);

      yield* stack.destroy();
      yield* waitUntilGone(created.edgeConfigId, teamId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "out-of-band item drift converges on redeploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const teamId = yield* currentTeamId;

      const config = yield* stack.deploy(
        Vercel.EdgeConfig("Drift", {
          items: { a: "1", b: "2" },
        }),
      );

      // Drift out-of-band: overwrite a managed key and add a foreign one.
      yield* globalConfig.patchEdgeConfigItems({
        edgeConfigId: config.edgeConfigId,
        teamId,
        items: [
          { operation: "upsert", key: "a", value: "drifted" },
          { operation: "upsert", key: "c", value: "foreign" },
        ],
      });
      const drifted = yield* fetchItems(config.edgeConfigId, teamId);
      expect(drifted).toEqual({ a: "drifted", b: "2", c: "foreign" });

      // Redeploy with one declared change. (An identical declaration
      // short-circuits at plan time — "no changes" — so reconcile only runs
      // when props differ.) The item sync diffs OBSERVED cloud items against
      // the declaration, so it must also revert the drifted key and delete
      // the foreign one.
      const redeployed = yield* stack.deploy(
        Vercel.EdgeConfig("Drift", {
          items: { a: "1", b: "3" },
        }),
      );
      expect(redeployed.edgeConfigId).toEqual(config.edgeConfigId);
      const converged = yield* fetchItems(config.edgeConfigId, teamId);
      expect(converged).toEqual({ a: "1", b: "3" });

      yield* stack.destroy();
      yield* waitUntilGone(config.edgeConfigId, teamId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "rename in place and manage the schema lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const teamId = yield* currentTeamId;

      const schema = {
        type: "object",
        properties: { greeting: { type: "string" } },
      };
      const created = yield* stack.deploy(
        Vercel.EdgeConfig("Rename", {
          slug: "alchemy_test_ec_rename_a",
          schema,
          items: { greeting: "hello" },
        }),
      );
      expect(created.slug).toEqual("alchemy_test_ec_rename_a");

      const observedSchema = yield* globalConfig.getEdgeConfigSchema({
        edgeConfigId: created.edgeConfigId,
        teamId,
      });
      expect(observedSchema).toEqual({ definition: schema });

      // Rename — slug is mutable via PUT, so the id must survive.
      const renamed = yield* stack.deploy(
        Vercel.EdgeConfig("Rename", {
          slug: "alchemy_test_ec_rename_b",
          schema,
          items: { greeting: "hello" },
        }),
      );
      expect(renamed.edgeConfigId).toEqual(created.edgeConfigId);
      expect(renamed.slug).toEqual("alchemy_test_ec_rename_b");

      // Drop the schema declaration — the provider deletes the stored schema.
      yield* stack.deploy(
        Vercel.EdgeConfig("Rename", {
          slug: "alchemy_test_ec_rename_b",
          items: { greeting: "hello" },
        }),
      );
      const removedSchema = yield* globalConfig.getEdgeConfigSchema({
        edgeConfigId: created.edgeConfigId,
        teamId,
      });
      // Schema-less configs answer an empty 204, which decodes to `{}`.
      expect(removedSchema).toEqual({});

      yield* stack.destroy();
      yield* waitUntilGone(created.edgeConfigId, teamId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "read token mints and the data plane serves items",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const teamId = yield* currentTeamId;

      const config = yield* stack.deploy(
        Vercel.EdgeConfig("DataPlane", {
          items: { dataplane: "v1" },
        }),
      );

      // Mint a read token out-of-band (the once-disclosed plaintext token).
      const minted = yield* globalConfig.createEdgeConfigToken({
        edgeConfigId: config.edgeConfigId,
        teamId,
        label: "alchemy-test-dataplane",
      });
      expect(minted.token).toBeDefined();

      // Data-plane read via the connection-string endpoint. ITEM writes
      // propagate sub-second (probe B3: ~60ms), but a freshly minted TOKEN
      // can answer 401 for ~20-30s before the data plane accepts it —
      // bounded retry over that window.
      const first = yield* readDataPlaneItem(
        config.edgeConfigId,
        minted.token,
        "dataplane",
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("4 seconds"),
          until: (r) => r.status === 200 && r.text === '"v1"',
          times: 10,
        }),
      );
      expect(first.text).toEqual('"v1"');

      // Update the item and confirm the data plane converges.
      yield* stack.deploy(
        Vercel.EdgeConfig("DataPlane", {
          items: { dataplane: "v2" },
        }),
      );
      const second = yield* readDataPlaneItem(
        config.edgeConfigId,
        minted.token,
        "dataplane",
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (r) => r.status === 200 && r.text === '"v2"',
          times: 8,
        }),
      );
      expect(second.text).toEqual('"v2"');

      yield* stack.destroy();
      yield* waitUntilGone(config.edgeConfigId, teamId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

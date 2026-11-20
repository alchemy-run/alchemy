import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import * as schemaValidation from "@distilled.cloud/cloudflare/schema-validation";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails } from "../../lookup.ts";
import { testName } from "../../names.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:apishield",
  "provider:cloudflare:schemavalidation",
  "live",
];

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// The operation's (method, host, endpoint) tuple is its identity on the
// zone, so the endpoint carries the test stage.
const ENDPOINT = `/${testName("alchemy-operation-lookup")}`;

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "ApiShieldOperationLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;
    const operation = yield* Cloudflare.ApiShield.Operation("lookup-target", {
      zoneId,
      method: "GET",
      host: zoneName,
      endpoint: ENDPOINT,
    });
    return { zoneId, operationId: operation.operationId.as<string>() };
  }).pipe(Effect.orDie),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up operation takes a schema validation override, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { zoneId, operationId } = yield* target;

      const program = Effect.gen(function* () {
        const byTuple = Cloudflare.ApiShield.Operation.lookup({
          zoneId,
          method: "GET",
          host: zoneName,
          endpoint: ENDPOINT,
        });
        const byId = Cloudflare.ApiShield.Operation.lookup({ zoneId, operationId });
        const setting = yield* Cloudflare.SchemaValidation.OperationSetting(
          "operation-lookup-setting",
          { zoneId, operationId: byTuple.operationId, mitigationAction: "block" },
        );
        return { settingOperationId: setting.operationId, endpoint: byId.endpoint };
      });
      const out = yield* stack.deploy(program);
      expect(out.settingOperationId).toBe(operationId);
      expect(out.endpoint).toBe(ENDPOINT);

      const live = yield* schemaValidation.getSettingOperation({ zoneId, operationId });
      expect(live.mitigationAction).toBe("block");

      // A lookup re-resolves to the same operation, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["operation-lookup-setting"].action).toBe("noop");

      // Destroying the stack clears its override but leaves the operation.
      yield* stack.destroy();
      const survivor = yield* apiGateway.getOperation({ zoneId, operationId });
      expect(survivor.endpoint).toBe(ENDPOINT);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing operation fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const endpoint = `${ENDPOINT}-missing`;
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("operation-lookup-missing", {
            script: callerScript,
            env: {
              REF: Cloudflare.ApiShield.Operation.lookup({
                zoneId,
                method: "GET",
                host: zoneName,
                endpoint,
              }).operationId,
            },
          }),
        ),
        ["LookupNotFoundError", endpoint],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an operation this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const managed = () =>
        Cloudflare.ApiShield.Operation("lookup-managed", {
          zoneId,
          method: "POST",
          host: zoneName,
          endpoint: `${ENDPOINT}-managed`,
        });
      const { operationId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("operation-lookup-managed-caller", {
              script: callerScript,
              env: {
                REF: Cloudflare.ApiShield.Operation.lookup({ zoneId, operationId }).operationId,
              },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

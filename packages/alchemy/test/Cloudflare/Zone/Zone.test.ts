import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Vitest";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Cloudflare.providers() });

// `Cloudflare.Zone` real-deploy tests are skipped by default: creating and
// deleting a zone requires a domain you actually own. Drop the `.skip` and
// set `TEST_ZONE_NAME` to a domain you control to run them.
const TEST_ZONE = process.env.TEST_ZONE_NAME ?? "example-alchemy-zone.test";

test.provider.skip(
  "import existing zone by name returns matching attributes",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      const imported = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.importZone(TEST_ZONE);
        }),
      );

      expect(imported.name).toBe(TEST_ZONE);
      expect(imported.accountId).toBe(accountId);
      expect(imported.zoneId).toMatch(/^[a-f0-9]{32}$/i);
    }),
);

test.provider.skip(
  "create zone retains by default — destroy() opts in to deletion",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      const zone = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone("CreatedZone", {
            name: TEST_ZONE,
          }).pipe(destroy());
        }),
      );

      expect(zone.name).toBe(TEST_ZONE);
      expect(zone.accountId).toBe(accountId);

      const live = yield* zones.getZone({ zoneId: zone.zoneId });
      expect(live.id).toBe(zone.zoneId);

      yield* stack.destroy();
    }),
);

test.provider.skip(
  "importZone dedups multiple calls to the same lookup string",
  (stack) =>
    Effect.gen(function* () {
      // Multiple `importZone(...)` calls with the same lookup string share an
      // Action FQN, so the body runs exactly once even when consumed twice.
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* Cloudflare.importZone(TEST_ZONE);
          const b = yield* Cloudflare.importZone(TEST_ZONE);
          return { a, b };
        }),
      );

      expect(result.a.zoneId).toBe(result.b.zoneId);
    }),
);

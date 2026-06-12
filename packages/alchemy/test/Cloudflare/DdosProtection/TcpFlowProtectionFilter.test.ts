import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import * as ddos from "@distilled.cloud/cloudflare/ddos-protection";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Advanced TCP Protection is a Magic Transit (Enterprise add-on)
// entitlement that the testing account does not have — every API call fails
// with the typed `AdvancedTcpProtectionNotEntitled` error (Cloudflare code
// 8888; asserted in AllowlistEntry.test.ts). The lifecycle suite is gated
// behind an opt-in env var for entitled accounts.
const magicTransit = process.env.CLOUDFLARE_TEST_MAGIC_TRANSIT;

const accountId = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return accountId;
});

test.provider.skipIf(!magicTransit)(
  "creates a TCP flow protection filter, updates it in place, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const acct = yield* accountId;

      yield* stack.destroy();

      // Create.
      const filter = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.TcpFlowProtectionFilter("Filter", {
            expression: "tcp.dstport in {443}",
            mode: "monitoring",
          });
        }),
      );
      expect(filter.expression).toEqual("tcp.dstport in {443}");
      expect(filter.mode).toEqual("monitoring");

      // Out-of-band verification via the distilled API.
      const live =
        yield* ddos.getAdvancedTcpProtectionTcpFlowProtectionFilterItem({
          accountId: acct,
          filterId: filter.filterId,
        });
      expect(live.expression).toEqual("tcp.dstport in {443}");

      // In-place update — expression and mode are patched, id is stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.TcpFlowProtectionFilter("Filter", {
            expression: "tcp.srcport in {179}",
            mode: "enabled",
          });
        }),
      );
      expect(updated.filterId).toEqual(filter.filterId);
      expect(updated.expression).toEqual("tcp.srcport in {179}");
      expect(updated.mode).toEqual("enabled");

      yield* stack.destroy();

      // Gone — the typed TcpFlowProtectionFilterNotFound error proves
      // deletion.
      const error = yield* ddos
        .getAdvancedTcpProtectionTcpFlowProtectionFilterItem({
          accountId: acct,
          filterId: filter.filterId,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("TcpFlowProtectionFilterNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

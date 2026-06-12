import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic hostname on the testing zone — hostnames are unique per
// account, so reruns converge on the same route instead of leaking.
const HOSTNAME = "alchemy-test-hr.alchemy-test-2.us";

// Read a hostname route out-of-band, mapping "gone" (404 or a tombstoned
// deletedAt) to undefined.
const getLiveRoute = (accountId: string, hostnameRouteId: string) =>
  zeroTrust.getNetworkHostnameRoute({ accountId, hostnameRouteId }).pipe(
    Effect.map((r) => (r.deletedAt != null ? undefined : r)),
    Effect.catchTag("HostnameRouteNotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "create, update comment in place, and destroy a hostname route",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel("HrTunnel", {
            adopt: true,
          });
          const route = yield* Cloudflare.TunnelHostnameRoute("AppRoute", {
            hostname: HOSTNAME,
            tunnelId: tunnel.tunnelId,
            comment: "v1",
          });
          return { tunnel, route };
        }),
      );

      expect(initial.route.hostnameRouteId).toBeDefined();
      expect(initial.route.accountId).toEqual(accountId);
      expect(initial.route.hostname).toEqual(HOSTNAME);
      expect(initial.route.tunnelId).toEqual(initial.tunnel.tunnelId);
      expect(initial.route.comment).toEqual("v1");

      const live = yield* getLiveRoute(
        accountId,
        initial.route.hostnameRouteId,
      );
      expect(live?.hostname).toEqual(HOSTNAME);
      expect(live?.comment).toEqual("v1");

      // Comment update converges in place — same route id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel("HrTunnel", {
            adopt: true,
          });
          const route = yield* Cloudflare.TunnelHostnameRoute("AppRoute", {
            hostname: HOSTNAME,
            tunnelId: tunnel.tunnelId,
            comment: "v2",
          });
          return { route };
        }),
      );
      expect(updated.route.hostnameRouteId).toEqual(
        initial.route.hostnameRouteId,
      );
      expect(updated.route.comment).toEqual("v2");

      const liveUpdated = yield* getLiveRoute(
        accountId,
        initial.route.hostnameRouteId,
      );
      expect(liveUpdated?.comment).toEqual("v2");

      yield* stack.destroy();

      // Cloudflare tombstones hostname routes; gone = 404 or deletedAt set.
      const afterDestroy = yield* getLiveRoute(
        accountId,
        initial.route.hostnameRouteId,
      );
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

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

// Deterministic identifiers — the portal id is the API identity, so reruns
// converge on the same portal instead of leaking.
const PORTAL_ID = "alchemy-test-mcp-portal";
const HOSTNAME = "alchemy-test-mcp.alchemy-test-2.us";

// Read a portal out-of-band, mapping "gone" to undefined.
const getLivePortal = (accountId: string, id: string) =>
  zeroTrust
    .readAccessAiControlMcpPortal({ accountId, id })
    .pipe(
      Effect.catchTag("McpPortalNotFound", () => Effect.succeed(undefined)),
    );

test.provider(
  "create, update in place, and destroy an MCP portal",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const portal = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccessMcpPortal("AiPortal", {
            portalId: PORTAL_ID,
            hostname: HOSTNAME,
            description: "alchemy mcp portal v1",
          });
        }),
      );

      expect(portal.portalId).toEqual(PORTAL_ID);
      expect(portal.accountId).toEqual(accountId);
      expect(portal.hostname).toEqual(HOSTNAME);
      expect(portal.name).toEqual(PORTAL_ID);
      expect(portal.description).toEqual("alchemy mcp portal v1");
      // Observed server-side default (no allowCodeMode requested).
      expect(portal.allowCodeMode).toEqual(true);
      expect(portal.secureWebGateway).toEqual(false);

      const live = yield* getLivePortal(accountId, PORTAL_ID);
      expect(live?.id).toEqual(PORTAL_ID);
      expect(live?.hostname).toEqual(HOSTNAME);

      // Name + description update converges in place — same portal id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccessMcpPortal("AiPortal", {
            portalId: PORTAL_ID,
            name: "Alchemy AI Portal",
            hostname: HOSTNAME,
            description: "alchemy mcp portal v2",
            secureWebGateway: true,
          });
        }),
      );
      expect(updated.portalId).toEqual(PORTAL_ID);
      expect(updated.name).toEqual("Alchemy AI Portal");
      expect(updated.description).toEqual("alchemy mcp portal v2");
      expect(updated.secureWebGateway).toEqual(true);

      const liveUpdated = yield* getLivePortal(accountId, PORTAL_ID);
      expect(liveUpdated?.name).toEqual("Alchemy AI Portal");
      expect(liveUpdated?.secureWebGateway).toEqual(true);

      // No-op redeploy keeps the same portal without drift.
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccessMcpPortal("AiPortal", {
            portalId: PORTAL_ID,
            name: "Alchemy AI Portal",
            hostname: HOSTNAME,
            description: "alchemy mcp portal v2",
            secureWebGateway: true,
          });
        }),
      );
      expect(noop.portalId).toEqual(PORTAL_ID);

      yield* stack.destroy();

      const afterDestroy = yield* getLivePortal(accountId, PORTAL_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

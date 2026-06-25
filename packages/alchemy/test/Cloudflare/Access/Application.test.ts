import * as AdoptPolicy from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Self-hosted Access Applications require a domain that belongs to an
// *active* zone in the account (pending zones are rejected with "domain does
// not belong to zone"). Tests can't activate a fresh zone (that requires
// nameserver delegation), so we adopt the shared pre-existing active zone.
// It must stay on the default `retain` removal policy: it's registered via
// Cloudflare Registrar, and the API refuses to delete registrar zones.
const zoneName =
  process.env.CLOUDFLARE_TEST_ACCESS_ZONE_NAME ?? "alchemy-test-2.us";

test.provider(
  "create and delete a self_hosted application gated by a reusable policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-app.${zoneName}`;
      const { app, policy } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const policy = yield* Cloudflare.AccessPolicy("AllowExampleDomain", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.AccessApplication("SelfHostedApp", {
            type: "self_hosted",
            domain,
            sessionDuration: "24h",
            policies: [policy.policyId],
          });
          return { app, policy };
        }),
      );

      expect(app.applicationId).toBeDefined();
      expect(app.type).toEqual("self_hosted");
      expect(app.domain).toEqual(domain);
      expect(app.aud.length).toBeGreaterThan(0);
      expect(policy.policyId.length).toBeGreaterThan(0);

      const live = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: app.applicationId,
      });
      const liveRecord = live as unknown as {
        id?: string | null;
        type?: string | null;
        policies?: ReadonlyArray<{ id?: string | null }> | null;
      };
      expect(liveRecord.id).toEqual(app.applicationId);
      expect(liveRecord.type).toEqual("self_hosted");
      expect(liveRecord.policies?.length ?? 0).toBeGreaterThanOrEqual(1);
      const liveIds = (liveRecord.policies ?? []).map((p) => p.id);
      expect(liveIds).toContain(policy.policyId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "create and delete a warp device-enrollment application",
  (stack) =>
    Effect.gen(function* () {
      const idp = process.env.CLOUDFLARE_TEST_GOOGLE_IDP_ID;
      if (!idp) {
        // Skip when no Google IdP is configured in the test account.
        return;
      }

      yield* stack.destroy();

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          // Warp apps derive their domain from the auth domain — no zone needed.
          const policy = yield* Cloudflare.AccessPolicy("WarpAllowDomain", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.AccessApplication("WarpEnroll", {
            type: "warp",
            name: "Alchemy Warp Test",
            sessionDuration: "720h",
            allowedIdps: [idp],
            autoRedirectToIdentity: true,
            policies: [policy.policyId],
          });
        }),
      );

      expect(app.type).toEqual("warp");
      // Cloudflare derives the warp domain as `${authDomain}/warp`.
      expect(app.domain.endsWith("/warp")).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("list enumerates the deployed access application", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const domain = `alchemy-test-list-app.${zoneName}`;
    const app = yield* stack.deploy(
      Effect.gen(function* () {
        yield* Cloudflare.Zone("TestZone", {
          name: zoneName,
        }).pipe(AdoptPolicy.adopt(true));
        const policy = yield* Cloudflare.AccessPolicy("ListAllowDomain", {
          name: "Allow example.com",
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
        });
        return yield* Cloudflare.AccessApplication("ListApp", {
          type: "self_hosted",
          domain,
          sessionDuration: "24h",
          policies: [policy.policyId],
        });
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.AccessApplication);

    // `list()` enumerates every Access application in the account. The
    // provider already rides out the transient enumeration failures internally
    // (the typed `AccessReferenceNotFound` from a sibling app mid-teardown
    // still referencing a deleted policy, plus throttling 403s), so here we
    // only poll until our own freshly created app becomes visible.
    const all = yield* provider.list().pipe(
      Effect.flatMap((rows) =>
        rows.some((a) => a.applicationId === app.applicationId)
          ? Effect.succeed(rows)
          : Effect.fail({ _tag: "AppNotListed" as const }),
      ),
      Effect.retry({
        while: (e) => e._tag === "AppNotListed",
        schedule: Schedule.spaced("2 seconds"),
        times: 15,
      }),
    );

    const match = all.find((a) => a.applicationId === app.applicationId);
    expect(match).toBeDefined();
    expect(match?.type).toEqual("self_hosted");
    expect(match?.aud.length).toBeGreaterThan(0);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "update policies in place keeps the applicationId stable",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-update-policies.${zoneName}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const allow = yield* Cloudflare.AccessPolicy("UpdateAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.AccessApplication("UpdatePolicies", {
            type: "self_hosted",
            domain,
            policies: [allow.policyId],
          });
        }),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const allow = yield* Cloudflare.AccessPolicy("UpdateAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const deny = yield* Cloudflare.AccessPolicy("UpdateDeny", {
            name: "Deny everyone else",
            decision: "deny",
            include: [{ everyone: {} }],
          });
          return yield* Cloudflare.AccessApplication("UpdatePolicies", {
            type: "self_hosted",
            domain,
            policies: [allow.policyId, deny.policyId],
          });
        }),
      );

      expect(updated.applicationId).toEqual(initial.applicationId);

      const live = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: updated.applicationId,
      });
      const liveRecord = live as unknown as {
        policies?: ReadonlyArray<unknown> | null;
      };
      expect(liveRecord.policies?.length ?? 0).toEqual(2);

      yield* stack.destroy();
    }).pipe(logLevel),
);

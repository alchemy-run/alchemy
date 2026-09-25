import * as AdoptPolicy from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import { Provider as ProviderService } from "@/Provider.ts";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as State from "@/State/State";
import {
  ACCOUNT_ID,
  notFound,
  session,
  stubCloudflare,
  type StubCall,
} from "../StubCloudflare.ts";

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
          yield* Cloudflare.Zone.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const policy = yield* Cloudflare.Access.Policy("AllowExampleDomain", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.Access.Application("SelfHostedApp", {
            type: "self_hosted",
            domain,
            sessionDuration: "24h",
            oauthConfiguration: {
              enabled: true,
              grant: {
                sessionDuration: "24h",
                accessTokenLifetime: "15m",
              },
              dynamicClientRegistration: {
                enabled: true,
                allowedUris: [],
                allowAnyOnLocalhost: true,
                allowAnyOnLoopback: true,
              },
            },
            policies: [policy.policyId],
          });
          return { app, policy };
        }),
      );

      expect(app.applicationId).toBeDefined();
      expect(app.type).toEqual("self_hosted");
      expect(app.domain).toEqual(domain);
      expect(app.aud.length).toBeGreaterThan(0);
      expect(app.oauthConfiguration?.enabled).toBe(true);
      expect(app.oauthConfiguration?.grant?.sessionDuration).toBe("24h");
      expect(app.oauthConfiguration?.grant?.accessTokenLifetime).toBe("15m");
      expect(app.oauthConfiguration?.dynamicClientRegistration?.enabled).toBe(
        true,
      );
      expect(
        app.oauthConfiguration?.dynamicClientRegistration?.allowedUris ?? [],
      ).toEqual([]);
      expect(policy.policyId.length).toBeGreaterThan(0);

      const live = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: app.applicationId,
      });
      const liveRecord = live as unknown as {
        id?: string | null;
        type?: string | null;
        policies?: ReadonlyArray<{ id?: string | null }> | null;
        oauthConfiguration?: {
          enabled?: boolean | null;
          grant?: {
            sessionDuration?: string | null;
            accessTokenLifetime?: string | null;
          } | null;
          dynamicClientRegistration?: {
            enabled?: boolean | null;
            allowedUris?: ReadonlyArray<string | null> | null;
            allowAnyOnLocalhost?: boolean | null;
            allowAnyOnLoopback?: boolean | null;
          } | null;
        } | null;
      };
      expect(liveRecord.id).toEqual(app.applicationId);
      expect(liveRecord.type).toEqual("self_hosted");
      expect(liveRecord.policies?.length ?? 0).toBeGreaterThanOrEqual(1);
      const liveIds = (liveRecord.policies ?? []).map((p) => p.id);
      expect(liveIds).toContain(policy.policyId);
      expect(liveRecord.oauthConfiguration?.enabled).toBe(true);
      expect(liveRecord.oauthConfiguration?.grant?.sessionDuration).toBe("24h");
      expect(liveRecord.oauthConfiguration?.grant?.accessTokenLifetime).toBe(
        "15m",
      );
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration?.enabled,
      ).toBe(true);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowedUris ??
          [],
      ).toEqual([]);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration
          ?.allowAnyOnLocalhost,
      ).toBe(true);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration
          ?.allowAnyOnLoopback,
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:access",
      "provider:cloudflare:zone",
      "live",
    ],
  },
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
          const policy = yield* Cloudflare.Access.Policy("WarpAllowDomain", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.Access.Application("WarpEnroll", {
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
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "list enumerates the deployed access application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domain = `alchemy-test-list-app.${zoneName}`;
      const app = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const policy = yield* Cloudflare.Access.Policy("ListAllowDomain", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.Access.Application("ListApp", {
            type: "self_hosted",
            domain,
            sessionDuration: "24h",
            policies: [policy.policyId],
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Access.Application,
      );

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
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:access",
      "provider:cloudflare:zone",
      "live",
    ],
  },
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
          yield* Cloudflare.Zone.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const allow = yield* Cloudflare.Access.Policy("UpdateAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.Access.Application("UpdatePolicies", {
            type: "self_hosted",
            domain,
            oauthConfiguration: {
              enabled: true,
              grant: {
                sessionDuration: "24h",
                accessTokenLifetime: "15m",
              },
              dynamicClientRegistration: {
                enabled: true,
                allowedUris: ["https://client.example.com/callback"],
                allowAnyOnLocalhost: true,
              },
            },
            policies: [allow.policyId],
          });
        }),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const allow = yield* Cloudflare.Access.Policy("UpdateAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const deny = yield* Cloudflare.Access.Policy("UpdateDeny", {
            name: "Deny everyone else",
            decision: "deny",
            include: [{ everyone: {} }],
          });
          return yield* Cloudflare.Access.Application("UpdatePolicies", {
            type: "self_hosted",
            domain,
            // Update one managed OAuth leaf while preserving omitted fields.
            oauthConfiguration: {
              dynamicClientRegistration: {
                allowAnyOnLoopback: true,
              },
            },
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
        oauthConfiguration?: {
          enabled?: boolean | null;
          grant?: {
            sessionDuration?: string | null;
            accessTokenLifetime?: string | null;
          } | null;
          dynamicClientRegistration?: {
            enabled?: boolean | null;
            allowedUris?: ReadonlyArray<string | null> | null;
            allowAnyOnLocalhost?: boolean | null;
            allowAnyOnLoopback?: boolean | null;
          } | null;
        } | null;
      };
      expect(liveRecord.policies?.length ?? 0).toEqual(2);
      // The partial desired body must merge over the live managed OAuth
      // configuration before the PUT-style application update.
      expect(liveRecord.oauthConfiguration?.enabled).toBe(true);
      expect(liveRecord.oauthConfiguration?.grant?.sessionDuration).toBe("24h");
      expect(liveRecord.oauthConfiguration?.grant?.accessTokenLifetime).toBe(
        "15m",
      );
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration?.enabled,
      ).toBe(true);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowedUris,
      ).toEqual(["https://client.example.com/callback"]);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration
          ?.allowAnyOnLocalhost,
      ).toBe(true);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration
          ?.allowAnyOnLoopback,
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:access",
      "provider:cloudflare:zone",
      "live",
    ],
  },
);

// Regression test for the cold-recovery `read` fallback: after state loss
// (or a stage migration rebuilding state via the adoption probe) there is
// no persisted `applicationId`. Without the domain-match fallback the
// engine plans a blind `create` and Cloudflare accepts a DUPLICATE
// application on the same domain with a fresh `aud`. With it, the app is
// found by domain, surfaces as `Unowned`, and adopts cleanly under
// `adopt(true)` — same applicationId/aud, no duplicate.
test.provider(
  "cold-recovery: read matches an existing app by domain after state loss",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-cold-read.${zoneName}`;
      const program = Effect.gen(function* () {
        yield* Cloudflare.Zone.Zone("TestZone", {
          name: zoneName,
        }).pipe(AdoptPolicy.adopt(true));
        const policy = yield* Cloudflare.Access.Policy("ColdReadAllow", {
          name: "Allow example.com (cold read)",
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
        });
        return yield* Cloudflare.Access.Application("ColdReadApp", {
          type: "self_hosted",
          domain,
          sessionDuration: "24h",
          policies: [policy.policyId],
        });
      });

      const first = yield* stack.deploy(program);
      expect(first.applicationId).toBeDefined();
      expect(first.aud.length).toBeGreaterThan(0);

      // Simulate state loss for the application only: the app still
      // exists in Cloudflare, but the engine has no applicationId.
      const state = yield* yield* State.State;
      yield* state.delete({
        stack: stack.name,
        stage: stack.stage,
        fqn: "ColdReadApp",
      });

      // Without adopt, the domain-matched app is Unowned — the engine
      // must refuse the takeover rather than create a duplicate.
      const refused = yield* stack.deploy(program).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(AdoptPolicy.OwnedBySomeoneElse);

      // With adopt, the SAME app is adopted: identity is preserved and
      // no duplicate application appears on the domain.
      const readopted = yield* stack.deploy(
        program.pipe(AdoptPolicy.adopt(true)),
      );
      expect(readopted.applicationId).toEqual(first.applicationId);
      expect(readopted.aud).toEqual(first.aud);

      const all = yield* zeroTrust.listAccessApplicationsForAccount
        .items({ accountId })
        .pipe(Stream.runCollect);
      const onDomain = Array.from(all).filter(
        (a) => (a as { domain?: string | null }).domain === domain,
      );
      expect(onDomain).toHaveLength(1);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:access",
      "provider:cloudflare:zone",
      "live",
    ],
  },
);

/** Structural view of live application policies for inline-policy asserts. */
interface LiveInlineApp {
  policies?: ReadonlyArray<{
    id?: string | null;
    decision?: string | null;
    name?: string | null;
    reusable?: boolean | null;
    sessionDuration?: string | null;
    include?: ReadonlyArray<unknown> | null;
    exclude?: ReadonlyArray<unknown> | null;
    require?: ReadonlyArray<unknown> | null;
  }> | null;
}

test.provider(
  "inline policies: scalar shorthand, update in place, switch to reusable, no mixing",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-inline-policies.${zoneName}`;
      const makeApp = (
        policies: Cloudflare.Access.ApplicationProps["policies"],
      ) =>
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(
            AdoptPolicy.adopt(true),
          );
          return yield* Cloudflare.Access.Application("InlinePolicyApp", {
            type: "self_hosted",
            domain,
            policies,
          });
        });

      // v1 — one inline policy via scalar shorthand.
      const first = yield* stack.deploy(
        makeApp([
          {
            decision: "allow",
            name: "primary",
            include: [{ emailDomain: "example.com" }],
          },
        ]),
      );
      const live1 = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: first.applicationId,
      })) as unknown as LiveInlineApp;
      expect(live1.policies?.length).toBe(1);
      expect(live1.policies![0].reusable).toBe(false);
      // Shorthand expanded to the wire shape on the way out.
      expect(live1.policies![0].include).toEqual([
        { emailDomain: { domain: "example.com" } },
      ]);
      const inlineId = live1.policies![0].id;
      expect(inlineId).toBeDefined();

      // v2 — mutate the same inline policy: more shorthand kinds, exclude,
      // require, session duration. The policy must update IN PLACE (same
      // id) — an id-less inline item in the update PUT would mint a fresh
      // policy.
      yield* stack.deploy(
        makeApp([
          {
            decision: "allow",
            name: "primary",
            include: [{ emailDomain: "example.com" }, "everyone"],
            exclude: [{ email: "intern@example.com" }],
            require: [{ geo: "US" }],
            sessionDuration: "12h",
          },
        ]),
      );
      const live2 = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: first.applicationId,
      })) as unknown as LiveInlineApp;
      expect(live2.policies?.length).toBe(1);
      expect(live2.policies![0].id).toBe(inlineId);
      expect(live2.policies![0].include).toEqual([
        { emailDomain: { domain: "example.com" } },
        { everyone: {} },
      ]);
      expect(live2.policies![0].exclude).toEqual([
        { email: { email: "intern@example.com" } },
      ]);
      expect(live2.policies![0].require).toEqual([
        { geo: { countryCode: "US" } },
      ]);
      expect(live2.policies![0].sessionDuration).toBe("12h");

      // v3 — switch the application from inline to a reusable Policy
      // resource (passed directly).
      const reusableProgram = Effect.gen(function* () {
        yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(
          AdoptPolicy.adopt(true),
        );
        const reusable = yield* Cloudflare.Access.Policy("InlineSwapPolicy", {
          name: "Reusable for inline-swap test",
          decision: "allow",
          include: [{ emailDomain: "example.com" }],
        });
        const app = yield* Cloudflare.Access.Application("InlinePolicyApp", {
          type: "self_hosted",
          domain,
          policies: [reusable],
        });
        return { app, reusable };
      });
      const { reusable } = yield* stack.deploy(reusableProgram);
      const live3 = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: first.applicationId,
      })) as unknown as LiveInlineApp;
      expect(live3.policies?.length).toBe(1);
      expect(live3.policies![0].id).toBe(reusable.policyId);
      expect(live3.policies![0].reusable).toBe(true);

      // Mixing inline and reusable forms on one application fails fast.
      const mixed = yield* stack
        .deploy(
          makeApp([
            reusable.policyId,
            {
              decision: "allow",
              include: [{ emailDomain: "example.com" }],
            },
          ]),
        )
        .pipe(Effect.flip);
      expect(String(mixed)).toMatch(/mix/i);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:access",
      "provider:cloudflare:zone",
      "live",
    ],
    timeout: 300_000,
  },
);

test.provider(
  "adopts an existing application by id and keeps its unmanaged settings",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-adopt-by-id.${zoneName}`;
      const existing = yield* zeroTrust.createAccessApplicationForAccount({
        accountId,
        type: "self_hosted",
        name: "alchemy-test-adopt-by-id",
        domain,
        sessionDuration: "24h",
        corsHeaders: {
          allowedOrigins: ["https://app.example.com"],
          allowedMethods: ["GET", "POST"],
          allowCredentials: true,
        },
        sameSiteCookieAttribute: "lax",
        httpOnlyCookieAttribute: true,
        pathCookieAttribute: true,
        skipInterstitial: true,
      });

      const program = (sessionDuration: string) =>
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(
            AdoptPolicy.adopt(true),
          );
          return yield* Cloudflare.Access.Application("AdoptById", {
            applicationId: existing.id!,
            type: "self_hosted",
            name: "alchemy-test-adopt-by-id",
            domain,
            sessionDuration,
          });
        });

      // No `--adopt` needed: naming the id is the adoption.
      const adopted = yield* stack.deploy(program("12h"));
      expect(adopted.applicationId).toEqual(existing.id);
      expect(adopted.aud).toEqual(existing.aud);

      const live = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: existing.id!,
      })) as unknown as Record<string, any>;
      expect(live.sessionDuration).toEqual("12h");
      expect(live.corsHeaders?.allowedOrigins).toEqual([
        "https://app.example.com",
      ]);
      expect(live.corsHeaders?.allowCredentials).toBe(true);
      expect(live.sameSiteCookieAttribute).toEqual("lax");
      expect(live.httpOnlyCookieAttribute).toBe(true);
      expect(live.pathCookieAttribute).toBe(true);
      expect(live.skipInterstitial).toBe(true);

      yield* stack.destroy();

      const gone = yield* zeroTrust
        .getAccessApplicationForAccount({ accountId, appId: existing.id! })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("AccessApplicationNotFound", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:access",
      "provider:cloudflare:zone",
      "live",
    ],
  },
);

test.provider(
  "manages CORS, cookie and preflight settings",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const program = (props: Partial<Cloudflare.Access.ApplicationProps>) =>
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(
            AdoptPolicy.adopt(true),
          );
          const cors = yield* Cloudflare.Access.Application("CorsApp", {
            type: "self_hosted",
            domain: `alchemy-test-cors.${zoneName}`,
            ...props,
          });
          const preflight = yield* Cloudflare.Access.Application(
            "PreflightApp",
            {
              type: "self_hosted",
              domain: `alchemy-test-preflight.${zoneName}`,
              optionsPreflightBypass: true,
            },
          );
          return { cors, preflight };
        });
      const getLive = (appId: string) =>
        zeroTrust
          .getAccessApplicationForAccount({ accountId, appId })
          .pipe(Effect.map((app) => app as unknown as Record<string, any>));

      const { cors, preflight } = yield* stack.deploy(
        program({
          corsHeaders: {
            allowedOrigins: ["https://app.example.com"],
            allowedMethods: ["GET"],
          },
          sameSiteCookieAttribute: "strict",
          httpOnlyCookieAttribute: true,
          enableBindingCookie: true,
        }),
      );
      const live1 = yield* getLive(cors.applicationId);
      expect(live1.corsHeaders?.allowedOrigins).toEqual([
        "https://app.example.com",
      ]);
      expect(live1.corsHeaders?.allowedMethods).toEqual(["GET"]);
      expect(live1.sameSiteCookieAttribute).toEqual("strict");
      expect(live1.httpOnlyCookieAttribute).toBe(true);
      expect(live1.enableBindingCookie).toBe(true);
      expect(
        (yield* getLive(preflight.applicationId)).optionsPreflightBypass,
      ).toBe(true);

      // Settings dropped from the props are left as they are live.
      yield* stack.deploy(
        program({
          corsHeaders: { allowedMethods: ["GET", "POST"] },
          sameSiteCookieAttribute: "lax",
        }),
      );
      const live2 = yield* getLive(cors.applicationId);
      expect(live2.corsHeaders?.allowedOrigins).toEqual([
        "https://app.example.com",
      ]);
      expect(live2.corsHeaders?.allowedMethods).toEqual(["GET", "POST"]);
      expect(live2.sameSiteCookieAttribute).toEqual("lax");
      expect(live2.httpOnlyCookieAttribute).toBe(true);
      expect(live2.enableBindingCookie).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:access",
      "provider:cloudflare:zone",
      "live",
    ],
  },
);

test.provider(
  "SAML and OIDC SaaS applications",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const program = (redirectUri: string) =>
        Effect.gen(function* () {
          const saml = yield* Cloudflare.Access.Application("SamlApp", {
            type: "saas",
            name: "alchemy-test-saml",
            saasApp: {
              authType: "saml",
              spEntityId: "https://saml.example.com",
              consumerServiceUrl: "https://saml.example.com/acs",
              nameIdFormat: "email",
            },
          });
          const oidc = yield* Cloudflare.Access.Application("OidcApp", {
            type: "saas",
            name: "alchemy-test-oidc",
            saasApp: {
              authType: "oidc",
              redirectUris: [redirectUri],
              grantTypes: ["authorization_code"],
              scopes: ["openid", "email", "profile"],
            },
          });
          return { saml, oidc };
        });

      const first = yield* stack.deploy(program("https://oidc.example.com/cb"));
      const samlApp = first.saml.saasApp as Record<string, any>;
      expect(first.saml.type).toEqual("saas");
      expect(samlApp.spEntityId).toEqual("https://saml.example.com");
      expect(samlApp.ssoEndpoint).toBeDefined();
      expect(samlApp.publicKey).toBeDefined();
      const oidcApp = first.oidc.saasApp as Record<string, any>;
      expect(oidcApp.clientId).toBeDefined();
      expect(oidcApp.clientSecret).toBeUndefined();

      const second = yield* stack.deploy(
        program("https://oidc.example.com/callback"),
      );
      expect(second.oidc.applicationId).toEqual(first.oidc.applicationId);
      const live = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: second.oidc.applicationId,
      })) as unknown as { saasApp?: Record<string, any> };
      expect(live.saasApp?.redirectUris).toEqual([
        "https://oidc.example.com/callback",
      ]);
      // The client id survives the update — clients stay configured.
      expect(live.saasApp?.clientId).toEqual(oidcApp.clientId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

const APP_ID = "app-1";
const DOMAIN = "grafana.example.com";

const liveSelfHosted = (overrides: Record<string, unknown> = {}) => ({
  id: APP_ID,
  aud: "aud-1",
  type: "self_hosted",
  name: "grafana",
  domain: DOMAIN,
  destinations: [{ type: "public", uri: DOMAIN }],
  session_duration: "24h",
  allowed_idps: ["idp-1"],
  auto_redirect_to_identity: true,
  app_launcher_visible: true,
  tags: [],
  policies: [],
  cors_headers: {
    allowed_origins: ["https://app.example.com"],
    allowed_methods: ["GET", "POST"],
    allow_credentials: true,
    max_age: null,
  },
  same_site_cookie_attribute: "lax",
  http_only_cookie_attribute: true,
  enable_binding_cookie: false,
  path_cookie_attribute: true,
  options_preflight_bypass: false,
  skip_interstitial: true,
  service_auth_401_redirect: true,
  custom_deny_url: "https://deny.example.com",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const liveSaml = (overrides: Record<string, unknown> = {}) => ({
  id: APP_ID,
  aud: "aud-saml",
  type: "saas",
  name: "Looker",
  policies: [],
  saas_app: {
    auth_type: "saml",
    sp_entity_id: "https://example.looker.com",
    consumer_service_url: "https://example.looker.com/saml/acs",
    name_id_format: "email",
    sso_endpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/saml/x",
    idp_entity_id:
      "https://team.cloudflareaccess.com/cdn-cgi/access/sso/saml/x",
    public_key: "PUBLIC-KEY",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  ...overrides,
});

const liveOidc = (saasApp: Record<string, unknown> = {}) => ({
  id: APP_ID,
  aud: "aud-oidc",
  type: "saas",
  name: "Coder",
  policies: [],
  saas_app: {
    auth_type: "oidc",
    client_id: "client-1",
    public_key: "PUBLIC-KEY",
    redirect_uris: ["https://coder.example.com/old"],
    grant_types: ["authorization_code"],
    scopes: ["openid", "email"],
    ...saasApp,
  },
});

const existingOutput = (
  overrides: Partial<Cloudflare.Access.ApplicationAttributes> = {},
): Cloudflare.Access.ApplicationAttributes => ({
  applicationId: APP_ID,
  aud: "aud-1",
  domain: DOMAIN,
  destinations: undefined,
  oauthConfiguration: undefined,
  saasApp: undefined,
  type: "self_hosted",
  name: "grafana",
  accountId: ACCOUNT_ID,
  createdAt: undefined,
  updatedAt: undefined,
  ...overrides,
});

const withProvider = <A, E, R>(
  respond: (call: StubCall) => unknown,
  use: (
    provider: Provider.ProviderService<Cloudflare.Access.Application>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const stub = stubCloudflare(respond);
    const result = yield* Effect.gen(function* () {
      const provider = yield* ProviderService<Cloudflare.Access.Application>(
        "Cloudflare.Access.Application",
      );
      return yield* use(provider);
    }).pipe(
      Effect.provide(Cloudflare.Access.ApplicationProvider()),
      Effect.provide(stub.layer),
    );
    return { result, calls: stub.calls };
  });

const reconcileApp = (
  news: Cloudflare.Access.ApplicationProps,
  output: Cloudflare.Access.ApplicationAttributes | undefined,
  respond: (call: StubCall) => unknown,
) =>
  withProvider(respond, (provider) =>
    provider.reconcile({
      id: "App",
      fqn: "App",
      instanceId: "0123456789abcdef0123456789abcdef",
      news,
      olds: output === undefined ? undefined : news,
      output,
      bindings: [],
      session,
    }),
  );

/** GET answers with `live`; PUT/POST echo the request over it. */
const echo =
  (live: (overrides?: Record<string, unknown>) => object) => (call: StubCall) =>
    call.method === "GET" ? live() : live(call.body);

const putOf = (calls: StubCall[]) => calls.find((c) => c.method === "PUT");

const selfHostedNews: Cloudflare.Access.ApplicationProps = {
  type: "self_hosted",
  name: "grafana",
  domain: DOMAIN,
};

describe(
  "Application reconcile (offline)",
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:access",
      "local",
    ],
  },
  () => {
    it.effect(
      "update keeps live CORS, cookie and preflight settings it does not manage",
      () =>
        Effect.gen(function* () {
          const { calls } = yield* reconcileApp(
            { ...selfHostedNews, sessionDuration: "12h" },
            existingOutput(),
            echo(liveSelfHosted),
          );

          const put = putOf(calls);
          expect(put?.path).toEqual(
            `/accounts/${ACCOUNT_ID}/access/apps/${APP_ID}`,
          );
          expect(put?.body).toMatchObject({
            session_duration: "12h",
            allowed_idps: ["idp-1"],
            auto_redirect_to_identity: true,
            cors_headers: {
              allowed_origins: ["https://app.example.com"],
              allowed_methods: ["GET", "POST"],
              allow_credentials: true,
            },
            same_site_cookie_attribute: "lax",
            http_only_cookie_attribute: true,
            enable_binding_cookie: false,
            path_cookie_attribute: true,
            options_preflight_bypass: false,
            skip_interstitial: true,
            service_auth_401_redirect: true,
            custom_deny_url: "https://deny.example.com",
          });
          expect(put?.body.cors_headers).not.toHaveProperty("max_age");
          for (const readOnly of ["id", "aud", "created_at", "updated_at"]) {
            expect(put?.body).not.toHaveProperty(readOnly);
          }
        }),
    );

    it.effect("no update when declared settings already match", () =>
      Effect.gen(function* () {
        const { calls } = yield* reconcileApp(
          {
            ...selfHostedNews,
            sessionDuration: "24h",
            corsHeaders: {
              allowedOrigins: ["https://app.example.com"],
              allowedMethods: ["GET", "POST"],
              allowCredentials: true,
            },
            sameSiteCookieAttribute: "lax",
            httpOnlyCookieAttribute: true,
            enableBindingCookie: false,
            pathCookieAttribute: true,
            optionsPreflightBypass: false,
          },
          existingOutput(),
          echo(liveSelfHosted),
        );

        expect(calls.map((c) => c.method)).toEqual(["GET"]);
      }),
    );

    it.effect("declared settings are applied over the live ones", () =>
      Effect.gen(function* () {
        const { calls } = yield* reconcileApp(
          {
            ...selfHostedNews,
            corsHeaders: { allowedOrigins: ["https://new.example.com"] },
            sameSiteCookieAttribute: "strict",
            enableBindingCookie: true,
          },
          existingOutput(),
          echo(liveSelfHosted),
        );

        expect(putOf(calls)?.body).toMatchObject({
          cors_headers: {
            allowed_origins: ["https://new.example.com"],
            allowed_methods: ["GET", "POST"],
            allow_credentials: true,
          },
          same_site_cookie_attribute: "strict",
          enable_binding_cookie: true,
          http_only_cookie_attribute: true,
        });
      }),
    );

    it.effect("create sends the declared settings", () =>
      Effect.gen(function* () {
        const { calls } = yield* reconcileApp(
          {
            ...selfHostedNews,
            optionsPreflightBypass: true,
            sameSiteCookieAttribute: "none",
            httpOnlyCookieAttribute: false,
            pathCookieAttribute: true,
          },
          undefined,
          (call) => liveSelfHosted(call.body),
        );

        const create = calls.find((c) => c.method === "POST");
        expect(create?.body).toMatchObject({
          type: "self_hosted",
          domain: DOMAIN,
          options_preflight_bypass: true,
          same_site_cookie_attribute: "none",
          http_only_cookie_attribute: false,
          path_cookie_attribute: true,
        });
      }),
    );

    it.effect("keeps every live hostname when no domain is declared", () =>
      Effect.gen(function* () {
        const destinations = [
          { type: "public", uri: DOMAIN },
          { type: "public", uri: "grafana.example.net" },
        ];
        const { calls } = yield* reconcileApp(
          { type: "self_hosted", name: "renamed" },
          existingOutput(),
          echo((o) => liveSelfHosted({ destinations, ...o })),
        );

        expect(putOf(calls)?.body).toMatchObject({
          name: "renamed",
          domain: DOMAIN,
          destinations,
        });
      }),
    );

    it.effect("adopts an application by its declared id", () =>
      Effect.gen(function* () {
        const { result, calls } = yield* reconcileApp(
          { ...selfHostedNews, applicationId: APP_ID, sessionDuration: "12h" },
          undefined,
          echo(liveSelfHosted),
        );

        expect(result.applicationId).toEqual(APP_ID);
        expect(result.aud).toEqual("aud-1");
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
          `GET /accounts/${ACCOUNT_ID}/access/apps/${APP_ID}`,
          `PUT /accounts/${ACCOUNT_ID}/access/apps/${APP_ID}`,
        ]);
      }),
    );

    it.effect("fails instead of creating when the declared id is missing", () =>
      Effect.gen(function* () {
        const calls: StubCall[] = [];
        const error = yield* reconcileApp(
          { ...selfHostedNews, applicationId: "missing-app" },
          undefined,
          (call) => {
            calls.push(call);
            return notFound(12130, "access.api.error.unknown_application");
          },
        ).pipe(Effect.flip);

        expect(String(error)).toContain("missing-app");
        expect(calls.map((c) => c.method)).toEqual(["GET"]);
      }),
    );

    it.effect("read finds an application by its declared id as owned", () =>
      Effect.gen(function* () {
        const { result, calls } = yield* withProvider(
          echo(liveSelfHosted),
          (provider) =>
            provider.read!({
              id: "App",
              fqn: "App",
              instanceId: "0123456789abcdef0123456789abcdef",
              olds: { ...selfHostedNews, applicationId: APP_ID },
              output: undefined,
            }),
        );

        expect(result?.applicationId).toEqual(APP_ID);
        expect(result?.aud).toEqual("aud-1");
        expect(AdoptPolicy.Unowned.is(result)).toBe(false);
        expect(calls.map((c) => c.path)).toEqual([
          `/accounts/${ACCOUNT_ID}/access/apps/${APP_ID}`,
        ]);
      }),
    );

    it.effect("read of a domain match stays unowned", () =>
      Effect.gen(function* () {
        const { result } = yield* withProvider(
          (call) =>
            (call.query.get("page") ?? "1") === "1" ? [liveSelfHosted()] : [],
          (provider) =>
            provider.read!({
              id: "App",
              fqn: "App",
              instanceId: "0123456789abcdef0123456789abcdef",
              olds: selfHostedNews,
              output: undefined,
            }),
        );

        expect(result?.applicationId).toEqual(APP_ID);
        expect(AdoptPolicy.Unowned.is(result)).toBe(true);
      }),
    );

    it.effect("changing the declared id replaces the resource", () =>
      Effect.gen(function* () {
        const diff = (applicationId: string | undefined) =>
          withProvider(
            () => undefined,
            (provider) =>
              provider.diff!({
                id: "App",
                fqn: "App",
                instanceId: "0123456789abcdef0123456789abcdef",
                olds: selfHostedNews,
                news: { ...selfHostedNews, applicationId },
                oldBindings: [],
                newBindings: [],
                output: existingOutput(),
              }),
          ).pipe(Effect.map(({ result }) => result));

        expect(yield* diff("other-app")).toEqual({ action: "replace" });
        expect(yield* diff(APP_ID)).toBeUndefined();
        expect(yield* diff(undefined)).toBeUndefined();
      }),
    );

    it.effect("creates a SAML SaaS application", () =>
      Effect.gen(function* () {
        const saasApp = {
          authType: "saml",
          spEntityId: "https://example.looker.com",
          consumerServiceUrl: "https://example.looker.com/saml/acs",
          nameIdFormat: "email",
          customAttributes: [
            {
              name: "email",
              nameFormat:
                "urn:oasis:names:tc:SAML:2.0:attrname-format:basic" as const,
              source: { name: "email" },
            },
          ],
        } as const;
        const { result, calls } = yield* reconcileApp(
          { type: "saas", name: "Looker", saasApp },
          undefined,
          (call) =>
            liveSaml({
              saas_app: {
                ...liveSaml().saas_app,
                custom_attributes: call.body.saas_app.custom_attributes,
              },
            }),
        );

        const create = calls.find((c) => c.method === "POST");
        expect(create?.body).toMatchObject({
          type: "saas",
          name: "Looker",
          saas_app: {
            auth_type: "saml",
            sp_entity_id: "https://example.looker.com",
            consumer_service_url: "https://example.looker.com/saml/acs",
            name_id_format: "email",
            custom_attributes: [
              {
                name: "email",
                name_format:
                  "urn:oasis:names:tc:SAML:2.0:attrname-format:basic",
                source: { name: "email" },
              },
            ],
          },
        });
        expect(create?.body).not.toHaveProperty("domain");
        expect(calls.some((c) => c.method === "PUT")).toBe(false);
        expect(result.type).toEqual("saas");
        expect(result.domain).toEqual("");
        expect(result.saasApp).toMatchObject({
          ssoEndpoint: liveSaml().saas_app.sso_endpoint,
          idpEntityId: liveSaml().saas_app.idp_entity_id,
          publicKey: "PUBLIC-KEY",
        });
      }),
    );

    it.effect("OIDC update keeps the Cloudflare-generated client id", () =>
      Effect.gen(function* () {
        const { calls } = yield* reconcileApp(
          {
            type: "saas",
            name: "Coder",
            saasApp: {
              authType: "oidc",
              redirectUris: ["https://coder.example.com/new"],
            },
          },
          existingOutput({ type: "saas", aud: "aud-oidc", domain: "" }),
          (call) =>
            call.method === "GET" ? liveOidc() : liveOidc(call.body.saas_app),
        );

        expect(putOf(calls)?.body.saas_app).toMatchObject({
          auth_type: "oidc",
          client_id: "client-1",
          public_key: "PUBLIC-KEY",
          redirect_uris: ["https://coder.example.com/new"],
          grant_types: ["authorization_code"],
          scopes: ["openid", "email"],
        });
      }),
    );

    it.effect("never stores the OIDC client secret", () =>
      Effect.gen(function* () {
        const { result } = yield* reconcileApp(
          {
            type: "saas",
            name: "Coder",
            saasApp: {
              authType: "oidc",
              redirectUris: ["https://coder.example.com/old"],
            },
          },
          undefined,
          () => liveOidc({ client_secret: "s3cret" }),
        );

        expect(result.saasApp).toMatchObject({ clientId: "client-1" });
        expect(JSON.stringify(result)).not.toContain("s3cret");
      }),
    );

    it.effect("no update when the SaaS config already matches", () =>
      Effect.gen(function* () {
        const { calls } = yield* reconcileApp(
          {
            type: "saas",
            name: "Coder",
            saasApp: {
              authType: "oidc",
              redirectUris: ["https://coder.example.com/old"],
              scopes: ["openid", "email"],
            },
          },
          existingOutput({ type: "saas", aud: "aud-oidc", domain: "" }),
          () => liveOidc(),
        );

        expect(calls.map((c) => c.method)).toEqual(["GET"]);
      }),
    );
  },
);

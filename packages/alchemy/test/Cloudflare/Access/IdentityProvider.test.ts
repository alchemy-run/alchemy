import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge. Zone-level when `zoneId` is set,
// account-level otherwise — mirroring the provider's own scoping.
const getIdp = (
  zoneId: string | undefined,
  accountId: string,
  identityProviderId: string,
) =>
  (zoneId !== undefined
    ? zeroTrust.getIdentityProviderForZone({ zoneId, identityProviderId })
    : zeroTrust.getIdentityProviderForAccount({ accountId, identityProviderId })
  ).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A deleted IdP surfaces as `AccessIdentityProviderNotFound` (Cloudflare
// code 12135, `access.api.error.not_found`).
const expectGone = (
  zoneId: string | undefined,
  accountId: string,
  identityProviderId: string,
) =>
  getIdp(zoneId, accountId, identityProviderId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "IdpNotDeleted" } as const)),
    Effect.catchTag("AccessIdentityProviderNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "IdpNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Generic OIDC config with documentation-only placeholder endpoints —
// Cloudflare validates the shape, not the reachability.
const oidcConfig = {
  clientId: "alchemy-test-client",
  clientSecret: "alchemy-test-secret",
  authUrl: "https://idp.alchemy-test.example/authorize",
  tokenUrl: "https://idp.alchemy-test.example/token",
  certsUrl: "https://idp.alchemy-test.example/keys",
  scopes: ["openid", "email", "profile"],
};

test.provider("create, verify, and destroy an OIDC IdP", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const idp = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("BasicOidc", {
        name: "alchemy-zt-idp-basic",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    expect(idp.identityProviderId).toBeTruthy();
    expect(idp.accountId).toEqual(accountId);
    expect(idp.name).toEqual("alchemy-zt-idp-basic");
    expect(idp.type).toEqual("oidc");

    const live = yield* getIdp(undefined, accountId, idp.identityProviderId);
    expect(live.name).toEqual("alchemy-zt-idp-basic");
    expect(live.type).toEqual("oidc");
    // Cloudflare masks the client secret on read.
    expect(
      (live.config as { clientSecret?: string | null }).clientSecret ?? null,
    ).toBeNull();

    yield* stack.destroy();
    yield* expectGone(undefined, accountId, idp.identityProviderId);
  }).pipe(logLevel),
);

test.provider("update name and config in place (same id)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("UpdateOidc", {
        name: "alchemy-zt-idp-update",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    // Note: assert the config change through `claims` — distilled decodes
    // the GET response through a discriminated union whose matched variant
    // does not carry the oidc-only fields (authUrl/tokenUrl/…), so those
    // are stripped from the decoded value even though Cloudflare returns
    // them on the wire.
    const updated = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("UpdateOidc", {
        name: "alchemy-zt-idp-update-v2",
        type: "oidc",
        config: {
          ...oidcConfig,
          claims: ["email", "groups"],
        },
      }),
    );

    // Same IdP mutated in place — not a replacement.
    expect(updated.identityProviderId).toEqual(initial.identityProviderId);
    expect(updated.name).toEqual("alchemy-zt-idp-update-v2");

    const live = yield* getIdp(
      undefined,
      accountId,
      updated.identityProviderId,
    );
    expect(live.name).toEqual("alchemy-zt-idp-update-v2");
    expect(
      [...((live.config as { claims?: string[] | null }).claims ?? [])].sort(),
    ).toEqual(["email", "groups"]);

    // Redeploying identical props is a no-op (still the same IdP).
    const noop = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("UpdateOidc", {
        name: "alchemy-zt-idp-update-v2",
        type: "oidc",
        config: {
          ...oidcConfig,
          claims: ["email", "groups"],
        },
      }),
    );
    expect(noop.identityProviderId).toEqual(initial.identityProviderId);

    yield* stack.destroy();
    yield* expectGone(undefined, accountId, initial.identityProviderId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed IdP", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ListOidc", {
        name: "alchemy-zt-idp-list",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Access.IdentityProvider,
    );
    const all = yield* provider.list();

    expect(
      all.some((x) => x.identityProviderId === deployed.identityProviderId),
    ).toBe(true);

    yield* stack.destroy();
    yield* expectGone(
      undefined,
      deployed.accountId,
      deployed.identityProviderId,
    );
  }).pipe(logLevel),
);

test.provider("changing the type replaces the IdP", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const oidc = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ReplaceIdp", {
        name: "alchemy-zt-idp-replace",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    // The name is the resource's cold-read identity, so a replacement
    // (type change) pairs with a rename — keeping the old name would make
    // the engine find the doomed sibling and refuse to adopt it.
    const github = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ReplaceIdp", {
        name: "alchemy-zt-idp-replace-github",
        type: "github",
        config: {
          clientId: "alchemy-test-client",
          clientSecret: "alchemy-test-secret",
        },
      }),
    );

    // Type is immutable in our model — the engine must have replaced it.
    expect(github.identityProviderId).not.toEqual(oidc.identityProviderId);
    expect(github.type).toEqual("github");

    const live = yield* getIdp(undefined, accountId, github.identityProviderId);
    expect(live.type).toEqual("github");
    // The old IdP was deleted by the replacement.
    yield* expectGone(undefined, accountId, oidc.identityProviderId);

    yield* stack.destroy();
    yield* expectGone(undefined, accountId, github.identityProviderId);
  }).pipe(logLevel),
);

test.provider("zone-scoped IdP lifecycle (create, rename, destroy)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const idp = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ZoneOidc", {
        zoneId,
        name: "alchemy-zt-idp-zone",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    expect(idp.identityProviderId).toBeTruthy();
    expect(idp.zoneId).toEqual(zoneId);

    // Out-of-band via the zone-scoped route.
    const live = yield* getIdp(zoneId, accountId, idp.identityProviderId);
    expect(live.name).toEqual("alchemy-zt-idp-zone");
    expect(live.type).toEqual("oidc");

    // Rename converges in place — same IdP, same scope.
    const renamed = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ZoneOidc", {
        zoneId,
        name: "alchemy-zt-idp-zone-v2",
        type: "oidc",
        config: oidcConfig,
      }),
    );
    expect(renamed.identityProviderId).toEqual(idp.identityProviderId);
    expect(renamed.name).toEqual("alchemy-zt-idp-zone-v2");

    yield* stack.destroy();
    yield* expectGone(zoneId, accountId, idp.identityProviderId);
  }).pipe(logLevel),
);

test.provider("moving an IdP between scopes replaces it", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const accountScoped = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ScopeMove", {
        name: "alchemy-zt-idp-scope-move",
        type: "oidc",
        config: oidcConfig,
      }),
    );
    expect(accountScoped.zoneId).toBeUndefined();

    // Adding zoneId is a scope change — a replacement, paired with a
    // rename so the doomed sibling isn't found by the cold-read scan.
    const zoneScoped = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ScopeMove", {
        zoneId,
        name: "alchemy-zt-idp-scope-move-zone",
        type: "oidc",
        config: oidcConfig,
      }),
    );
    expect(zoneScoped.identityProviderId).not.toEqual(
      accountScoped.identityProviderId,
    );
    expect(zoneScoped.zoneId).toEqual(zoneId);

    // The old account-scoped IdP was deleted by the replacement.
    yield* expectGone(undefined, accountId, accountScoped.identityProviderId);

    yield* stack.destroy();
    yield* expectGone(zoneId, accountId, zoneScoped.identityProviderId);
  }).pipe(logLevel),
);

// Compile-time contract of the per-type configs — never executed. The
// discriminated Props union must reject a config from the wrong provider
// type and enforce each type's required fields. Type-level assertions
// (not @ts-expect-error) so the checks don't depend on where tsc anchors
// a multi-line object-literal diagnostic.
type IdpProps = Cloudflare.Access.IdentityProviderProps;
type Extends<A, B> = [A] extends [B] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Assert<T extends true> = T;

// Valid shapes are accepted.
type _OkOidc = Assert<
  Extends<{ type: "oidc"; config: typeof oidcConfig }, IdpProps>
>;
type _OkPin = Assert<Extends<{ type: "onetimepin" }, IdpProps>>;
type _OkSaml = Assert<
  Extends<
    {
      type: "saml";
      config: {
        issuerUrl: string;
        ssoTargetUrl: string;
        idpPublicCerts: string[];
      };
      samlCertificateSetId: string;
    },
    IdpProps
  >
>;
// An OAuth-only config is rejected on an oidc IdP (missing endpoints).
type _BadOidc = Assert<
  Not<
    Extends<
      { type: "oidc"; config: { clientId: string; clientSecret: string } },
      IdpProps
    >
  >
>;
// azureAD requires directoryId.
type _BadAzure = Assert<
  Not<
    Extends<
      { type: "azureAD"; config: { clientId: string; clientSecret: string } },
      IdpProps
    >
  >
>;
// saml requires issuerUrl/ssoTargetUrl/idpPublicCerts.
type _BadSaml = Assert<
  Not<Extends<{ type: "saml"; config: { issuerUrl: string } }, IdpProps>>
>;

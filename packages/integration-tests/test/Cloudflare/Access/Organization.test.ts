import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The Access organization is an account-wide singleton whose auth domain is
// allocated once and effectively immutable — the tests adopt the LIVE org
// (auth domain read from the account, or CLOUDFLARE_TEST_AUTH_DOMAIN) and
// restore every setting they toggle. The standing test account has a Zero
// Trust org, so they run by default; set CLOUDFLARE_TEST_ACCESS_ORG=0 to skip
// them on an account whose org must not be touched.
const skip = process.env.CLOUDFLARE_TEST_ACCESS_ORG === "0";

const resolveAuthDomain = (accountId: string) =>
  process.env.CLOUDFLARE_TEST_AUTH_DOMAIN
    ? Effect.succeed(process.env.CLOUDFLARE_TEST_AUTH_DOMAIN)
    : zeroTrust.listOrganizationsForAccount({ accountId }).pipe(
        Effect.map((org) => {
          expect(org.authDomain).toBeTruthy();
          return org.authDomain!;
        }),
      );
// The organization's settings as an update body, to restore it after a test.
// `serviceTokenInactivity` is left out: Cloudflare rejects the observed
// `{ enabled: false }` shape it returns.
const restorable = (accountId: string, org: zeroTrust.ListOrganizationsResponse) => ({
  accountId,
  authDomain: org.authDomain ?? undefined,
  name: org.name ?? undefined,
  allowAuthenticateViaWarp: org.allowAuthenticateViaWarp ?? undefined,
  autoRedirectToIdentity: org.autoRedirectToIdentity ?? undefined,
  isUiReadOnly: org.isUiReadOnly ?? undefined,
  sessionDuration: org.sessionDuration ?? undefined,
  warpAuthSessionDuration: org.warpAuthSessionDuration ?? undefined,
  userSeatExpirationInactiveTime: org.userSeatExpirationInactiveTime ?? undefined,
  uiReadOnlyToggleReason: org.uiReadOnlyToggleReason ?? undefined,
  denyUnmatchedRequests: org.denyUnmatchedRequests ?? undefined,
  strictServiceTokenAuth: org.strictServiceTokenAuth ?? undefined,
  mfaRequiredForAllApps: org.mfaRequiredForAllApps ?? undefined,
  loginDesign: withoutNulls(org.loginDesign),
  customPages: withoutNulls(org.customPages),
  mfaConfig: withoutNulls(org.mfaConfig),
});

const withoutNulls = <T extends object>(value: T | null | undefined) =>
  value
    ? (Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as {
        [K in keyof T]: Exclude<T[K], null>;
      })
    : undefined;

// Both cases mutate the same account-wide Access organization singleton; run
// them serially so they don't corrupt each other under the global concurrent
// test config.
describe.sequential(
  "Organization",
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
  () => {
    test.provider.skipIf(skip)("adopts the existing Access organization", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const authDomain = yield* resolveAuthDomain(accountId);

        const org = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: authDomain,
            });
          }),
        );

        expect(org.accountId).toEqual(accountId);
        expect(org.authDomain).toEqual(authDomain);

        const live = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(live.authDomain).toEqual(authDomain);

        // Singleton: delete is a no-op, so destroy must NOT remove the org.
        yield* stack.destroy();
        const stillThere = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(stillThere.authDomain).toEqual(authDomain);
      }).pipe(logLevel),
    );

    // Same gate as above: toggling allow_authenticate_via_warp mutates the
    // account's live singleton org (restored at the end).
    test.provider.skipIf(skip)("toggles allow_authenticate_via_warp and restores", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const authDomain = yield* resolveAuthDomain(accountId);

        const original = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        const originalWarp = original.allowAuthenticateViaWarp ?? false;
        const originalName = original.name ?? authDomain;

        // Step 1 — set to true.
        const enabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: originalName,
              allowAuthenticateViaWarp: true,
            });
          }),
        );
        expect(enabled.allowAuthenticateViaWarp).toEqual(true);
        const liveEnabled = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(liveEnabled.allowAuthenticateViaWarp).toEqual(true);

        // Step 2 — flip to false.
        const disabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: originalName,
              allowAuthenticateViaWarp: false,
            });
          }),
        );
        expect(disabled.allowAuthenticateViaWarp).toEqual(false);
        const liveDisabled = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(liveDisabled.allowAuthenticateViaWarp).toEqual(false);

        // Restore to original value via a final deploy so the account
        // isn't left mutated by the test.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: originalName,
              allowAuthenticateViaWarp: originalWarp,
            });
          }),
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    );

    // Cloudflare's org update is a full PUT: a field missing from the body is
    // reset. Settings the stack does not declare must survive a deploy.
    test.provider.skipIf(skip)("keeps undeclared settings when updating", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const authDomain = yield* resolveAuthDomain(accountId);
        const original = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        const name = original.name ?? authDomain;
        const warp = !(original.allowAuthenticateViaWarp ?? false);

        yield* Effect.gen(function* () {
          // Non-default neighboring settings, set out of band.
          yield* zeroTrust.updateOrganizationForAccount({
            ...restorable(accountId, original),
            sessionDuration: "13h",
            warpAuthSessionDuration: "7h",
            loginDesign: { footerText: "alchemy neighbor footer" },
            mfaConfig: { allowedAuthenticators: ["totp"], sessionDuration: "5h" },
          });

          const org = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Access.Organization("Org", {
                authDomain,
                name,
                allowAuthenticateViaWarp: warp,
              });
            }),
          );
          expect(org.allowAuthenticateViaWarp).toEqual(warp);

          const live = yield* zeroTrust.listOrganizationsForAccount({ accountId });
          expect(live.allowAuthenticateViaWarp).toEqual(warp);
          expect(live.sessionDuration).toEqual("13h");
          expect(live.warpAuthSessionDuration).toEqual("7h");
          expect(live.loginDesign?.footerText).toEqual("alchemy neighbor footer");
          expect(live.mfaConfig?.allowedAuthenticators).toEqual(["totp"]);
          expect(live.mfaConfig?.sessionDuration).toEqual("5h");

          yield* stack.destroy();
        }).pipe(
          // Put the account's organization back the way the test found it.
          Effect.ensuring(
            zeroTrust
              .updateOrganizationForAccount(restorable(accountId, original))
              .pipe(Effect.ignore),
          ),
        );
      }).pipe(logLevel),
    );

    // Canonical `list()` test (account singleton): there is no enumeration API
    // for the Access organization, so `list()` reads the single account-wide
    // org via the same path `read` uses and returns the one-element array (or
    // `[]` when the account has never enabled Zero Trust). This is read-only —
    // it does not mutate the singleton — so it runs unconditionally.
    test.provider("list returns the account Access organization", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const provider = yield* Provider.findProvider(Cloudflare.Access.Organization);
        const all = yield* provider.list();

        // Singleton: zero (Zero Trust never enabled) or exactly one.
        expect(all.length).toBeLessThanOrEqual(1);
        for (const org of all) {
          expect(org.accountId).toEqual(accountId);
          expect(typeof org.authDomain).toBe("string");
          expect(typeof org.name).toBe("string");
        }

        // `stack` is unused (no resource is deployed), but keep the destroy
        // bookend so the harness state stays clean.
        yield* stack.destroy();
      }).pipe(logLevel),
    );
  },
);

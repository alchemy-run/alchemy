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

const AUTH_DOMAIN = process.env.CLOUDFLARE_TEST_AUTH_DOMAIN;
const skip = !AUTH_DOMAIN;

test.provider.skipIf(skip)("adopts the existing Access organization", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    const org = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AccessOrganization("Org", {
          authDomain: AUTH_DOMAIN!,
          name: AUTH_DOMAIN!,
        });
      }),
    );

    expect(org.accountId).toEqual(accountId);
    expect(org.authDomain).toEqual(AUTH_DOMAIN);

    const live = yield* zeroTrust.listOrganizationsForAccount({ accountId });
    expect(live.authDomain).toEqual(AUTH_DOMAIN);

    // Singleton: delete is a no-op, so destroy must NOT remove the org.
    yield* stack.destroy();
    const stillThere = yield* zeroTrust.listOrganizationsForAccount({
      accountId,
    });
    expect(stillThere.authDomain).toEqual(AUTH_DOMAIN);
  }).pipe(logLevel),
);

test.provider.skipIf(skip)(
  "toggles allow_authenticate_via_warp and restores",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const original = yield* zeroTrust.listOrganizationsForAccount({
        accountId,
      });
      const originalWarp = original.allowAuthenticateViaWarp ?? false;
      const originalName = original.name ?? AUTH_DOMAIN!;

      // Step 1 — set to true.
      const enabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccessOrganization("Org", {
            authDomain: AUTH_DOMAIN!,
            name: originalName,
            allowAuthenticateViaWarp: true,
          });
        }),
      );
      expect(enabled.allowAuthenticateViaWarp).toEqual(true);
      const liveEnabled = yield* zeroTrust.listOrganizationsForAccount({
        accountId,
      });
      expect(liveEnabled.allowAuthenticateViaWarp).toEqual(true);

      // Step 2 — flip to false.
      const disabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccessOrganization("Org", {
            authDomain: AUTH_DOMAIN!,
            name: originalName,
            allowAuthenticateViaWarp: false,
          });
        }),
      );
      expect(disabled.allowAuthenticateViaWarp).toEqual(false);
      const liveDisabled = yield* zeroTrust.listOrganizationsForAccount({
        accountId,
      });
      expect(liveDisabled.allowAuthenticateViaWarp).toEqual(false);

      // Restore to original value via a final deploy so the account
      // isn't left mutated by the test.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccessOrganization("Org", {
            authDomain: AUTH_DOMAIN!,
            name: originalName,
            allowAuthenticateViaWarp: originalWarp,
          });
        }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
);

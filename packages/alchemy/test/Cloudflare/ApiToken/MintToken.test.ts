import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as CloudflareToken from "@/Alchemist/routes/cloudflareToken.ts";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { Credentials } from "@/Cloudflare/Credentials.ts";
import * as Test from "@/Test/Alchemy";
import { cloudflareOAuthProfile, listScriptsWithToken } from "./helpers.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

describe(
  "CloudflareToken",
  { tags: ["provider:cloudflare", "provider:cloudflare:apitoken", "live"] },
  () => {
    test.provider("mints an account-owned token with the profile's credential", () =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const owner = { credentials: yield* Credentials, accountId };

        const catalog = yield* CloudflareToken.catalog(owner);
        expect(catalog.accounts.map(({ id }) => id)).toEqual([accountId]);
        const group = catalog.permissionGroups.find(({ name }) => name === "Workers Scripts Read");
        expect(group).toBeDefined();

        const plan = yield* CloudflareToken.plan({
          ...owner,
          name: "alchemy-test-cloudflare-token",
          accountIds: [accountId],
          permissionGroupIds: [group!.id],
        });

        const token = yield* Effect.acquireRelease(
          CloudflareToken.create({ ...owner, plan }),
          (token) => accounts.deleteToken({ accountId, tokenId: token.id }).pipe(Effect.ignore),
        );
        expect(token.grantedPermissionGroups).toBe(1);
        expect(token.verificationStatus).toBe("active");
        expect(token.diagnostics).toEqual([]);
        yield* listScriptsWithToken(accountId, token.value);

        const minted = yield* accounts.getToken({ accountId, tokenId: token.id });
        expect(minted.name).toBe("alchemy-test-cloudflare-token");
      }).pipe(Effect.scoped),
    );

    test.provider.skipIf(!cloudflareOAuthProfile)(
      "grants every permission group the OAuth scopes cover",
      () =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const owner = { credentials: yield* Credentials, accountId };

          const catalog = yield* CloudflareToken.catalog(owner);
          const plan = yield* CloudflareToken.plan({
            ...owner,
            name: "alchemy-test-cloudflare-token-all",
            accountIds: [accountId],
            permissionGroupIds: "all",
          });

          const token = yield* Effect.acquireRelease(
            CloudflareToken.create({ ...owner, plan }),
            (token) => accounts.deleteToken({ accountId, tokenId: token.id }).pipe(Effect.ignore),
          );
          const minted = yield* accounts.getToken({ accountId, tokenId: token.id });
          const granted = new Set(
            (minted.policies ?? []).flatMap((policy) =>
              (policy.permissionGroups ?? []).map(({ id }) => id),
            ),
          );
          const missing = plan.policies
            .flatMap((policy) => policy.permissionGroups.map(({ id }) => id))
            .filter((id) => !granted.has(id))
            .map((id) => catalog.permissionGroups.find((group) => group.id === id)?.name ?? id)
            .sort();
          expect(missing).toEqual([]);
        }).pipe(Effect.scoped),
    );
  },
);

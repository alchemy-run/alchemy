import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import {
  buildConditionPayload,
  conditionFingerprint,
  policyFingerprint,
  resolvePolicies,
  type ApiTokenProps,
} from "./Common.ts";

export type AccountApiToken = Resource<
  "Cloudflare.AccountApiToken",
  ApiTokenProps,
  {
    tokenId: string;
    name: string;
    status: "active" | "disabled" | "expired";
    /**
     * The plaintext token value. Cloudflare returns this only once, on
     * creation, so we persist it here for downstream consumers (e.g. a
     * GitHub Actions secret).
     */
    value: Redacted.Redacted<string>;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare account-owned API token (`POST /accounts/{account_id}/tokens`).
 *
 * Account-owned tokens are managed at the account level and persist
 * independently of any single user. Use these for CI tokens, third-party
 * integrations, or anywhere the token should outlive an individual user's
 * session.
 *
 * Creating account-owned tokens requires the caller to have the
 * `API Tokens > Write` account permission.
 *
 * @section Creating a Token
 * @example A token for managing Workers and KV from CI
 * ```typescript
 * const token = yield* Cloudflare.AccountApiToken("ci-token", {
 *   name: "my-ci-token",
 *   accountId,
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: [
 *         "Workers Scripts Write",
 *         "Workers KV Storage Write",
 *       ],
 *       resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
 *     },
 *   ],
 * });
 *
 * yield* GitHub.Secret("cf-api-token", {
 *   owner: "me",
 *   repository: "my-repo",
 *   name: "CLOUDFLARE_API_TOKEN",
 *   value: token.value,
 * });
 * ```
 */
export const AccountApiToken = Resource<AccountApiToken>(
  "Cloudflare.AccountApiToken",
);

type AccountApiTokenAttributes = AccountApiToken["Attributes"];

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

export const AccountApiTokenProvider = () =>
  Provider.effect(
    AccountApiToken,
    Effect.gen(function* () {
      const { accountId: defaultAccountId } = yield* CloudflareEnvironment;
      const createToken = yield* accounts.createToken;
      const updateToken = yield* accounts.updateToken;
      const deleteToken = yield* accounts.deleteToken;
      const getToken = yield* accounts.getToken;

      const buildAttributes = (
        tokenData: {
          id?: string | null;
          name?: string | null;
          status?: "active" | "disabled" | "expired" | null;
        },
        value: Redacted.Redacted<string>,
        accountId: string,
      ): AccountApiTokenAttributes => ({
        tokenId: tokenData.id ?? "",
        name: tokenData.name ?? "",
        status: tokenData.status ?? "active",
        value,
        accountId,
      });

      return {
        stables: ["tokenId", "accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const newAccountId = news.accountId ?? defaultAccountId;
          const oldAccountId =
            output?.accountId ?? olds?.accountId ?? defaultAccountId;
          if (oldAccountId !== newAccountId) {
            return { action: "replace" } as const;
          }
          const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
          const newName = yield* resolveName(id, news.name);
          const oldPolicyFp = policyFingerprint(
            resolvePolicies(olds?.policies ?? []),
          );
          const newPolicyFp = policyFingerprint(resolvePolicies(news.policies));
          const oldCondFp = conditionFingerprint(olds?.condition);
          const newCondFp = conditionFingerprint(news.condition);
          if (
            oldName !== newName ||
            oldPolicyFp !== newPolicyFp ||
            oldCondFp !== newCondFp ||
            (olds?.expiresOn ?? undefined) !== (news.expiresOn ?? undefined) ||
            (olds?.notBefore ?? undefined) !== (news.notBefore ?? undefined)
          ) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const accountId = news.accountId ?? defaultAccountId;
          const name = yield* resolveName(id, news.name);
          const policies = resolvePolicies(news.policies);

          // Observe — fetch current state if we already know the token id.
          // Cloudflare reports a deleted token as `InvalidRoute` or
          // `TokenNotFound`; both mean "create from scratch".
          const observed = output?.tokenId
            ? yield* getToken({
                accountId: output.accountId,
                tokenId: output.tokenId,
              }).pipe(
                Effect.map((token) => token),
                Effect.catchTag("InvalidRoute", () =>
                  Effect.succeed(undefined),
                ),
                Effect.catchTag("TokenNotFound", () =>
                  Effect.succeed(undefined),
                ),
              )
            : undefined;

          // Ensure — create if missing. Cloudflare returns the plaintext
          // token value exactly once on create, so we must persist it for
          // downstream consumers. There is no idempotency token here; if
          // a stale write produced an orphan we accept the duplicate over
          // the alternative of losing the secret value.
          if (observed === undefined) {
            const result = yield* createToken({
              accountId,
              name,
              policies,
              condition: buildConditionPayload(news.condition),
              expiresOn: news.expiresOn,
              notBefore: news.notBefore,
            });
            if (!result.value) {
              return yield* Effect.die(
                `Cloudflare did not return a value for token "${name}".`,
              );
            }
            return buildAttributes(
              result,
              Redacted.make(result.value),
              accountId,
            );
          }

          // Sync — the update API replaces all mutable fields (name,
          // policies, condition, validity window). Cloudflare does not
          // return the plaintext value on update, so we preserve the one
          // captured at creation.
          const result = yield* updateToken({
            accountId,
            tokenId: output!.tokenId,
            name,
            policies,
            condition: buildConditionPayload(news.condition),
            expiresOn: news.expiresOn,
            notBefore: news.notBefore,
          });
          return buildAttributes(result, output!.value, accountId);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteToken({
            accountId: output.accountId,
            tokenId: output.tokenId,
          }).pipe(
            // Already gone — Cloudflare may report this as either an
            // `InvalidRoute` (token-id no longer routable) or a generic
            // `TokenNotFound`. Either is fine; we just want the resource gone.
            Effect.catchTag("InvalidRoute", () => Effect.void),
            Effect.catchTag("TokenNotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.tokenId) return undefined;
          return yield* getToken({
            accountId: output.accountId,
            tokenId: output.tokenId,
          }).pipe(
            Effect.map((token) =>
              buildAttributes(token, output.value, output.accountId),
            ),
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
            Effect.catchTag("TokenNotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );

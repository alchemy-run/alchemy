import {
  Credentials,
  fromApiToken,
} from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type * as Binding from "../../Binding.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { ApiTokenPermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

/**
 * Runtime accessor for a DNS binding's token, obtained by binding the
 * {@link AccountApiToken}'s `value` output in the Worker's Init phase. Reads the
 * value back from the Worker's environment at runtime. DNS record operations
 * are zone-scoped (the `zoneId` is passed per call), so the account id is not
 * needed at runtime.
 */
export interface DnsToken {
  /** The token's plaintext value (injected as a `secret_text` binding). */
  value: Effect.Effect<Redacted.Redacted<string>>;
}

/**
 * Bind an {@link AccountApiToken}'s `value` output into the Worker (as a
 * `secret_text` binding) and return the {@link DnsToken} accessor.
 */
export const bindDnsToken = (token: AccountApiToken) =>
  Effect.gen(function* () {
    const value = yield* token.value;
    return { value } satisfies DnsToken;
  });

/**
 * Resolve credentials from a bound token and provide them (plus the
 * fetch-based HTTP client) to a raw SDK operation.
 */
export const authorizeDns =
  (token: DnsToken) =>
  <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> =>
    token.value.pipe(
      Effect.flatMap((value) =>
        eff.pipe(
          Effect.provide(
            fromApiToken({ apiToken: Redacted.value(value) }).pipe(
              Layer.provideMerge(FetchHttpClient.layer),
            ),
          ),
        ),
      ),
    );

/**
 * Shared runtime body for a DNS binding: create a scoped token, attach the
 * (narrow) policy, bind the token's value into the Worker, then build the
 * client. Pass the result to `Layer.effect(<Binding>, ...)`.
 */
export const makeDnsClient = <C>(
  Policy: Binding.Policy<
    any,
    any,
    (token: AccountApiToken) => Effect.Effect<void>
  >,
  tokenId: string,
  makeClient: (token: DnsToken) => C,
) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const attach = yield* Policy;

    return Effect.fn(function* () {
      const token = yield* Token(tokenId);
      yield* attach(token);
      return makeClient(yield* bindDnsToken(token));
    });
  });

/**
 * Build the deploy-time policy layer for a DNS binding: attach an allow policy
 * with the given permission groups, scoped to all zones in the account.
 *
 * Account-owned tokens must nest zone resources under the account resource, so
 * the scope is `{ <account>: { "com.cloudflare.api.account.zone.*": "*" } }`.
 */
export const makeDnsPolicyLive = <Self, Id extends string>(
  Policy: Binding.Policy<
    Self,
    Id,
    (token: AccountApiToken) => Effect.Effect<void>
  >,
  sid: string,
  permissionGroups: ApiTokenPermissionGroupRef[],
) =>
  Policy.layer.effect(
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      return (_host, token) =>
        token.bind(sid, {
          policies: [
            {
              effect: "allow",
              permissionGroups,
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: {
                  "com.cloudflare.api.account.zone.*": "*",
                },
              },
            },
          ],
        });
    }),
  );

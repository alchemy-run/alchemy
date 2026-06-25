import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Binding from "../../Binding.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { ApiTokenPermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { Worker } from "../Workers/Worker.ts";

/**
 * Runtime accessors for a tunnel binding's token, obtained by binding the
 * {@link AccountApiToken}'s outputs in the Worker's Init phase. Each accessor
 * reads the value back from the Worker's environment at runtime.
 */
export interface TunnelToken {
  /** The token's plaintext value (injected as a `secret_text` binding). */
  value: Effect.Effect<Redacted.Redacted<string>>;
  /** The account id the token is scoped to. */
  accountId: Effect.Effect<string>;
}

/**
 * Bind an {@link AccountApiToken}'s outputs into the Worker so they can be read
 * at runtime: `token.value` is injected as a `secret_text` binding and
 * `token.accountId` as `plain_text`. Returns the {@link TunnelToken} accessors.
 */
export const bindTunnelToken = (token: AccountApiToken) =>
  Effect.gen(function* () {
    const value = yield* token.value;
    const accountId = yield* token.accountId;
    return { value, accountId } satisfies TunnelToken;
  });

/**
 * Shared runtime body for a tunnel binding: create a scoped token, attach the
 * (narrow) policy, bind the token's outputs into the Worker, then build the
 * client. Pass the result to `Layer.effect(<Binding>, ...)`.
 */
export const makeTunnelClient = <C>(
  Policy: Binding.Policy<
    any,
    any,
    (
      token: AccountApiToken,
    ) => Effect.Effect<void, never, CloudflareEnvironment>
  >,
  makeClient: (token: TunnelToken) => C,
) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const attach = yield* Policy;

    return Effect.fn(function* () {
      const ctx = yield* Worker;
      const token = yield* Token(`${ctx.LogicalId}Token`);
      yield* attach(token);
      return makeClient(yield* bindTunnelToken(token));
    });
  });

/**
 * Build the deploy-time policy layer for a tunnel binding: attach an allow
 * policy with the given permission groups to the binding's token.
 */
export const makeTunnelPolicyLive = <Self, Id extends string>(
  Policy: Binding.Policy<
    Self,
    Id,
    (
      token: AccountApiToken,
    ) => Effect.Effect<void, never, CloudflareEnvironment>
  >,
  sid: string,
  permissionGroups: ApiTokenPermissionGroupRef[],
) =>
  Policy.layer.succeed((_host, token) =>
    CloudflareEnvironment.pipe(
      Effect.flatMap((env) => env),
      Effect.flatMap(({ accountId }) =>
        token.bind(sid, {
          policies: [
            {
              effect: "allow",
              permissionGroups,
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: "*",
              },
            },
          ],
        }),
      ),
    ),
  );

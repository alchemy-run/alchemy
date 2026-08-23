import { Credentials } from "@distilled.cloud/stripe";
import { GetAccountsAccountExternalAccountsId } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import type { AccountExternalAccount } from "./AccountExternalAccount.ts";
import { STRIPE_API_KEY_ENV } from "./AuthProvider.ts";
import { RetrieveAccountExternalAccount } from "./RetrieveAccountExternalAccount.ts";
import {
  bindStripeEnv,
  idEnvKey,
  makeStripeAuth,
  stripeApiKey,
} from "./StripeHttp.ts";

const accountEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_ACCOUNT_${sanitizeKey(resource.LogicalId)}`;

const envName = (key: string) => Config.string(key).pipe(Effect.orDie);

const toIdEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) return value as Effect.Effect<string>;
  return Effect.die("Stripe binding expected a resolved id");
};

/**
 * HTTP implementation of {@link RetrieveAccountExternalAccount}. The
 * nested retrieve takes both `account` and `id`.
 *
 * @layer
 * @provides Stripe.RetrieveAccountExternalAccount
 */
export const RetrieveAccountExternalAccountHttp = Layer.effect(
  RetrieveAccountExternalAccount,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* (externalAccount: AccountExternalAccount) {
      const idKey = idEnvKey(externalAccount);
      const accountKey = accountEnvKey(externalAccount);
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return Effect.fn(
          `Stripe.RetrieveAccountExternalAccount(${externalAccount.LogicalId})`,
        )(function* (request?: { expand?: string[] }) {
          return yield* auth.authorize(
            GetAccountsAccountExternalAccountsId({
              ...(request ?? {}),
              id: yield* envName(idKey),
              account: yield* envName(accountKey),
            }),
          );
        });
      }

      const host = yield* Binding.Host;
      if (host !== undefined) {
        const token = yield* stripeApiKey(context);
        yield* bindStripeEnv(host, externalAccount as unknown as ResourceLike, {
          [STRIPE_API_KEY_ENV]: Redacted.make(token),
          [idKey]: externalAccount.id,
          [accountKey]: externalAccount.account,
        });
      }

      const id = toIdEffect(externalAccount.id);
      const account = toIdEffect(externalAccount.account);

      return Effect.fn(
        `Stripe.RetrieveAccountExternalAccount(${externalAccount.LogicalId})`,
      )(function* (request?: { expand?: string[] }) {
        return yield* auth.authorize(
          GetAccountsAccountExternalAccountsId({
            ...(request ?? {}),
            id: yield* id,
            account: yield* account,
          }),
        );
      });
    });
  }),
);

import { Credentials } from "@distilled.cloud/stripe";
import { GetAccountsAccountExternalAccountsId } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import type { AccountExternalAccount } from "./AccountExternalAccount.ts";
import { RetrieveAccountExternalAccount } from "./RetrieveAccountExternalAccount.ts";
import {
  asStringEffect,
  attachStripeToken,
  idEnvKey,
  makeStripeAuth,
} from "./StripeHttp.ts";

const accountEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_ACCOUNT_${sanitizeKey(resource.LogicalId)}`;

const envName = (key: string) => Config.string(key).pipe(Effect.orDie);

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
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* attachStripeToken(
          externalAccount as unknown as ResourceLike,
          {
            [idKey]: externalAccount.id,
            [accountKey]: externalAccount.account,
          },
          ["accounts_read"],
          "Stripe.RetrieveAccountExternalAccount",
        );
      }

      const id = globalThis.__ALCHEMY_RUNTIME__
        ? envName(idKey)
        : asStringEffect(externalAccount.id);
      const account = globalThis.__ALCHEMY_RUNTIME__
        ? envName(accountKey)
        : asStringEffect(externalAccount.account);

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

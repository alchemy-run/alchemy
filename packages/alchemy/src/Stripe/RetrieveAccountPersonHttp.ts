import { Credentials } from "@distilled.cloud/stripe";
import { GetAccountsAccountPersonsPerson } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import type { AccountPerson } from "./AccountPerson.ts";
import { RetrieveAccountPerson } from "./RetrieveAccountPerson.ts";
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
 * HTTP implementation of {@link RetrieveAccountPerson}. Retrieve takes
 * both `account` and `person`.
 *
 * @layer
 * @provides Stripe.RetrieveAccountPerson
 */
export const RetrieveAccountPersonHttp = Layer.effect(
  RetrieveAccountPerson,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* (person: AccountPerson) {
      const idKey = idEnvKey(person);
      const accountKey = accountEnvKey(person);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* attachStripeToken(
          person as unknown as ResourceLike,
          {
            [idKey]: person.id,
            [accountKey]: person.account,
          },
          ["accounts_read"],
          "Stripe.RetrieveAccountPerson",
        );
      }

      const id = globalThis.__ALCHEMY_RUNTIME__
        ? envName(idKey)
        : asStringEffect(person.id);
      const account = globalThis.__ALCHEMY_RUNTIME__
        ? envName(accountKey)
        : asStringEffect(person.account);

      return Effect.fn(`Stripe.RetrieveAccountPerson(${person.LogicalId})`)(
        function* (request?: { expand?: string[] }) {
          return yield* auth.authorize(
            GetAccountsAccountPersonsPerson({
              ...(request ?? {}),
              person: yield* id,
              account: yield* account,
            }),
          );
        },
      );
    });
  }),
);

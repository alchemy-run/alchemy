import { Credentials } from "@distilled.cloud/stripe";
import { GetAccountsAccountPersonsPerson } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import { STRIPE_API_KEY_ENV } from "./AuthProvider.ts";
import type { AccountPerson } from "./AccountPerson.ts";
import { RetrieveAccountPerson } from "./RetrieveAccountPerson.ts";
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
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return Effect.fn(`Stripe.RetrieveAccountPerson(${person.LogicalId})`)(
          function* (request?: { expand?: string[] }) {
            return yield* auth.authorize(
              GetAccountsAccountPersonsPerson({
                ...(request ?? {}),
                person: yield* envName(idKey),
                account: yield* envName(accountKey),
              }),
            );
          },
        );
      }

      const host = yield* Binding.Host;
      if (host !== undefined) {
        const token = yield* stripeApiKey(context);
        yield* bindStripeEnv(host, person as unknown as ResourceLike, {
          [STRIPE_API_KEY_ENV]: Redacted.make(token),
          [idKey]: person.id,
          [accountKey]: person.account,
        });
      }

      const id = toIdEffect(person.id);
      const account = toIdEffect(person.account);

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

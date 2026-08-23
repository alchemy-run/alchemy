import { Credentials } from "@distilled.cloud/stripe";
import { GetCustomersCustomerTaxIdsId } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import { STRIPE_API_KEY_ENV } from "./AuthProvider.ts";
import type { CustomerTaxId } from "./CustomerTaxId.ts";
import { RetrieveCustomerTaxId } from "./RetrieveCustomerTaxId.ts";
import {
  bindStripeEnv,
  idEnvKey,
  makeStripeAuth,
  stripeApiKey,
} from "./StripeHttp.ts";

const customerEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_CUSTOMER_${sanitizeKey(resource.LogicalId)}`;

const envName = (key: string) => Config.string(key).pipe(Effect.orDie);

const toIdEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) return value as Effect.Effect<string>;
  return Effect.die("Stripe binding expected a resolved id");
};

/**
 * HTTP implementation of {@link RetrieveCustomerTaxId}. The nested
 * retrieve takes both `customer` and `id`.
 *
 * @layer
 * @provides Stripe.RetrieveCustomerTaxId
 */
export const RetrieveCustomerTaxIdHttp = Layer.effect(
  RetrieveCustomerTaxId,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* (taxId: CustomerTaxId) {
      const idKey = idEnvKey(taxId);
      const customerKey = customerEnvKey(taxId);
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return Effect.fn(`Stripe.RetrieveCustomerTaxId(${taxId.LogicalId})`)(
          function* (request?: { expand?: string[] }) {
            return yield* auth.authorize(
              GetCustomersCustomerTaxIdsId({
                ...(request ?? {}),
                id: yield* envName(idKey),
                customer: yield* envName(customerKey),
              }),
            );
          },
        );
      }

      const host = yield* Binding.Host;
      if (host !== undefined) {
        const token = yield* stripeApiKey(context);
        yield* bindStripeEnv(host, taxId as unknown as ResourceLike, {
          [STRIPE_API_KEY_ENV]: Redacted.make(token),
          [idKey]: taxId.id,
          [customerKey]: taxId.customer,
        });
      }

      const id = toIdEffect(taxId.id);
      const customer = toIdEffect(taxId.customer);

      return Effect.fn(`Stripe.RetrieveCustomerTaxId(${taxId.LogicalId})`)(
        function* (request?: { expand?: string[] }) {
          return yield* auth.authorize(
            GetCustomersCustomerTaxIdsId({
              ...(request ?? {}),
              id: yield* id,
              customer: yield* customer,
            }),
          );
        },
      );
    });
  }),
);

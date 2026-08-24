import { Credentials } from "@distilled.cloud/stripe";
import { GetCustomersCustomerTaxIdsId } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import type { CustomerTaxId } from "./CustomerTaxId.ts";
import { RetrieveCustomerTaxId } from "./RetrieveCustomerTaxId.ts";
import {
  asStringEffect,
  attachStripeToken,
  idEnvKey,
  makeStripeAuth,
} from "./StripeHttp.ts";

const customerEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_CUSTOMER_${sanitizeKey(resource.LogicalId)}`;

const envName = (key: string) => Config.string(key).pipe(Effect.orDie);

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
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* attachStripeToken(
          taxId as unknown as ResourceLike,
          {
            [idKey]: taxId.id,
            [customerKey]: taxId.customer,
          },
          ["customers_read"],
          "Stripe.RetrieveCustomerTaxId",
        );
      }

      const id = globalThis.__ALCHEMY_RUNTIME__
        ? envName(idKey)
        : asStringEffect(taxId.id);
      const customer = globalThis.__ALCHEMY_RUNTIME__
        ? envName(customerKey)
        : asStringEffect(taxId.customer);

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

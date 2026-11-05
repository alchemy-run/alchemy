import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `servicequotas:ListAWSDefaultServiceQuotas` — list the
 * AWS default values for every quota of a service from inside a Function.
 *
 * ### Listing Quotas
 * **Example:** List Lambda's default quotas
 * ```typescript
 * // init
 * const listAWSDefaultServiceQuotas =
 *   yield* AWS.ServiceQuotas.ListAWSDefaultServiceQuotas();
 *
 * // runtime
 * const { Quotas } = yield* listAWSDefaultServiceQuotas({
 *   ServiceCode: "lambda",
 * });
 * ```
 *
 * @binding
 */
export interface ListAWSDefaultServiceQuotas extends Binding.Service<
  ListAWSDefaultServiceQuotas,
  "AWS.ServiceQuotas.ListAWSDefaultServiceQuotas",
  () => Effect.Effect<
    (
      request: servicequotas.ListAWSDefaultServiceQuotasRequest,
    ) => Effect.Effect<
      servicequotas.ListAWSDefaultServiceQuotasResponse,
      servicequotas.ListAWSDefaultServiceQuotasError
    >
  >
> {}
export const ListAWSDefaultServiceQuotas = Binding.Service<ListAWSDefaultServiceQuotas>(
  "AWS.ServiceQuotas.ListAWSDefaultServiceQuotas",
);

export const ListAWSDefaultServiceQuotasHttp = Layer.effect(
  ListAWSDefaultServiceQuotas,
  makeServiceQuotasHttpBinding({
    capability: "ListAWSDefaultServiceQuotas",
    iamActions: ["servicequotas:ListAWSDefaultServiceQuotas"],
    operation: servicequotas.listAWSDefaultServiceQuotas,
  }),
);

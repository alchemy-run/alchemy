import * as mq from "@distilled.cloud/aws/mq";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMqAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `ListBrokers` operation (IAM action
 * `mq:ListBrokers` on `*` — the operation is not resource-scoped).
 *
 * Lists all Amazon MQ brokers in the account/region. Provide the
 * implementation with `Effect.provide(AWS.MQ.ListBrokersHttp)`.
 * ### Observing a Broker
 * **Example:** List All Brokers
 * ```typescript
 * const listBrokers = yield* MQ.ListBrokers();
 *
 * const page = yield* listBrokers();
 * // page.BrokerSummaries → [{ BrokerName: "orders", BrokerState: "RUNNING", … }]
 * ```
 *
 * @binding
 */
export interface ListBrokers extends Binding.Service<
  ListBrokers,
  "AWS.MQ.ListBrokers",
  () => Effect.Effect<
    (request?: mq.ListBrokersRequest) => Effect.Effect<mq.ListBrokersResponse, mq.ListBrokersError>
  >
> {}
export const ListBrokers = Binding.Service<ListBrokers>("AWS.MQ.ListBrokers");

export const ListBrokersHttp = Layer.effect(
  ListBrokers,
  makeMqAccountHttpBinding({
    capability: "ListBrokers",
    operation: mq.listBrokers,
    iamActions: ["mq:ListBrokers"],
  }),
);

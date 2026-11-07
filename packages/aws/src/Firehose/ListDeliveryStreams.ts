import * as Firehose from "@distilled.cloud/aws/firehose";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFirehoseAccountHttpBinding } from "./BindingHttp.ts";

export interface ListDeliveryStreamsRequest extends Firehose.ListDeliveryStreamsInput {}

/**
 * Runtime binding for `firehose:ListDeliveryStreams`.
 *
 * An account-level binding — call it with no arguments to get a callable
 * that lists delivery stream names in the region (paged via
 * `ExclusiveStartDeliveryStreamName` + `HasMoreDeliveryStreams`). Provide
 * the `ListDeliveryStreamsHttp` layer on the Function to satisfy the
 * binding.
 * ### Stream Metadata
 * **Example:** List Delivery Streams in the Region
 * ```typescript
 * const listDeliveryStreams = yield* AWS.Firehose.ListDeliveryStreams();
 *
 * const response = yield* listDeliveryStreams();
 * const names = response.DeliveryStreamNames;
 * ```
 *
 * @binding
 */
export interface ListDeliveryStreams extends Binding.Service<
  ListDeliveryStreams,
  "AWS.Firehose.ListDeliveryStreams",
  () => Effect.Effect<
    (
      request?: ListDeliveryStreamsRequest,
    ) => Effect.Effect<Firehose.ListDeliveryStreamsOutput, Firehose.ListDeliveryStreamsError>
  >
> {}

export const ListDeliveryStreams = Binding.Service<ListDeliveryStreams>(
  "AWS.Firehose.ListDeliveryStreams",
);

/**
 * HTTP implementation of {@link ListDeliveryStreams}. At deploy time it
 * grants `firehose:ListDeliveryStreams` on `*` (the action does not support
 * resource-level permissions); at runtime it calls the Firehose API with the
 * host Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const ListDeliveryStreamsHttp = Layer.effect(
  ListDeliveryStreams,
  makeFirehoseAccountHttpBinding({
    tag: "AWS.Firehose.ListDeliveryStreams",
    operation: Firehose.listDeliveryStreams,
    actions: ["firehose:ListDeliveryStreams"],
  }),
);

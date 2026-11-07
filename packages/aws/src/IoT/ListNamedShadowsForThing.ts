import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIotThingHttpBinding } from "./BindingHttp.ts";
import type { Thing } from "./Thing.ts";

export interface ListNamedShadowsForThingRequest extends Omit<
  iotdata.ListNamedShadowsForThingRequest,
  "thingName"
> {}

/**
 * Runtime binding for the IoT data-plane `ListNamedShadowsForThing`
 * operation (IAM action `iot:ListNamedShadowsForThing`).
 *
 * Bind it to a {@link Thing} to list the thing's named shadows — the thing
 * name is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.IoT.ListNamedShadowsForThingHttp)`.
 * ### Device Shadows
 * **Example:** List Named Shadows
 * ```typescript
 * const listShadows = yield* AWS.IoT.ListNamedShadowsForThing(thing);
 *
 * const { results } = yield* listShadows();
 * ```
 *
 * @binding
 */
export interface ListNamedShadowsForThing extends Binding.Service<
  ListNamedShadowsForThing,
  "AWS.IoT.ListNamedShadowsForThing",
  (
    thing: Thing,
  ) => Effect.Effect<
    (
      request?: ListNamedShadowsForThingRequest,
    ) => Effect.Effect<
      iotdata.ListNamedShadowsForThingResponse,
      iotdata.ListNamedShadowsForThingError
    >
  >
> {}

export const ListNamedShadowsForThing = Binding.Service<ListNamedShadowsForThing>(
  "AWS.IoT.ListNamedShadowsForThing",
);

/**
 * HTTP implementation of the {@link ListNamedShadowsForThing} capability —
 * grants `iot:ListNamedShadowsForThing` on the thing ARN and calls the IoT
 * data-plane `ListNamedShadowsForThing` API.
 */
export const ListNamedShadowsForThingHttp = Layer.effect(
  ListNamedShadowsForThing,
  makeIotThingHttpBinding({
    tag: "AWS.IoT.ListNamedShadowsForThing",
    operation: iotdata.listNamedShadowsForThing,
    actions: ["iot:ListNamedShadowsForThing"],
  }),
);

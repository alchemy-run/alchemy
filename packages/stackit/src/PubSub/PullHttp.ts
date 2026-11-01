import * as Layer from "effect/Layer";
import { makeSubscriptionDataHttpBinding, pullOperation } from "./BindingHttp.ts";
import { Pull } from "./Pull.ts";

/**
 * HTTP implementation of {@link Pull}.
 *
 * @layer
 * @provides Stackit.PubSub.Pull
 */
export const PullHttp = Layer.effect(
  Pull,
  makeSubscriptionDataHttpBinding({
    tag: "Stackit.PubSub.Pull",
    operation: pullOperation,
  }),
);

import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { partitionOf } from "../Partition.ts";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";
import { CancelReplay } from "./CancelReplay.ts";

/**
 * HTTP implementation of {@link CancelReplay}. At deploy time it grants
 * `events:CancelReplay` on the account's replays; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer
 * on the Function using the binding.
 */
export const CancelReplayHttp = Layer.effect(
  CancelReplay,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.CancelReplay",
    operation: eventbridge.cancelReplay,
    actions: ["events:CancelReplay"],
    resources: ({ accountId, region }) => [
      `arn:${partitionOf(region)}:events:${region}:${accountId}:replay/*`,
    ],
  }),
);

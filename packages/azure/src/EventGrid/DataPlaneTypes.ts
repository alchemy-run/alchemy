import * as Data from "effect/Data";

/** The bound Event Grid topic reported no publish endpoint. */
export class TopicEndpointMissing extends Data.TaggedError("Azure.EventGrid.TopicEndpointMissing")<{
  readonly topicName: string;
  readonly message: string;
}> {}

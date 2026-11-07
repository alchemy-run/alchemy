import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** Eventarc resources the generated bindings bind. */
const location = "us-central1";

export const ProbeChannel = GCP.Eventarc.Channel("ProbeChannel", { location });
export const ProbeBus = GCP.Eventarc.MessageBus("ProbeBus", { location });
export const ProbePipeline = Effect.gen(function* () {
  const bus = yield* ProbeBus;
  return yield* GCP.Eventarc.Pipeline("ProbePipeline", {
    location,
    destinations: [{ messageBus: bus.name }],
  });
});
export const ProbeEnrollment = Effect.gen(function* () {
  const bus = yield* ProbeBus;
  const pipeline = yield* ProbePipeline;
  return yield* GCP.Eventarc.Enrollment("ProbeEnrollment", {
    location,
    messageBus: bus.name,
    destination: pipeline.name,
    celMatch: "true",
  });
});
export const ProbeApiSource = Effect.gen(function* () {
  const bus = yield* ProbeBus;
  return yield* GCP.Eventarc.GoogleApiSource("ProbeApiSource", {
    location,
    destination: bus.name,
  });
});
export const ProbeTrigger = Effect.gen(function* () {
  const topic = yield* GCP.PubSub.Topic("ProbeTriggerTopic", {});
  const workflow = yield* GCP.Workflows.Workflow("ProbeTriggerSink", {
    location,
    sourceContents: "main:\n  params: [event]\n  steps:\n    - done:\n        return: ok\n",
  });
  return yield* GCP.Eventarc.Trigger("ProbeTrigger", {
    location,
    eventFilters: [{ attribute: "type", value: "google.cloud.pubsub.topic.v1.messagePublished" }],
    destination: { workflow: workflow.name },
    transport: { pubsub: { topic: topic.name } },
  });
});

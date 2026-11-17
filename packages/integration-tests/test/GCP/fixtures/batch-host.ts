import * as AWS from "@alchemy.run/aws";
import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Topic the Batch job publishes to. */
export const BatchEvents = GCP.PubSub.Topic("BatchFederatedEvents", {});

/** Body of the message the job publishes. */
export const BATCH_MESSAGE = "hello from batch";

/**
 * An AWS Batch job publishing to a GCP topic. It runs as its job role, so
 * it reaches Pub/Sub by exchanging its AWS identity for a service account's
 * token, not with a service account key. Deployed from
 * {@link ../GCPBindings.test.ts}.
 */
export default class FederatedBatchJob extends AWS.Batch.JobDefinition<FederatedBatchJob>()(
  "FederatedBatchJob",
  {
    main: import.meta.filename,
    vcpus: 0.25,
    memory: 512,
    timeout: "15 minutes",
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // aggressively rate-limits anonymous pulls (429) during local builds.
    docker: { base: "oven/bun:1" },
  },
  Effect.gen(function* () {
    const publish = yield* GCP.PubSub.Publish(yield* BatchEvents);
    return {
      // A grant to a federated principal takes minutes to propagate (IAM
      // documents up to 7): retry inside the job, which fails if it never
      // lands.
      run: publish({ body: { messages: [{ data: btoa(BATCH_MESSAGE) }] } }).pipe(
        Effect.tapError((error) => Effect.logInfo(`publish not ready: ${String(error)}`)),
        Effect.retry({ schedule: Schedule.spaced("15 seconds"), times: 40 }),
        Effect.orDie,
        Effect.asVoid,
      ),
    };
  }).pipe(Effect.provide(GCP.PubSub.PublishHttp)),
) {}

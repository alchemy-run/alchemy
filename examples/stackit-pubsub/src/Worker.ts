import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { PullLogin, registryFor } from "./registry.ts";
import {
  JobsSubscription,
  resultKey,
  Results,
  type JobMessage,
  type JobResult,
} from "./resources.ts";

/**
 * The consumer. Pub/Sub only delivers when asked, so the worker pulls for as long as
 * its instance runs. A program with an event source can't scale to zero, so this
 * Application runs exactly one instance by default.
 *
 * Delivery is at least once. A handler that succeeds acknowledges its message, and
 * one that fails hands it back. Writing the result to a fixed key makes a repeated
 * job harmless, and a message that can never parse succeeds so it stops coming back.
 */
export default class Worker extends Stackit.ContainerApplications.Application<Worker>()(
  "Worker",
  Effect.gen(function* () {
    const login = yield* PullLogin;
    const registry = yield* registryFor("worker");
    return {
      main: import.meta.url,
      environmentId: login.environmentId,
      registry,
    };
  }),
  Effect.gen(function* () {
    const results = yield* Stackit.ObjectStorage.WriteBucket(yield* Results);

    yield* Stackit.PubSub.consumeSubscriptionMessages(
      JobsSubscription,
      { maxMessages: 10, concurrency: 4 },
      (message) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try(
            () => JSON.parse(message.text) as Partial<JobMessage> | null,
          ).pipe(Effect.catch(() => Effect.succeed(null)));
          if (typeof parsed?.id !== "string" || typeof parsed.payload !== "string") {
            yield* Effect.logWarning(`dropping a malformed message: ${message.ackId}`);
            return;
          }
          const job: JobMessage = { id: parsed.id, payload: parsed.payload };
          const result: JobResult = {
            id: job.id,
            status: "done",
            words: job.payload.split(/\s+/).filter(Boolean).length,
            chars: job.payload.length,
          };
          yield* results.putObject({
            Key: resultKey(job.id),
            Body: JSON.stringify(result),
            ContentType: "application/json",
          });
        }),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("consuming")) };
  }).pipe(
    Effect.provide([
      Stackit.PubSub.ServerSubscriptionEventSource,
      Stackit.ObjectStorage.WriteBucketHttp,
    ]),
  ),
) {}

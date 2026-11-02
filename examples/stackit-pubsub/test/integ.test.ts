import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as sca from "@distilled.cloud/stackit/sca";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import type { JobResult } from "../src/resources.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

interface JobStatus {
  id: string;
  status: "pending" | "done";
}

/** A request that has to answer `status`, retried while the application and its grants settle. */
const expectStatus = (request: HttpClientRequest.HttpClientRequest, status: number) =>
  HttpClient.execute(request).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      response.status === status
        ? Effect.succeed(response)
        : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

const statusOf = (url: string, id: string) =>
  HttpClient.get(`${url}/jobs/${id}`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as unknown as JobStatus),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
  );

describe("stackit-pubsub", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, environmentId, apiId, workerId, topicId } = deployed;

      for (const applicationId of [apiId, workerId]) {
        const application = yield* sca
          .getApplication({ projectId, region, environmentId, applicationId })
          .pipe(
            Effect.as("found"),
            Effect.catchTag("NotFound", () => Effect.succeed("gone")),
            Effect.provide(StackitCloud),
          );
        expect(application).toEqual("gone");
      }

      const topic = yield* pubsub.getTopic({ projectId, regionId: region, topicId }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (state) => state === "gone",
          times: 30,
        }),
        Effect.provide(StackitCloud),
      );
      expect(topic).toEqual("gone");
    }),
    { timeout: 900_000 },
  );

  test(
    "the topic has the subscription the worker pulls from",
    Effect.gen(function* () {
      const { projectId, region, topicId, subscriptionId } = yield* stack;
      const subscription = yield* pubsub
        .getSubscription({ projectId, regionId: region, topicId, subscriptionId })
        .pipe(Effect.provide(StackitCloud));
      expect(subscription.state).toEqual("active");
    }),
    { timeout: 120_000 },
  );

  test(
    "rejects a job with no string payload",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* expectStatus(
        HttpClientRequest.post(`${url}/jobs`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ payload: 42 }),
        ),
        400,
      );
    }),
    { timeout: 300_000 },
  );

  test(
    "a published job comes back as a result through the worker",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const payload = "hello from a publisher";
      const accepted = yield* expectStatus(
        HttpClientRequest.post(`${url}/jobs`).pipe(HttpClientRequest.bodyJsonUnsafe({ payload })),
        202,
      );
      const { id } = (yield* accepted.json) as unknown as JobStatus;

      const result = yield* statusOf(url!, id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (status) => status.status === "done",
          times: 60,
        }),
      );
      expect(result as unknown as JobResult).toEqual({
        id,
        status: "done",
        words: 4,
        chars: payload.length,
      });
    }),
    { timeout: 600_000 },
  );
});

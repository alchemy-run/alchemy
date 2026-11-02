import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import PubSubBindingsWorker, { BindingsSubscription, BindingsTopic } from "./fixtures/worker.ts";
import {
  observeSubscription,
  publishersOf,
  subscribersOf,
  untilActive,
  untilGone,
} from "./pubsub.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitPubSubBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* PubSubBindingsWorker;
    const topic = yield* BindingsTopic;
    const subscription = yield* BindingsSubscription;
    return {
      url: worker.url.as<string>(),
      topicId: topic.topicId,
      projectId: topic.projectId,
      regionId: topic.region,
      subscriptionId: subscription.subscriptionId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

interface Pulled {
  readonly ackId: string;
  readonly text: string;
  readonly deliveryAttempts: number;
}

const options = { timeout: 300_000 } as const;

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// Everything shares one subscription's backlog, so the bindings run one after another.
describe.sequential(
  "STACKIT Pub/Sub bindings on a Cloudflare Worker",
  { tags: [...stackitTags("pubsub", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL, the created key, its memberships and the access lists take
    // a while to propagate: retry until the route answers `ok`, then report the last
    // answer so a real failure shows its STACKIT error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** Pull until a message with this text arrives, and return it. */
    const pullUntil = (text: string) =>
      call("/pull").pipe(
        Effect.map((body) => (body.result?.messages ?? []) as ReadonlyArray<Pulled>),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (messages) => messages.some((message) => message.text === text),
          times: 30,
        }),
        Effect.map((messages) => messages.find((message) => message.text === text)),
      );

    /** Pull for a while, and report whether a message with this text came. */
    const seenWithin = (text: string, pulls: number) =>
      call("/pull").pipe(
        Effect.map((body) => (body.result?.messages ?? []) as ReadonlyArray<Pulled>),
        Effect.map((messages) => messages.some((message) => message.text === text)),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (seen) => seen,
          times: pulls,
        }),
      );

    describe("GetTopic", () => {
      test.provider(
        "reads the bound topic",
        (_stack) =>
          Effect.gen(function* () {
            const { topicId } = yield* stack;
            const body = yield* call("/get-topic");
            expectOk(body);
            expect(body.result.id).toEqual(topicId);
            expect(body.result.state).toEqual("active");
          }),
        options,
      );
    });

    describe("ListTopics", () => {
      test.provider(
        "lists the bound topic among the project's",
        (_stack) =>
          Effect.gen(function* () {
            const { topicId } = yield* stack;
            const body = yield* call("/list-topics");
            expectOk(body);
            expect(body.result.topics.map((topic: { id: string }) => topic.id)).toContain(topicId);
          }),
        options,
      );
    });

    describe("GetSubscription", () => {
      test.provider(
        "reads the bound subscription",
        (_stack) =>
          Effect.gen(function* () {
            const { subscriptionId, topicId } = yield* stack;
            const body = yield* call("/get-subscription");
            expectOk(body);
            expect(body.result.id).toEqual(subscriptionId);
            expect(body.result.topicId).toEqual(topicId);
          }),
        options,
      );
    });

    describe("ListSubscriptions", () => {
      test.provider(
        "lists the bound subscription",
        (_stack) =>
          Effect.gen(function* () {
            const { subscriptionId } = yield* stack;
            const body = yield* call("/list-subscriptions");
            expectOk(body);
            expect(body.result.subscriptions.map((item: { id: string }) => item.id)).toContain(
              subscriptionId,
            );
          }),
        options,
      );
    });

    describe("CreateSubscription", () => {
      test.provider(
        "creates a subscription at runtime",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, regionId, topicId } = yield* stack;
            const place = { projectId: projectId!, regionId: regionId! };
            const body = yield* call("/create-subscription", { name: "alchemy-test-runtime-a" });
            expectOk(body);

            // Out of band: it exists on the topic.
            const created = yield* untilActive(
              observeSubscription(place, topicId!, body.result.id),
            );
            expect(created).toMatchObject({ displayName: "alchemy-test-runtime-a" });

            yield* pubsub.deleteSubscription({
              ...place,
              topicId: topicId!,
              subscriptionId: body.result.id,
            });
            yield* untilGone(observeSubscription(place, topicId!, body.result.id));
          }),
        options,
      );
    });

    describe("DeleteSubscription", () => {
      test.provider(
        "deletes a subscription by its id",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, regionId, topicId } = yield* stack;
            const place = { projectId: projectId!, regionId: regionId! };
            const seeded = yield* pubsub.createSubscription({
              ...place,
              topicId: topicId!,
              displayName: "alchemy-test-runtime-b",
            });
            yield* untilActive(observeSubscription(place, topicId!, seeded.id));

            const body = yield* call("/delete-subscription", { id: seeded.id });
            expectOk(body);

            const gone = yield* untilGone(observeSubscription(place, topicId!, seeded.id));
            expect(gone).toEqual("gone");
          }),
        options,
      );
    });

    describe("ListTopicPublishers", () => {
      test.provider(
        "reports the list the deployment wrote",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, regionId, topicId } = yield* stack;
            const body = yield* call("/list-topic-publishers");
            expectOk(body);
            const listed = body.result.emailAddresses.map((email: string) => email.toLowerCase());
            expect(listed.length).toBeGreaterThan(0);

            const observed = yield* publishersOf(
              { projectId: projectId!, regionId: regionId! },
              topicId!,
            );
            expect([...listed].sort()).toEqual([...observed].sort());
          }),
        options,
      );
    });

    describe("ListSubscriptionSubscribers", () => {
      test.provider(
        "reports the list the deployment wrote",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, regionId, topicId, subscriptionId } = yield* stack;
            const body = yield* call("/list-subscription-subscribers");
            expectOk(body);
            const listed = body.result.emailAddresses.map((email: string) => email.toLowerCase());
            expect(listed.length).toBeGreaterThan(0);

            const observed = yield* subscribersOf(
              { projectId: projectId!, regionId: regionId! },
              topicId!,
              subscriptionId!,
            );
            expect([...listed].sort()).toEqual([...observed].sort());
          }),
        options,
      );
    });

    describe("Publish", () => {
      test.provider(
        "publishes text that a pull reads back",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/publish", { text: "publish text" });
            expectOk(body);
            const message = yield* pullUntil("publish text");
            expect(message?.text).toEqual("publish text");
            yield* call("/ack", { ids: message!.ackId });
          }),
        options,
      );

      test.provider(
        "publishes bytes that a pull reads back",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/publish-bytes", { text: "publish bytes" });
            expectOk(body);
            const message = yield* pullUntil("publish bytes");
            expect(message?.text).toEqual("publish bytes");
            yield* call("/ack", { ids: message!.ackId });
          }),
        options,
      );
    });

    describe("Pull", () => {
      test.provider(
        "returns a message with its delivery details",
        (_stack) =>
          Effect.gen(function* () {
            yield* call("/publish", { text: "pull details" });
            const message = yield* pullUntil("pull details");
            expect(message?.ackId).toEqual(expect.any(String));
            expect(message?.deliveryAttempts).toBeGreaterThanOrEqual(1);
            yield* call("/ack", { ids: message!.ackId });
          }),
        options,
      );
    });

    describe("Acknowledge", () => {
      test.provider(
        "stops a message coming back",
        (_stack) =>
          Effect.gen(function* () {
            yield* call("/publish", { text: "acknowledged" });
            const message = yield* pullUntil("acknowledged");
            const body = yield* call("/ack", { ids: message!.ackId });
            expectOk(body);
            // The subscription's deadline is 10 seconds, so this outlasts a redelivery.
            const seen = yield* seenWithin("acknowledged", 8);
            expect(seen).toEqual(false);
          }),
        options,
      );
    });

    describe("NegativeAcknowledge", () => {
      test.provider(
        "hands a message back for another delivery",
        (_stack) =>
          Effect.gen(function* () {
            yield* call("/publish", { text: "returned" });
            const first = yield* pullUntil("returned");
            const body = yield* call("/nack", { ids: first!.ackId });
            expectOk(body);
            const second = yield* pullUntil("returned");
            expect(second?.deliveryAttempts).toBeGreaterThan(first!.deliveryAttempts);
            yield* call("/ack", { ids: second!.ackId });
          }),
        options,
      );
    });

    describe("PurgeTopic", () => {
      test.provider(
        "drops messages nobody pulled",
        (_stack) =>
          Effect.gen(function* () {
            yield* call("/publish", { text: "purged" });
            const body = yield* call("/purge");
            expectOk(body);
            const seen = yield* seenWithin("purged", 5);
            expect(seen).toEqual(false);
          }),
        options,
      );
    });
  },
);

import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Project and region as the API's requests name them. */
export interface Place {
  readonly projectId: string;
  readonly regionId: string;
}

/** Out-of-band topic state: the topic, or "gone". */
export const observeTopic = (place: Place, topicId: string) =>
  pubsub
    .getTopic({ ...place, topicId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Out-of-band subscription state: the subscription, or "gone". */
export const observeSubscription = (place: Place, topicId: string, subscriptionId: string) =>
  pubsub
    .getSubscription({ ...place, topicId, subscriptionId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded wait (about 90 seconds) until an observation reports "gone". */
export const untilGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (value) => value === "gone",
      times: 30,
    }),
  );

/** Bounded wait (about 90 seconds) until an out-of-band create settled. */
export const untilActive = <A extends { readonly state: string }, E, R>(
  observe: Effect.Effect<A | "gone", E, R>,
) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (value) => value !== "gone" && value.state === "active",
      times: 30,
    }),
  );

/** Out-of-band publishers of a topic, in lowercase. */
export const publishersOf = (place: Place, topicId: string) =>
  pubsub
    .listTopicPublishers({ ...place, topicId })
    .pipe(Effect.map((response) => response.emailAddresses.map((email) => email.toLowerCase())));

/** Out-of-band subscribers of a subscription, in lowercase. */
export const subscribersOf = (place: Place, topicId: string, subscriptionId: string) =>
  pubsub
    .listSubscriptionSubscribers({ ...place, topicId, subscriptionId })
    .pipe(Effect.map((response) => response.emailAddresses.map((email) => email.toLowerCase())));

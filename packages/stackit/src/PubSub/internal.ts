/**
 * Shared lifecycle pieces of STACKIT Pub/Sub. Not exported from the namespace barrel.
 *
 * Topics and subscriptions have no failed state: `reconciling` either ends in `active`
 * or runs out the budget. The API's create, update and delete answer 202 and finish later.
 */
import * as pubsub from "@distilled.cloud/stackit/pubsub";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { ProjectScope } from "../IaaS/internal.ts";
import { makeKeyedLock } from "../internal/lock.ts";
import { waitFor } from "../internal/wait.ts";
import { diffLabels, labelRecord } from "../Labels.ts";

/** Budget for a topic or subscription to settle. STACKIT publishes no typical time. */
export const PUBSUB_TIMEOUT = "5 minutes";

/** Polling for a topic or subscription. The official client's CI polls every 5 seconds. */
export const PUBSUB_POLL = { interval: "2 seconds", maxInterval: "10 seconds" } as const;

/** Budget for a change to an access list to show up in it. */
const ACCESS_TIMEOUT = "1 minute";

/** Longest display name (spec: `maxLength: 36`). */
const DISPLAY_NAME_MAX_LENGTH = 36;

/** A scope as the API's requests name it. */
export const onScope = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/**
 * A display name for a logical id, within the spec's limits. It isn't the API's key: a
 * topic's id is a UUID the API assigns. The spec's pattern takes letters, digits, spaces
 * and `-`, and a stage can hold others, such as the `_` in `test_$USER`.
 */
export const generatedDisplayName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: DISPLAY_NAME_MAX_LENGTH }).pipe(
    Effect.map((name) => name.replace(/[^a-zA-Z0-9 -]/g, "-")),
  );

const durationSeconds = (text: string): number | undefined => {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)([hms])/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text) return undefined;
  const unit = { h: 3600, m: 60, s: 1 } as const;
  return parts.reduce(
    (total, part) => total + Number(part[1]) * unit[part[2] as keyof typeof unit],
    0,
  );
};

/**
 * Whether two durations are equal. The spec only says how a duration is sent, so `24h`
 * can come back as `24h0m0s` or `86400s`, and that must not count as drift.
 */
export const sameDuration = (a: string, b: string): boolean => {
  if (a === b) return true;
  const seconds = durationSeconds(a);
  return seconds !== undefined && seconds === durationSeconds(b);
};

/** Keys the spec reserves for the system. They are never compared, sent or removed. */
const isSystemLabel = (key: string) =>
  key.startsWith("stackit-") || /(^|\.)stackit\.cloud\//.test(key);

/**
 * The `labels` of an update, or `undefined` when the observed labels already match. The
 * spec doesn't say whether a PATCH merges or replaces the map, but it does allow a null
 * value: the desired map with a null for each removed key converges either way.
 */
export const labelsDelta = (
  observed: pubsub.Labels | undefined,
  desired: Record<string, string>,
): pubsub.Labels | undefined => {
  const visible = Object.fromEntries(
    Object.entries(labelRecord(observed)).filter(([key]) => !isSystemLabel(key)),
  );
  const { upsert, removed } = diffLabels(visible, desired);
  if (upsert.length === 0 && removed.length === 0) return undefined;
  return { ...desired, ...Object.fromEntries(removed.map((key) => [key, null])) };
};

/**
 * Retry a write the API refuses for now. It documents 409 as "modified by some other
 * client, please try again", and 422 as "cannot be executed" with no cause, which is
 * assumed to include a parent that is still `reconciling`. Bounded to about a minute.
 */
export const retryWhileBusy = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict" || error._tag === "UnprocessableEntity",
      schedule: Schedule.spaced("10 seconds"),
      times: 6,
    }),
  );

export const getTopicOrUndefined = (scope: ProjectScope, topicId: string) =>
  pubsub
    .getTopic({ ...onScope(scope), topicId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const getSubscriptionOrUndefined = (
  scope: ProjectScope,
  topicId: string,
  subscriptionId: string,
) =>
  pubsub
    .getSubscription({ ...onScope(scope), topicId, subscriptionId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every topic in a project and region. */
export const listProjectTopics = (scope: ProjectScope) =>
  pubsub.listTopics.items({ ...onScope(scope), pageSize: 100 }).pipe(
    Stream.runCollect,
    Effect.map((topics) => [...topics]),
  );

/** Every subscription on a topic. */
export const listTopicSubscriptions = (scope: ProjectScope, topicId: string) =>
  pubsub.listSubscriptions.items({ ...onScope(scope), topicId, pageSize: 100 }).pipe(
    Stream.runCollect,
    Effect.map((subscriptions) => [...subscriptions]),
  );

/** Wait until a topic that exists is `active`. It fails with `NotFound` if it doesn't. */
export const waitForTopicActive = (scope: ProjectScope, topicId: string) =>
  waitFor({
    resource: `STACKIT Pub/Sub topic ${topicId}`,
    read: pubsub.getTopic({ ...onScope(scope), topicId }),
    ready: (topic) => topic.state === "active",
    state: (topic) => topic.state,
    timeout: PUBSUB_TIMEOUT,
    ...PUBSUB_POLL,
  });

/** Wait until a subscription that exists is `active`. It fails with `NotFound` if it doesn't. */
export const waitForSubscriptionActive = (
  scope: ProjectScope,
  topicId: string,
  subscriptionId: string,
) =>
  waitFor({
    resource: `STACKIT Pub/Sub subscription ${subscriptionId}`,
    read: pubsub.getSubscription({ ...onScope(scope), topicId, subscriptionId }),
    ready: (subscription) => subscription.state === "active",
    state: (subscription) => subscription.state,
    timeout: PUBSUB_TIMEOUT,
    ...PUBSUB_POLL,
  });

/** Addresses compare without regard to case: the API may normalize what it stores. */
export const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const listsEmail = (emails: ReadonlyArray<string>, email: string) =>
  emails.some((listed) => sameEmail(listed, email));

/**
 * One lock per access list. Removing an address rewrites the whole list, so a grant
 * overlapping it in this deploy could be lost. Deploy-time only: no host runs this.
 */
const withAccessLock = makeKeyedLock();

/** The operations on one access list: a topic's publishers or a subscription's subscribers. */
export interface AccessList<LE, GE, PE, WE, R> {
  /** What the list belongs to, for locks and errors. */
  readonly resource: string;
  /** Read the list. */
  readonly list: Effect.Effect<{ readonly emailAddresses: ReadonlyArray<string> }, LE, R>;
  /** Add one address. */
  readonly grant: (emailAddress: string) => Effect.Effect<unknown, GE, R>;
  /** Replace the list. */
  readonly put: (emailAddresses: Array<string>) => Effect.Effect<unknown, PE, R>;
  /** Wait until the list's parent can take a change. */
  readonly settled: Effect.Effect<unknown, WE, R>;
}

type Tagged = { readonly _tag: string };

/** Add an address to an access list, unless it is already there, and wait until it shows. */
export const ensureListed = <LE extends Tagged, GE extends Tagged, PE, WE extends Tagged, R>(
  access: AccessList<LE, GE, PE, WE, R>,
  email: string,
) =>
  Effect.gen(function* () {
    const { emailAddresses } = yield* access.list;
    if (listsEmail(emailAddresses, email)) return;
    yield* access.settled;
    yield* retryWhileBusy(access.grant(email));
    yield* waitFor({
      resource: `${email} on ${access.resource}`,
      read: access.list,
      ready: (listed) => listsEmail(listed.emailAddresses, email),
      timeout: ACCESS_TIMEOUT,
    });
  }).pipe(withAccessLock(access.resource));

/**
 * Remove one address from an access list and wait until it is gone. The API can only
 * remove every address at once, or replace the list, so this reads the list and writes
 * it back without the address: another client's write between the two can be lost, which
 * this can't detect, and no lock spans deploys. A write that doesn't show is tried again.
 */
export const removeListed = <LE extends Tagged, GE, PE extends Tagged, WE extends Tagged, R>(
  access: AccessList<LE, GE, PE, WE, R>,
  email: string,
) =>
  Effect.gen(function* () {
    const { emailAddresses } = yield* access.list;
    if (!listsEmail(emailAddresses, email)) return;
    yield* access.settled;
    yield* retryWhileBusy(access.put(emailAddresses.filter((listed) => !sameEmail(listed, email))));
    yield* waitFor({
      resource: `${email} leaving ${access.resource}`,
      read: access.list,
      ready: (listed) => !listsEmail(listed.emailAddresses, email),
      timeout: ACCESS_TIMEOUT,
    });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "Stackit.WaitTimeout",
      times: 2,
    }),
    withAccessLock(access.resource),
  );

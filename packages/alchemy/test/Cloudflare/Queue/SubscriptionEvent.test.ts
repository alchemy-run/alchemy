import { describe, expect, test } from "alchemy-test";
import * as Schema from "effect/Schema";
import {
  hasReadySubscriptionEvent,
  matchesSubscriptionEvent,
  SubscriptionEvent,
} from "./SubscriptionEvent.ts";

const expected = {
  source: "vectorize" as const,
  type: "index.created",
  accountId: "account",
  subscriptionId: "subscription",
  identity: "vectorize-subscription-0-event",
};
const event: SubscriptionEvent = {
  type: "cf.vectorize.index.created",
  source: { type: "vectorize" },
  metadata: {
    accountId: "account",
    eventSubscriptionId: "subscription",
    eventTimestamp: "2026-09-20T00:00:00Z",
  },
  payload: { name: expected.identity },
};

describe("subscription event identity", () => {
  test("an early event from the current subscription does not establish settled routing", () => {
    expect(
      hasReadySubscriptionEvent(
        [event],
        [{ identity: expected.identity, createdAt: 49_000 }],
        {
          ...expected,
          readyAfter: 60_000,
        },
      ),
    ).toBe(false);
  });

  test("an early probe delivered later cannot substitute for a fresh probe", () => {
    expect(
      hasReadySubscriptionEvent(
        [event],
        [
          { identity: expected.identity, createdAt: 49_000 },
          { identity: "fresh-probe", createdAt: 61_000 },
        ],
        { ...expected, readyAfter: 60_000 },
      ),
    ).toBe(false);
  });

  test("a fresh matching probe establishes readiness after the propagation interval", () => {
    expect(
      hasReadySubscriptionEvent(
        [event],
        [{ identity: expected.identity, createdAt: 61_000 }],
        {
          ...expected,
          readyAfter: 60_000,
        },
      ),
    ).toBe(true);
  });

  test("matches the exact Vectorize event envelope", () => {
    const decoded = Schema.decodeUnknownSync(SubscriptionEvent)(
      JSON.stringify(event),
    );
    expect(matchesSubscriptionEvent(decoded, expected)).toBe(true);
  });

  test("an index name containing the subscription id does not prove subscription identity", () => {
    expect(
      matchesSubscriptionEvent(
        {
          ...event,
          metadata: { ...event.metadata, eventSubscriptionId: "other" },
        },
        expected,
      ),
    ).toBe(false);
  });

  test("a readiness probe cannot satisfy a distinct final index", () => {
    expect(
      matchesSubscriptionEvent(event, {
        ...expected,
        identity: "final-index",
      }),
    ).toBe(false);
  });

  test("matches the whole resource name, not a substring", () => {
    expect(
      matchesSubscriptionEvent(
        {
          ...event,
          payload: { name: `${expected.identity}-other` },
        },
        expected,
      ),
    ).toBe(false);
  });

  test("rejects another account even when its name contains the expected account", () => {
    expect(
      matchesSubscriptionEvent(
        {
          ...event,
          metadata: { ...event.metadata, accountId: "other" },
          payload: { name: expected.identity, id: expected.accountId },
        },
        expected,
      ),
    ).toBe(false);
  });

  test("requires the exact event type and product source", () => {
    expect(
      matchesSubscriptionEvent(
        { ...event, type: `${event.type}.other` },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesSubscriptionEvent({ ...event, source: { type: "r2" } }, expected),
    ).toBe(false);
  });

  test("matches an Images upload by exact payload id and subscription", () => {
    const image = {
      ...event,
      type: "cf.images.image.uploaded",
      source: { type: "images" },
      payload: { id: "subscription-final" },
    };
    const target = {
      ...expected,
      source: "images" as const,
      type: "image.uploaded",
      identity: "subscription-final",
    };
    expect(matchesSubscriptionEvent(image, target)).toBe(true);
    expect(
      matchesSubscriptionEvent(
        { ...image, payload: { id: "subscription-probe-0" } },
        target,
      ),
    ).toBe(false);
    expect(
      matchesSubscriptionEvent(
        {
          ...image,
          metadata: {
            ...image.metadata,
            eventSubscriptionId: "old-subscription",
          },
        },
        target,
      ),
    ).toBe(false);
    expect(
      matchesSubscriptionEvent(
        { ...image, payload: { name: target.identity } },
        target,
      ),
    ).toBe(false);
  });

  test("matches KV ids and R2 names in their documented payload fields", () => {
    expect(
      matchesSubscriptionEvent(
        {
          ...event,
          type: "cf.kv.namespace.created",
          source: { type: "kv" },
          payload: { id: "namespace-id", name: "namespace-name" },
        },
        {
          ...expected,
          source: "kv",
          type: "namespace.created",
          identity: "namespace-id",
        },
      ),
    ).toBe(true);
    expect(
      matchesSubscriptionEvent(
        {
          ...event,
          type: "cf.r2.bucket.created",
          source: { type: "r2" },
          payload: { name: "bucket-name" },
        },
        {
          ...expected,
          source: "r2",
          type: "bucket.created",
          identity: "bucket-name",
        },
      ),
    ).toBe(true);
  });
});

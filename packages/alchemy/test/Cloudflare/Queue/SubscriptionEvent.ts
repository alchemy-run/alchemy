import * as Schema from "effect/Schema";

export const SubscriptionEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    source: Schema.Struct({ type: Schema.String }),
    metadata: Schema.Struct({
      accountId: Schema.String,
      eventSubscriptionId: Schema.String,
      eventTimestamp: Schema.String,
    }),
    payload: Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  }),
);

export type SubscriptionEvent = typeof SubscriptionEvent.Type;

interface SubscriptionEventTarget {
  source: "kv" | "r2" | "vectorize";
  type: string;
  accountId: string;
  subscriptionId: string;
  identity: string;
}

export interface SubscriptionProbe {
  identity: string;
  createdAt: number;
}

export const hasReadySubscriptionEvent = (
  events: readonly SubscriptionEvent[],
  probes: readonly SubscriptionProbe[],
  expected: Omit<SubscriptionEventTarget, "identity"> & { readyAfter: number },
) =>
  probes.some(
    ({ identity, createdAt }) =>
      createdAt >= expected.readyAfter &&
      events.some((event) =>
        matchesSubscriptionEvent(event, { ...expected, identity }),
      ),
  );

export const matchesSubscriptionEvent = (
  event: SubscriptionEvent,
  expected: SubscriptionEventTarget,
) =>
  event.type === `cf.${expected.source}.${expected.type}` &&
  event.source.type === expected.source &&
  event.metadata.accountId === expected.accountId &&
  event.metadata.eventSubscriptionId === expected.subscriptionId &&
  event.payload[expected.source === "kv" ? "id" : "name"] === expected.identity;

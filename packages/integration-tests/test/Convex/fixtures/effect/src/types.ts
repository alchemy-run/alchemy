// Type-level checks: each line fails to compile on purpose. Never bundled.
import * as Convex from "@alchemy.run/convex/Server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ListMessages, MarkDelivered, Messages } from "./messages.ts";

// A query can't write.
export const QueryWrites = Layer.succeed(
  ListMessages,
  // @ts-expect-error insert needs Convex.Writer, which a query doesn't have
  Effect.fn(function* ({ channel }) {
    yield* Messages.insert({ channel, body: "x", sentAt: new Date() });
    return [];
  }),
);

// A query can't schedule.
export const QuerySchedules = Layer.succeed(
  ListMessages,
  // @ts-expect-error schedule needs Convex.Scheduler, which a query doesn't have
  Effect.fn(function* () {
    yield* Convex.schedule(MarkDelivered, { id: "x" as typeof Messages.Id.Type });
    return [];
  }),
);

// An index that doesn't exist.
export const MissingIndex = Messages.query((q) =>
  // @ts-expect-error by_body is not an index of messages
  q.withIndex("by_body", (r) => r.eq("body", "x")),
);

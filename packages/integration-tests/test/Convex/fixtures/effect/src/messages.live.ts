import * as Convex from "@alchemy.run/convex/Server";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  AddMessage,
  AddThenFail,
  EmptyChannel,
  GetMessage,
  ListMessages,
  MarkDelivered,
  Messages,
  Summarize,
  WhoAmI,
} from "./messages.ts";

const ListMessagesLive = Layer.succeed(
  ListMessages,
  Effect.fn(function* ({ channel }) {
    return yield* Messages.query((q) => q.withIndex("by_channel", (r) => r.eq("channel", channel)))
      .collect;
  }),
);

const GetMessageLive = Layer.succeed(
  GetMessage,
  Effect.fn(function* ({ id }) {
    return yield* Messages.get(id);
  }),
);

// The constructor runs once per isolate and reads the deployment's variables.
const AddMessageLive = Layer.effect(
  AddMessage,
  Effect.gen(function* () {
    const prefix = yield* Config.String("MESSAGE_PREFIX").pipe(Config.withDefault(""));
    return Effect.fn(function* ({ channel, body }) {
      if (channel === "") return yield* new EmptyChannel({ body });
      const id = yield* Messages.insert({
        channel,
        body: `${prefix}${body}`,
        sentAt: new Date(yield* Clock.currentTimeMillis),
      });
      yield* Convex.schedule(MarkDelivered, { id });
      return id;
    });
  }),
);

// Writes, then fails: Convex discards the write.
const AddThenFailLive = Layer.succeed(
  AddThenFail,
  Effect.fn(function* ({ channel }) {
    yield* Messages.insert({ channel, body: "never stored", sentAt: new Date(0) });
    return yield* new EmptyChannel({ body: "never stored" });
  }),
);

const MarkDeliveredLive = Layer.succeed(
  MarkDelivered,
  Effect.fn(function* ({ id }) {
    yield* Messages.patch(id, { delivered: true });
  }),
);

const SummarizeLive = Layer.succeed(
  Summarize,
  Effect.fn(function* ({ channel }) {
    const messages = yield* Convex.run(ListMessages, { channel });
    yield* Convex.run(AddMessage, { channel, body: `${messages.length} messages` }).pipe(
      Effect.catchTag("EmptyChannel", () => Effect.die("unreachable")),
    );
    return messages.length;
  }),
);

const WhoAmILive = Layer.succeed(
  WhoAmI,
  Effect.fn(function* () {
    return Option.getOrNull(Option.map(yield* Convex.identity, (user) => user.subject));
  }),
);

export const MessagesLive = Layer.mergeAll(
  ListMessagesLive,
  GetMessageLive,
  AddMessageLive,
  AddThenFailLive,
  MarkDeliveredLive,
  SummarizeLive,
  WhoAmILive,
);

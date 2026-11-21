// src/messages.live.ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AddMessage, ListMessages, Messages } from "./messages.ts";

export const ListMessagesLive = Layer.succeed(
  ListMessages,
  Effect.fn(function* () {
    return yield* Messages.query().collect;
  }),
);

export const AddMessageLive = Layer.succeed(
  AddMessage,
  Effect.fn(function* ({ body }) {
    return yield* Messages.insert({ body });
  }),
);

export const MessagesLive = Layer.mergeAll(ListMessagesLive, AddMessageLive);

import type { SessionEvent } from "@alchemy.run/ai/Session";
import * as RpcWebSocketClient from "@alchemy.run/cloudflare/Workers/RpcWebSocketClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { ChatRpcs, type ChatError } from "./Rpcs.ts";

/** The typed client of one session. */
export class Chat extends Context.Service<
  Chat,
  RpcClient.FromGroup<typeof ChatRpcs, RpcClientError>
>()("Chat") {}

/** One WebSocket to the session's object, open for as long as the Layer is. */
export const ChatLive = (url: string) =>
  RpcWebSocketClient.layer(Chat, ChatRpcs, url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

/**
 * The session's events for as long as they are read. When the connection
 * drops it asks again from the last item it delivered.
 */
export const follow = (options?: {
  readonly after?: number;
}): Stream.Stream<SessionEvent, ChatError, Chat> =>
  Stream.suspend(() => {
    let after = options?.after;
    const read = (): Stream.Stream<SessionEvent, ChatError, Chat> =>
      Stream.unwrap(Effect.map(Chat, (chat) => chat.events({ after }))).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type === "item") after = event.seq;
          }),
        ),
        Stream.catchTag("RpcClientError", () =>
          Stream.flatMap(Stream.fromEffect(Effect.sleep("1 second")), read),
        ),
      );
    return read();
  });

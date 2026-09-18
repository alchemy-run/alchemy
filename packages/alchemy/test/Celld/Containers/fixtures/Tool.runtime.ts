import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Tool } from "./Tool.ts";

export default Tool.make(
  { main: import.meta.url },
  Effect.succeed(
    Tool.of({
      ping: () => Effect.succeed("pong"),
      fetch: Effect.succeed(
        HttpServerResponse.text("celld generated container"),
      ),
    }),
  ),
);

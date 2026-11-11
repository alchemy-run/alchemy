// src/MySandbox.ts
import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * The program every sandbox runs. `isolation: "isolated"` puts each task in
 * its own Nitro Sandbox. The host runs commands and uses files through the
 * sandbox's handle, and calls `hello` as a typed method.
 */
export default class MySandbox extends AWS.ECS.Task<
  MySandbox,
  { hello: (name: string) => Effect.Effect<string> }
>()(
  "MySandbox",
  {
    main: import.meta.url,
    port: 3000,
    cpu: 1024,
    memory: 2048,
    isolation: "isolated",
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
      hello: Effect.fn(function* (name: string) {
        return `hello ${name}`;
      }),
    };
  }),
) {}

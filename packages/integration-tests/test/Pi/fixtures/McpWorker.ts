import * as Cloudflare from "@alchemy.run/cloudflare";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** An answer no model knows without calling the tool. */
const Lookup = Tool.make("lookup_code", {
  description: "Look up the secret code for a word. The code cannot be guessed.",
  parameters: Schema.Struct({ word: Schema.String }),
  success: Schema.Struct({ code: Schema.String }),
});

const Refuse = Tool.make("always_fails", {
  description: "A tool that always reports an error.",
  parameters: Tool.EmptyParams,
  success: Schema.String,
  failure: Schema.String,
});

const Codes = Toolkit.make(Lookup, Refuse);

const CodesLive = Codes.toLayer({
  lookup_code: ({ word }) => Effect.succeed({ code: `CODE-${word.toUpperCase()}-7391` }),
  always_fails: () => Effect.fail("this tool always fails"),
});

/** An MCP server on a Worker: sessionless, so each request stands alone. */
export default class PiMcpWorker extends Cloudflare.Worker<PiMcpWorker>()(
  "PiMcpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: McpServer.toolkit(Codes).pipe(
        Layer.provide(CodesLive),
        Layer.provide(
          McpServer.layerHttpRequestScoped({
            name: "codes",
            version: "1.0.0",
            path: "/mcp",
            protocols: [McpProtocol.v2026_07_28],
          }),
        ),
        HttpRouter.toHttpEffect,
        Effect.map(
          Effect.catchCause((cause) =>
            Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed(
            Effect.succeed(
              HttpServerResponse.text(`init: ${Cause.pretty(cause)}`, { status: 500 }),
            ),
          ),
        ),
      ),
    };
  }),
) {}

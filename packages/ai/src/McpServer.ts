import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { McpClient } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const McpServerTypeId = "~alchemy/AI/McpServer" as const;

/**
 * An MCP server whose tools a harness can give its conversations, named
 * once and reached through an Effect AI `McpClient` Layer. The harness asks
 * the server for its tools; which server answers, and over what transport,
 * is the Layer you provide.
 */
export interface McpServerClass<Self, Name extends string> extends Context.ServiceClass<
  Self,
  `AI.McpServer/${Name}`,
  McpServerService
> {
  readonly [McpServerTypeId]: true;
  readonly serverName: Name;
  /**
   * Reach this server with an Effect AI `McpClient` Layer. A harness builds
   * it for each connection, so it may need the runtime context (a Worker's
   * service binding); everything else it needs is taken from where this
   * Layer is provided.
   */
  layer<E, R>(
    client: Layer.Layer<McpClient.McpClient, E, R>,
  ): Layer.Layer<Self, never, Exclude<R, RuntimeContext>>;
}

/**
 * What an MCP server tag holds: its `McpClient` Layer, with the services it
 * needed where it was provided already applied.
 */
export interface McpServerService {
  readonly client: Layer.Layer<McpClient.McpClient, unknown, RuntimeContext>;
}

export type AnyMcpServer = McpServerClass<any, string>;

export const isMcpServer = (u: unknown): u is AnyMcpServer =>
  typeof u === "function" && u !== null && McpServerTypeId in u;

/**
 * Declare an MCP server. The same declaration runs on any harness.
 *
 * **Example:** A server reached over HTTP
 * ```typescript
 * export class Docs extends AI.McpServer<Docs>()("docs") {}
 *
 * export const DocsLive = Docs.layer(
 *   McpClient.layerHttp({
 *     name: "my-agent",
 *     version: "1.0.0",
 *     protocol: McpProtocol.v2025_11_25,
 *     url: "https://docs.example.com/mcp",
 *   }).pipe(Layer.provide(FetchHttpClient.layer)),
 * );
 * ```
 */
export const McpServer =
  <Self>() =>
  <const Name extends string>(name: Name): McpServerClass<Self, Name> => {
    const Tag = Context.Service<Self, McpServerService>()(`AI.McpServer/${name}`);
    return class extends Tag {
      static readonly [McpServerTypeId] = true;
      static readonly serverName = name;
      static layer<E, R>(client: Layer.Layer<McpClient.McpClient, E, R>) {
        return Layer.effect(
          this as never,
          Effect.map(Effect.context<never>(), (context) => ({
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the captured context holds everything but the runtime context
            client: Layer.provide(client, Layer.succeedContext(context)) as Layer.Layer<
              McpClient.McpClient,
              unknown,
              RuntimeContext
            >,
          })),
        );
      }
    } as unknown as McpServerClass<Self, Name>;
  };

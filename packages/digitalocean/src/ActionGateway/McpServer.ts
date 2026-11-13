import * as DO from "@distilled.cloud/digitalocean";
import type { McpServer as ApiMcpServer } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type McpServerProps = {
  /**
   * Server reference, unique per team. A change replaces the registration.
   *
   * @default a generated physical name
   */
  serverRef?: string;
  /** URL of the remote MCP server (streamable HTTP). A change replaces it. */
  endpoint: string;
  /** Description. Updates in place. */
  description?: string;
  /**
   * A bearer token the gateway sends to the server. A change replaces the
   * registration.
   */
  apiKey?: string | Redacted.Redacted<string>;
  /** Tool slugs to enable; the gateway syncs the server's tool list. Updates in place. */
  enabledTools?: string[];
};

export type McpServer = Resource<
  "DigitalOcean.ActionGateway.McpServer",
  McpServerProps,
  {
    /** Server reference. */
    serverRef: string;
    /** The registered endpoint. */
    endpoint: string;
    /** Tools discovered on the server. */
    toolCount: number | undefined;
  },
  never,
  Providers
>;

export type McpServerAttributes = McpServer["Attributes"];

/**
 * Registers one of your remote MCP servers with the Action Gateway, so its
 * tools join the catalog that toolbelts and agent sessions draw from.
 *
 * ### Registering a Server
 * **Example:** An internal MCP server behind a bearer token
 * ```typescript
 * const token = yield* Config.Redacted("INTERNAL_MCP_TOKEN");
 * yield* DigitalOcean.ActionGateway.McpServer("internal", {
 *   endpoint: "https://mcp.internal.example.com/mcp",
 *   apiKey: token,
 *   description: "Internal ticketing tools",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Action-Gateway
 *
 * @resource
 * @product Action Gateway
 * @category AI
 */
export const McpServer = Resource<McpServer>("DigitalOcean.ActionGateway.McpServer");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (server: ApiMcpServer): McpServerAttributes => ({
  serverRef: server.serverRef,
  endpoint: server.endpoint,
  toolCount: server.toolCount,
});

const observe = (serverRef: string) =>
  noneIfNotFound(DO.getMcpServer({ server_ref: serverRef }).pipe(Effect.map((r) => r.mcpServer)));

const secretText = (value: McpServerProps["apiKey"]) =>
  value === undefined ? undefined : typeof value === "string" ? value : Redacted.value(value);

export const McpServerProvider = () =>
  Provider.succeed(McpServer, {
    stables: ["serverRef"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const serverRef = output?.serverRef ?? olds.serverRef ?? (yield* physicalName(id));
      const observed = yield* observe(serverRef);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.serverRef !== olds.serverRef ||
        news.endpoint !== olds.endpoint ||
        secretText(news.apiKey) !== secretText(olds.apiKey)
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const serverRef = news.serverRef ?? output?.serverRef ?? (yield* physicalName(id));
      const observed = yield* observe(serverRef);
      let server: ApiMcpServer;
      if (Option.isNone(observed)) {
        const apiKey = secretText(news.apiKey);
        const created = yield* DO.createMcpServer({
          serverRef,
          endpoint: news.endpoint,
          transport: "streamable_http",
          credentialRefSource: apiKey === undefined ? "none" : "secret",
          api_key: apiKey,
          description: news.description,
        });
        server = created.mcpServer;
      } else if (
        news.description !== undefined &&
        observed.value.description !== news.description
      ) {
        const patched = yield* DO.patchMcpServer({
          server_ref: serverRef,
          description: news.description,
        });
        server = patched.mcpServer;
      } else {
        server = observed.value;
      }
      if (news.enabledTools !== undefined) {
        yield* DO.updateMcpServerTools({
          server_ref: serverRef,
          enabledToolSlugs: news.enabledTools,
        });
      }
      return toAttrs(server);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteMcpServer({ server_ref: output.serverRef }));
    }),
  });

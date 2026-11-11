import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

/** What happens when a tool is called. */
export type EndpointPolicyAction = "allow" | "ask" | "deny";

export type EndpointProps = {
  /**
   * Name. Renames in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * Tools the endpoint exposes: provider-qualified slugs (`exa_web_search`,
   * optionally `@v14`) or pinned toolbelts (`toolbelt:my-belt@2`). `[]`
   * exposes none. A change publishes a new version.
   *
   * @default every tool
   */
  tools?: string[];
  /** Approval rules for tool calls. A change publishes a new version. */
  policy?: {
    /** For calls no rule matches. @default "ask" */
    readonly default?: EndpointPolicyAction;
    readonly rules?: ReadonlyArray<{
      /** Tool slug or pinned toolbelt reference. */
      readonly tool: string;
      /** Argument conditions; omitted matches every call. */
      readonly match?: Record<string, string>;
      readonly action: EndpointPolicyAction;
    }>;
  };
  /** Instructions for the tools in this endpoint. A change publishes a new version. */
  instructions?: string;
  /** Output view names by tool slug. A change publishes a new version. */
  outputViews?: Record<string, string>;
  /** A VPC the endpoint's calls go through. A change publishes a new version. */
  vpcId?: string;
  /**
   * The actor whose provider connections tool calls use. Every version
   * shares it, so a change replaces the endpoint.
   */
  actorId?: string;
  /** Send this endpoint's metrics, logs and traces to Insights. Updates in place. */
  insights?: { readonly metrics?: boolean; readonly logs?: boolean; readonly traces?: boolean };
};

export type Endpoint = Resource<
  "DigitalOcean.ActionGateway.Endpoint",
  EndpointProps,
  {
    /** Endpoint UUID. */
    endpointId: string;
    /** Name. */
    name: string;
    /** MCP URL that follows the newest version. */
    mcpUrl: string;
    /** The newest version's number. */
    version: number;
    /** MCP URL pinned to the newest version. */
    versionMcpUrl: string | undefined;
    /** The actor whose connections tool calls use; empty for none. */
    actorId: string;
  },
  never,
  Providers
>;

export type EndpointAttributes = Endpoint["Attributes"];

/**
 * A named Action Gateway MCP endpoint: a fixed set of tools, approval rules
 * and instructions that an agent connects to by URL. Each change publishes a
 * new immutable version; `mcpUrl` always serves the newest.
 *
 * ### Publishing an Endpoint
 * **Example:** Web search, with fetches needing approval
 * ```typescript
 * const endpoint = yield* DigitalOcean.ActionGateway.Endpoint("Research", {
 *   tools: ["exa_web_search", "exa_web_fetch"],
 *   policy: {
 *     default: "allow",
 *     rules: [{ tool: "exa_web_fetch", action: "ask" }],
 *   },
 *   instructions: "Cite every source you use.",
 * });
 * ```
 *
 * **Example:** Trim search results with an output view
 * ```typescript
 * const titles = yield* DigitalOcean.ActionGateway.OutputView("Titles", {
 *   tool: "exa_web_search",
 *   fields: ["results.title", "results.url"],
 * });
 * const endpoint = yield* DigitalOcean.ActionGateway.Endpoint("Research", {
 *   tools: ["exa_web_search"],
 *   outputViews: { exa_web_search: titles.name },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Action-Gateway
 *
 * @resource
 * @product Action Gateway
 * @category AI
 */
export const Endpoint = Resource<Endpoint>("DigitalOcean.ActionGateway.Endpoint");

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const specOf = (props: EndpointProps): DO.EndpointVersionSpec => ({
  actor_id: props.actorId,
  tools: props.tools,
  policy:
    props.policy === undefined
      ? undefined
      : {
          defaultAction: props.policy.default,
          rules: props.policy.rules?.map((rule) => ({
            tool: rule.tool,
            match: rule.match ?? {},
            action: rule.action,
          })),
        },
  config:
    props.instructions === undefined && props.outputViews === undefined
      ? undefined
      : { customInstructions: props.instructions, outputViews: props.outputViews },
  network: props.vpcId === undefined ? undefined : { vpcUuid: props.vpcId },
});

// Versions are immutable and their stored form is canonicalized (pinned
// tool versions), so the desired spec is compared with the last deploy's.
const specKey = (props: EndpointProps) =>
  JSON.stringify({
    tools: props.tools,
    policy: props.policy,
    instructions: props.instructions,
    outputViews: props.outputViews,
    vpcId: props.vpcId,
  });

const observe = (endpointId: string) =>
  noneIfNotFound(DO.getEndpoint({ endpoint_id: endpointId }).pipe(Effect.map((r) => r.endpoint)));

const toAttrs = (endpoint: DO.Endpoint): EndpointAttributes => ({
  endpointId: endpoint.id,
  name: endpoint.name,
  mcpUrl: endpoint.mcp_url ?? "",
  version: endpoint.head_version?.version_number ?? 0,
  versionMcpUrl: endpoint.head_version?.mcp_url,
  actorId: endpoint.actor_id,
});

const insightsDiffer = (
  observed: DO.EndpointInsights | null | undefined,
  desired: EndpointProps["insights"],
) =>
  desired !== undefined &&
  (["metrics", "logs", "traces"] as const).some(
    (k) => desired[k] !== undefined && (observed?.[k] ?? false) !== desired[k],
  );

export const EndpointProvider = () =>
  Provider.succeed(Endpoint, {
    stables: ["endpointId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.endpointId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if ((news.actorId ?? "") !== (olds.actorId ?? "")) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));

      // Observe
      const observed = output === undefined ? Option.none() : yield* observe(output.endpointId);

      // Ensure: the first version is published with the endpoint.
      if (Option.isNone(observed)) {
        const created = yield* DO.createEndpoint({
          name,
          version: specOf(news),
          insights: news.insights,
        });
        return {
          ...toAttrs({ ...created.endpoint, mcp_url: created.mcp_url }),
          version: created.version.version_number,
          versionMcpUrl: created.version_mcp_url,
        };
      }

      // Sync the name and Insights consent in place.
      let endpoint = observed.value;
      if (endpoint.name !== name || insightsDiffer(endpoint.insights, news.insights)) {
        endpoint = (yield* DO.patchEndpoint({
          endpoint_id: endpoint.id,
          name: endpoint.name !== name ? name : undefined,
          insights: news.insights,
        })).endpoint;
      }

      // Sync the version: publish a new head when the spec changed or no
      // version is live.
      if (
        endpoint.head_version === undefined ||
        endpoint.head_version === null ||
        olds === undefined ||
        specKey(news) !== specKey(olds)
      ) {
        const published = yield* DO.createEndpointVersion({
          endpoint_id: endpoint.id,
          ...specOf(news),
        });
        return {
          ...toAttrs(endpoint),
          version: published.version.version_number,
          versionMcpUrl: published.version_mcp_url,
        };
      }
      return toAttrs(endpoint);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteEndpoint({ endpoint_id: output.endpointId }));
    }),
  });

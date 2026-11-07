import * as registry from "@distilled.cloud/gcp/agentregistry_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  MAX_DISPLAY_NAME_LENGTH,
  encodeOwnership,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  resourceName,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  waitForDeleteOperation,
  waitForOperation,
  waitForVisible,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "services";

/** A spec describing what the service is: its type and an optional JSON document. */
export type ServiceSpec = {
  /** Spec type: `NO_SPEC`, or a typed document such as `A2A_AGENT_CARD`. */
  type: string;
  /** The spec document, when `type` names one. */
  content?: Record<string, unknown>;
};

/** How callers reach the service. */
export type ServiceInterface = {
  /** URL of the interface. */
  url: string;
  /** Protocol binding (`HTTP_JSON`, `JSONRPC`, `GRPC`). */
  protocolBinding?: string;
};

export type ServiceProps = {
  /**
   * Service id (the `{service}` segment). If omitted, a unique id is
   * generated. Immutable — changing it replaces the service.
   */
  serviceId?: string;
  /**
   * Location. Immutable — changing it replaces the service.
   * @default the stack's GCP region
   */
  location?: string;
  /** Display name (up to 63 characters). */
  displayName?: string;
  /** Description. Alchemy records its ownership marker ahead of it. */
  description?: string;
  /**
   * Registers the service as an agent. Set exactly one of `agentSpec`,
   * `mcpServerSpec` and `endpointSpec`; the kind is fixed after create.
   */
  agentSpec?: ServiceSpec;
  /** Registers the service as an MCP server. */
  mcpServerSpec?: ServiceSpec;
  /** Registers the service as a plain endpoint. */
  endpointSpec?: ServiceSpec;
  /**
   * How callers reach the service. Each URL can belong to one service in the
   * project ("Interface URL ... is already in use by another service").
   */
  interfaces?: ServiceInterface[];
};

export type Service = Resource<
  "GCP.AgentRegistry.Service",
  ServiceProps,
  {
    /** Full name `projects/{project}/locations/{location}/services/{service}`. */
    name: string;
    /** Service id. */
    serviceId: string;
    /** Project id. */
    project: string;
    /** Location. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description with the Alchemy ownership marker stripped. */
    description: string | undefined;
    /**
     * The agent, MCP server or endpoint Agent Registry made from the service
     * (`…/agents/{agent}`, `…/mcpServers/{id}`, `…/endpoints/{id}`).
     */
    registryResource: string | undefined;
  },
  never,
  Providers
>;

/**
 * Registers an agent, MCP server or endpoint with Agent Registry. Registry
 * turns the service into the resource named by `registryResource`, which
 * bindings and semantic governance policies refer to.
 *
 * Services have no labels, so Alchemy records its ownership marker in
 * `description`. The id, location and kind are fixed; display name,
 * description, spec content and interfaces update in place.
 *
 * ### Registering an Agent
 * **Example:** An agent behind an HTTP endpoint
 * ```typescript
 * const support = yield* GCP.AgentRegistry.Service("Support", {
 *   location: "us-central1",
 *   displayName: "support agent",
 *   agentSpec: { type: "NO_SPEC" },
 *   interfaces: [{ url: "https://agents.example.com/support", protocolBinding: "HTTP_JSON" }],
 * });
 * ```
 *
 * ### Governing an Agent
 * **Example:** A semantic governance policy on the registered agent
 * ```typescript
 * yield* GCP.AIPlatform.SemanticGovernancePolicy("NoPii", {
 *   location: "global",
 *   agent: support.registryResource.as<string>(),
 *   naturalLanguageConstraint: "Never share customer PII.",
 * });
 * ```
 *
 * @resource
 * @category Agent Registry
 */
export const Service = Resource<Service>("GCP.AgentRegistry.Service");

export class ServiceNotResolved extends Data.TaggedError("GCP.AgentRegistry.ServiceNotResolved")<{
  resourceName: string;
}> {}

const getByName = (name: string) =>
  name.length === 0
    ? Effect.undefined
    : registry
        .getProjectsLocationsServices({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (service: registry.Service, project: string): Service["Attributes"] => {
  const name = service.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    serviceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: service.displayName,
    description: parseOwnership(service.description).description,
    registryResource: service.registryResource || undefined,
  };
};

const kindOf = (props: ServiceProps) =>
  props.agentSpec ? "agent" : props.mcpServerSpec ? "mcpServer" : "endpoint";

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["name", "serviceId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.serviceId ?? output?.serviceId,
        nextId: news.serviceId ?? olds?.serviceId ?? output?.serviceId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra: olds !== undefined && kindOf(olds) !== kindOf(news),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location, env.region);
      const serviceId = yield* toPhysicalId(id, olds?.serviceId, output?.serviceId);
      const existing = yield* getByName(
        output?.name ?? resourceName(env.project, location, COLLECTION, serviceId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location, env.region);
      const serviceId = yield* toPhysicalId(id, news.serviceId, output?.serviceId);
      const name = resourceName(env.project, location, COLLECTION, serviceId);
      const description = encodeOwnership(yield* createInternalLabels(id), news.description);
      const displayName = (news.displayName ?? serviceId).slice(0, MAX_DISPLAY_NAME_LENGTH);
      const body: registry.Service = {
        displayName,
        description,
        agentSpec: news.agentSpec,
        mcpServerSpec: news.mcpServerSpec,
        endpointSpec: news.endpointSpec,
        interfaces: news.interfaces,
      };

      // Observe
      let current = yield* getByName(output?.name ?? name);

      // Ensure
      if (current === undefined) {
        const created = yield* retryTransient(
          registry.createProjectsLocationsServices({
            parent: locationParent(env.project, location),
            serviceId,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (created !== undefined) yield* waitForOperation(created);
        current = yield* waitForVisible(getByName(name));
      }
      if (current === undefined) {
        return yield* new ServiceNotResolved({ resourceName: name });
      }

      // Sync the mutable fields against the live service.
      const spec = (key: "agentSpec" | "mcpServerSpec" | "endpointSpec") =>
        news[key] === undefined || sameJson(current?.[key], news[key]) ? undefined : key;
      const mask = updateMaskOf(
        sameText(current.displayName, displayName) ? undefined : "display_name",
        sameText(current.description, description) ? undefined : "description",
        spec("agentSpec") && "agent_spec",
        spec("mcpServerSpec") && "mcp_server_spec",
        spec("endpointSpec") && "endpoint_spec",
        news.interfaces === undefined || sameJson(current.interfaces ?? [], news.interfaces)
          ? undefined
          : "interfaces",
      );
      if (mask.length > 0) {
        const patched = yield* retryTransient(
          registry.patchProjectsLocationsServices({
            name: current.name ?? name,
            updateMask: mask,
            body: { ...body, name: current.name ?? name },
          }),
        );
        yield* waitForOperation(patched);
        current = yield* getByName(current.name ?? name);
      }

      // The registry resource appears shortly after create.
      current =
        (yield* waitForVisible(
          getByName(current?.name ?? name).pipe(
            Effect.map((service) => (service?.registryResource ? service : undefined)),
          ),
        )) ?? current;
      if (current === undefined) {
        return yield* new ServiceNotResolved({ resourceName: name });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* retryTransient(
        registry.deleteProjectsLocationsServices({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) yield* waitForDeleteOperation(operation);
      yield* waitUntilGone(getByName(output.name));
    }),
  });

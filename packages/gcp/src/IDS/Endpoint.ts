import * as ids from "@distilled.cloud/gcp/ids_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";

/** Endpoint ids: a lowercase letter, then up to 62 lowercase letters, digits and hyphens. */
const MAX_ENDPOINT_ID_LENGTH = 63;

export type Severity = "INFORMATIONAL" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type EndpointProps = {
  /**
   * Endpoint id. If omitted, a unique id is generated. Immutable — changing
   * it replaces the endpoint.
   */
  endpointId?: string;
  /**
   * Zone the endpoint runs in. Immutable — changing it replaces the endpoint.
   * @default `${region}-a` for the stack's GCP region
   */
  location?: string;
  /**
   * VPC network the endpoint inspects (`projects/{p}/global/networks/{n}`).
   * The network needs a Private Service Access connection to
   * `servicenetworking.googleapis.com`. Immutable — changing it replaces
   * the endpoint.
   */
  network: string;
  /**
   * Lowest threat severity the endpoint alerts on. Immutable — changing it
   * replaces the endpoint.
   */
  severity: Severity;
  /** Description. Immutable — changing it replaces the endpoint. */
  description?: string;
  /**
   * Log every connection the endpoint sees, not just threats. Immutable —
   * changing it replaces the endpoint.
   * @default false
   */
  trafficLogs?: boolean;
  /** Threat ids the endpoint ignores. Updates in place. */
  threatExceptions?: string[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Immutable — changing them replaces the endpoint.
   */
  labels?: Record<string, string>;
};

export type Endpoint = Resource<
  "GCP.IDS.Endpoint",
  EndpointProps,
  {
    /** Full name `projects/{project}/locations/{zone}/endpoints/{endpoint}`. */
    name: string;
    /** Endpoint id. */
    endpointId: string;
    /** Project id. */
    project: string;
    /** Zone. */
    location: string;
    /** The forwarding rule packet mirroring sends traffic to. */
    endpointForwardingRule: string | undefined;
    /** The endpoint's internal IP. */
    endpointIp: string | undefined;
    /** `CREATING`, `READY`, `DELETING`, … */
    state: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Cloud IDS endpoint: a managed intrusion detection service that inspects
 * traffic a packet mirroring policy sends to `endpointForwardingRule`.
 *
 * The endpoint's network needs a Private Service Access connection.
 * Threat exceptions update in place; everything else is fixed at create. An endpoint takes 15–20 minutes to provision.
 *
 * ### Inspecting a Network
 * **Example:** An endpoint on a network with Private Service Access
 * ```typescript
 * const vpc = yield* GCP.Compute.Network("Vpc", { autoCreateSubnetworks: false });
 * const range = yield* GCP.Compute.GlobalAddress("PsaRange", {
 *   addressType: "INTERNAL",
 *   purpose: "VPC_PEERING",
 *   network: vpc.selfLink,
 *   prefixLength: 24,
 * });
 * const psa = yield* GCP.ServiceNetworking.Connection("Psa", {
 *   network: vpc.networkName,
 *   service: "servicenetworking.googleapis.com",
 *   reservedPeeringRanges: [range.addressName],
 * });
 * const ids = yield* GCP.IDS.Endpoint("Ids", {
 *   location: "us-central1-a",
 *   network: psa.network,
 *   severity: "MEDIUM",
 * });
 * ```
 *
 * @resource
 * @category Cloud IDS
 */
export const Endpoint = Resource<Endpoint>("GCP.IDS.Endpoint");

export class EndpointNotResolved extends Data.TaggedError("GCP.IDS.EndpointNotResolved")<{
  resourceName: string;
}> {}

export class EndpointStillExists extends Data.TaggedError("GCP.IDS.EndpointStillExists")<{
  resourceName: string;
}> {}

const lastSegment = (value: string) => value.replace(/\/+$/, "").split("/").pop() ?? value;

const resourceName = (project: string, location: string, endpointId: string) =>
  `projects/${project}/locations/${location}/endpoints/${endpointId}`;

const toEndpointId = (id: string, explicit: string | undefined, existing: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = (yield* createPhysicalName({
      id,
      maxLength: MAX_ENDPOINT_ID_LENGTH,
      lowercase: true,
    }))
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[^a-z]+/, "");
    return (generated || "ids").slice(0, MAX_ENDPOINT_ID_LENGTH).replace(/-+$/, "");
  });

const getByName = (name: string) =>
  ids
    .getProjectsLocationsEndpoints({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (endpoint: ids.Endpoint, project: string): Endpoint["Attributes"] => {
  const name = endpoint.name ?? "";
  const parts = name.split("/");
  return {
    name,
    endpointId: lastSegment(name),
    project: parts[1] ?? project,
    location: parts[3] ?? "",
    endpointForwardingRule: endpoint.endpointForwardingRule,
    endpointIp: endpoint.endpointIp,
    state: endpoint.state,
    labels: stripInternalLabels(tagRecord(endpoint.labels)),
  };
};

const sameList = (left: readonly string[] | undefined, right: readonly string[] | undefined) =>
  JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());

const waitFor = (operation: ids.Operation) =>
  waitForOperation(operation, (name) => ids.getProjectsLocationsOperations({ name }), {
    budget: "40 minutes",
    interval: "15 seconds",
  });

const defaultZone = (region: string) => `${region}-a`;

export const EndpointProvider = () =>
  Provider.succeed(Endpoint, {
    stables: ["name", "endpointId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousZone = output?.location ?? olds?.location;
      if (
        previousZone !== undefined &&
        previousZone !== (news.location ?? defaultZone(env.region))
      ) {
        return { action: "replace" as const };
      }
      if (olds === undefined) return undefined;
      const fixedChanged =
        (news.endpointId !== undefined && news.endpointId !== olds.endpointId) ||
        news.network !== olds.network ||
        news.severity !== olds.severity ||
        (news.description ?? "") !== (olds.description ?? "") ||
        // The API updates threat exceptions only ("Invalid field mask" for anything else).
        (news.trafficLogs ?? false) !== (olds.trafficLogs ?? false) ||
        JSON.stringify(news.labels ?? {}) !== JSON.stringify(olds.labels ?? {});
      return fixedChanged ? { action: "replace" as const } : undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = output?.location ?? olds?.location ?? defaultZone(env.region);
      const endpointId = yield* toEndpointId(id, olds?.endpointId, output?.endpointId);
      const existing = yield* getByName(
        output?.name ?? resourceName(env.project, location, endpointId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* ids.listProjectsLocationsEndpoints
          .pages({ parent: `projects/${env.project}/locations/-` })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.endpoints ?? [])),
            Stream.filter((endpoint) =>
              Object.keys(endpoint.labels ?? {}).some((key) => key.startsWith("alchemy-")),
            ),
            Stream.map((endpoint) => toAttrs(endpoint, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? defaultZone(env.region);
      const endpointId = yield* toEndpointId(id, news.endpointId, output?.endpointId);
      const name = resourceName(env.project, location, endpointId);
      const desiredLabels = { ...toLabels(news.labels), ...(yield* createInternalLabels(id)) };

      // Observe
      let current = yield* getByName(output?.name ?? name);

      // Ensure
      if (current === undefined) {
        const operation = yield* ids
          .createProjectsLocationsEndpoints({
            parent: `projects/${env.project}/locations/${location}`,
            endpointId,
            body: {
              network: news.network,
              severity: news.severity,
              description: news.description,
              trafficLogs: news.trafficLogs,
              threatExceptions: news.threatExceptions,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (operation !== undefined) yield* waitFor(operation);
        current = yield* getByName(name);
      }
      if (current === undefined) {
        return yield* new EndpointNotResolved({ resourceName: name });
      }

      // Sync threat exceptions, the one field Cloud IDS updates in place.
      if (!sameList(current.threatExceptions, news.threatExceptions)) {
        const operation = yield* ids.patchProjectsLocationsEndpoints({
          name: current.name ?? name,
          updateMask: "threatExceptions",
          body: { threatExceptions: news.threatExceptions ?? [] },
        });
        yield* waitFor(operation);
        current = (yield* getByName(current.name ?? name)) ?? current;
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* ids
        .deleteProjectsLocationsEndpoints({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) {
        yield* waitFor(operation).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* getByName(output.name).pipe(
        Effect.filterOrFail(
          (endpoint) => endpoint === undefined,
          () => new EndpointStillExists({ resourceName: output.name }),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.IDS.EndpointStillExists",
          times: 30,
          schedule: Schedule.spaced("10 seconds"),
        }),
      );
    }),
  });

import * as mission from "@distilled.cloud/azure/mission";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  changedProperties,
  createMissionName,
  FAST,
  getVirtualEnclave,
  NAMESPACE,
  sameName,
} from "./Common.ts";

/** One ingress rule into the enclave. */
export interface EnclaveEndpointRule {
  /** Rule name. */
  endpointRuleName?: string;
  /** Destination IP address or CIDR inside the enclave. */
  destination?: string;
  /** Protocols, e.g. `["TCP"]`. */
  protocols?: ("ANY" | "TCP" | "UDP" | "ICMP" | "ESP" | "AH")[];
  /** Ports, e.g. `"443"` or `"8000-8080"`. */
  ports?: string;
}

export interface EnclaveEndpointProps {
  /** Resource group of the enclave. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** Name of the parent virtual enclave. Changing it replaces the endpoint. */
  virtualEnclave: string;
  /**
   * Endpoint name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * Azure location of the endpoint. Changing it replaces the endpoint.
   * @default the enclave's location
   */
  location?: string;
  /** Ingress rules programmed into the community firewall. */
  ruleCollection: EnclaveEndpointRule[];
  /** Whether rule updates apply `Automatic`ally or need `Manual` approval. */
  updateMode?: "Automatic" | "Manual";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface EnclaveEndpoint extends Resource<
  "Azure.VirtualEnclaves.EnclaveEndpoint",
  EnclaveEndpointProps,
  {
    /** Name of the endpoint. */
    enclaveEndpointName: string;
    /** ARM resource ID of the endpoint; pass it as a connection's destination. */
    enclaveEndpointId: string;
    /** Name of the parent virtual enclave. */
    virtualEnclave: string;
    /** Resource group of the enclave. */
    resourceGroup: string;
    /** Location of the endpoint. */
    location: string;
    /** ARM IDs of the resources the endpoint manages. */
    resourceCollection: string[];
    /** Last provisioning state. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An enclave endpoint — firewall ingress rules into an Azure
 * {@link VirtualEnclave}. Other enclaves reach it through an
 * {@link EnclaveConnection}.
 *
 * @see https://learn.microsoft.com/azure/virtual-enclaves/overview
 *
 * ### Creating an Enclave Endpoint
 * **Example:** Expose HTTPS on an enclave subnet
 * ```typescript
 * const endpoint = yield* Azure.VirtualEnclaves.EnclaveEndpoint("ingress", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualEnclave: enclave.virtualEnclaveName,
 *   ruleCollection: [
 *     {
 *       endpointRuleName: "https",
 *       destination: "10.1.0.0/26",
 *       protocols: ["TCP"],
 *       ports: "443",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const EnclaveEndpoint = Resource<EnclaveEndpoint>(
  "Azure.VirtualEnclaves.EnclaveEndpoint",
);

type Observed =
  | mission.GetEnclaveEndpointResponse
  | mission.EnclaveEndpointResource;

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  virtualEnclaveName: string,
  enclaveEndpointName: string,
) =>
  orUndefinedIfNotFound(
    mission.GetEnclaveEndpoint({
      subscriptionId,
      resourceGroupName,
      virtualEnclaveName,
      enclaveEndpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  virtualEnclave: string,
  name: string,
  observed: Observed,
): EnclaveEndpoint["Attributes"] => ({
  enclaveEndpointName: name,
  enclaveEndpointId: observed.id ?? "",
  virtualEnclave,
  resourceGroup,
  location: observed.location,
  resourceCollection: observed.properties?.resourceCollection ?? [],
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const EnclaveEndpointProvider = () =>
  Provider.succeed(EnclaveEndpoint, {
    stables: [
      "enclaveEndpointName",
      "enclaveEndpointId",
      "virtualEnclave",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const enclaves = yield* mission
        .ListVirtualEnclaveBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVirtualEnclaveBySubscription", page),
          ),
        );
      const results: EnclaveEndpoint["Attributes"][] = [];
      for (const enclave of enclaves.value) {
        const group = resourceGroupOf(enclave.id);
        if (group === undefined || enclave.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          mission.ListEnclaveEndpointByEnclaveResource({
            subscriptionId,
            resourceGroupName: group,
            virtualEnclaveName: enclave.name,
          }),
        );
        if (page === undefined) continue;
        yield* requireSinglePage("ListEnclaveEndpointByEnclaveResource", page);
        for (const endpoint of page.value) {
          if (hasAnyAlchemyTag(endpoint.tags) && endpoint.name !== undefined) {
            results.push(toAttrs(group, enclave.name, endpoint.name, endpoint));
          }
        }
      }
      return results;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.virtualEnclave, output.virtualEnclave) ||
        (news.name !== undefined &&
          !sameName(news.name, output.enclaveEndpointName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const virtualEnclave = output?.virtualEnclave ?? olds?.virtualEnclave;
      if (resourceGroup === undefined || virtualEnclave === undefined) {
        return undefined;
      }
      const name =
        output?.enclaveEndpointName ??
        olds?.name ??
        (yield* createMissionName(id));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        virtualEnclave,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, virtualEnclave, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, virtualEnclave } = news;
      const name =
        news.name ??
        output?.enclaveEndpointName ??
        (yield* createMissionName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualEnclaveName: virtualEnclave,
        enclaveEndpointName: name,
      };
      const desired = {
        ruleCollection: news.ruleCollection,
        updateMode: news.updateMode,
      };
      const get = getEndpoint(
        subscriptionId,
        resourceGroup,
        virtualEnclave,
        name,
      );
      const waitReady = waitForProvisioned(
        `enclave endpoint ${name}`,
        get,
        (endpoint) => endpoint.properties?.provisioningState,
        FAST,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const parent = news.location
          ? undefined
          : yield* getVirtualEnclave(
              subscriptionId,
              resourceGroup,
              virtualEnclave,
            );
        yield* mission.EnclaveEndpointsCreateOrUpdate({
          ...where,
          location:
            news.location ??
            output?.location ??
            parent?.location ??
            env.location,
          tags,
          properties: desired,
        });
      }
      observed = yield* waitReady;

      // Sync rules and tags; PATCH only the deltas.
      const properties = changedProperties(desired, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (properties !== undefined || tagsChanged) {
        yield* mission.UpdateEnclaveEndpoint({
          ...where,
          properties,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, virtualEnclave, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        mission.DeleteEnclaveEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualEnclaveName: output.virtualEnclave,
          enclaveEndpointName: output.enclaveEndpointName,
        }),
      );
      yield* waitUntilGone(
        `enclave endpoint ${output.enclaveEndpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.virtualEnclave,
          output.enclaveEndpointName,
        ),
        FAST,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.VirtualEnclaves.VirtualEnclave",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });

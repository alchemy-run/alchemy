import * as hybridconnectivity from "@distilled.cloud/azure/hybridconnectivity";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface EndpointProps {
  /**
   * ARM resource ID of the resource the endpoint is attached to, typically
   * an Azure Arc-enabled server (`Azure.HybridCompute.Machine`). Changing it
   * replaces the endpoint.
   */
  resourceUri: string;
  /**
   * Name of the endpoint. Azure Arc SSH and Windows Admin Center expect
   * `default`. Changing it replaces the endpoint.
   * @default "default"
   */
  name?: string;
  /**
   * Type of the endpoint. Arc-enabled servers accept only `default`
   * (`custom` fails with `Not supported endpoint`). Changing it replaces
   * the endpoint.
   * @default "default"
   */
  type?: "default" | "custom";
  /**
   * ARM resource ID of the connectivity target. Azure does not support
   * updating an endpoint in place, so changing it recreates the endpoint.
   */
  resourceId?: string;
}

export interface Endpoint extends Resource<
  "Azure.HybridConnectivity.Endpoint",
  EndpointProps,
  {
    /** Name of the endpoint. */
    endpointName: string;
    /** ARM resource ID of the resource the endpoint is attached to. */
    resourceUri: string;
    /** ARM resource ID of the endpoint. */
    endpointId: string;
    /** Type of the endpoint (`default` or `custom`). */
    type: string;
    /** ARM resource ID of the connectivity target, if any. */
    resourceId: string | undefined;
    /** ARM provisioning state of the endpoint. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc hybrid connectivity endpoint. It is the extension resource
 * that lets Azure Arc SSH and Windows Admin Center reach an Arc-enabled
 * server through Azure Relay, without inbound ports.
 *
 * Endpoints carry no tags or free-form fields, so Alchemy cannot mark
 * them; one found at the expected scope is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/ssh-arc-overview
 *
 * ### Enabling Arc connectivity
 * **Example:** Default endpoint on an Arc server
 * ```typescript
 * const machine = yield* Azure.HybridCompute.Machine("Server", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.HybridConnectivity.Endpoint("Endpoint", {
 *   resourceUri: machine.machineId,
 * });
 * ```
 *
 * @resource
 */
export const Endpoint = Resource<Endpoint>("Azure.HybridConnectivity.Endpoint");

/** Lowercased ARM id comparison (ARM echoes ids with mixed casing). */
const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const getEndpoint = (resourceUri: string, endpointName: string) =>
  orUndefinedIfNotFound(
    hybridconnectivity.GetEndpoint({ resourceUri, endpointName }),
  );

const toAttrs = (
  resourceUri: string,
  name: string,
  observed: hybridconnectivity.GetEndpointResponse,
): Endpoint["Attributes"] => ({
  endpointName: name,
  resourceUri,
  endpointId: observed.id ?? "",
  type: observed.properties?.type ?? "default",
  resourceId: observed.properties?.resourceId,
  provisioningState: observed.properties?.provisioningState,
});

export const EndpointProvider = () =>
  Provider.succeed(Endpoint, {
    stables: ["endpointName", "resourceUri", "endpointId"],

    // Extension resources vanish with the resource they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameScope =
        sameId(news.resourceUri, output.resourceUri) &&
        (news.name ?? "default").toLowerCase() ===
          output.endpointName.toLowerCase();
      if (!sameScope) return { action: "replace" } as const;
      // Endpoints reject PATCH ("Not supported operation"), so any property
      // change recreates the endpoint at the same ARM id: delete first.
      if (
        (news.type ?? "default").toLowerCase() !== output.type.toLowerCase() ||
        (news.resourceId !== undefined &&
          !sameId(news.resourceId, output.resourceId))
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const resourceUri = output?.resourceUri ?? olds?.resourceUri;
      if (resourceUri === undefined) return undefined;
      const name = output?.endpointName ?? olds?.name ?? "default";
      const observed = yield* getEndpoint(resourceUri, name);
      return observed === undefined
        ? undefined
        : toAttrs(resourceUri, name, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridConnectivity");
      const { resourceUri } = news;
      const name = news.name ?? "default";
      const properties = {
        type: news.type ?? "default",
        resourceId: news.resourceId,
      };
      const get = getEndpoint(resourceUri, name);

      // Observe.
      const observed = yield* get;

      // Ensure. Endpoints reject PATCH; the PUT is an upsert, so drift found
      // on adoption is converged by re-sending the desired properties.
      if (
        observed === undefined ||
        (observed.properties?.type ?? "default").toLowerCase() !==
          properties.type.toLowerCase() ||
        (news.resourceId !== undefined &&
          !sameId(observed.properties?.resourceId, news.resourceId))
      ) {
        yield* hybridconnectivity.EndpointsCreateOrUpdate({
          resourceUri,
          endpointName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `hybrid connectivity endpoint ${resourceUri}/${name}`,
        get,
        (value) => value.properties?.provisioningState,
      );
      return toAttrs(resourceUri, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        hybridconnectivity.DeleteEndpoint({
          resourceUri: output.resourceUri,
          endpointName: output.endpointName,
        }),
      );
      yield* waitUntilGone(
        `hybrid connectivity endpoint ${output.resourceUri}/${output.endpointName}`,
        getEndpoint(output.resourceUri, output.endpointName),
      );
    }),
  });

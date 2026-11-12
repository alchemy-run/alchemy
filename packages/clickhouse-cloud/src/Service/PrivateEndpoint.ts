import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { requireResult } from "../Errors.ts";
import { getLiveService } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

export interface PrivateEndpointProps {
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the resource. */
  serviceId: string;
  /**
   * ID of the endpoint in your cloud: an AWS VPC endpoint ID
   * (`vpce-…`), a GCP Private Service Connect endpoint, or an Azure private
   * endpoint. It must point at the service's `privateEndpointConfig`
   * endpoint service. Changing it replaces the resource.
   */
  endpointId: string;
  /** What the endpoint is for. Changing it replaces the resource. */
  description?: string;
}

export interface PrivateEndpointAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Endpoint ID. */
  endpointId: string;
  /** Endpoint service the cloud endpoint must point at (AWS service name, GCP attachment, Azure alias). */
  endpointServiceId: string | undefined;
  /** Host name of the service over the private endpoint. */
  privateDnsHostname: string | undefined;
  /**
   * Whether this resource registered the endpoint with the organization
   * (rather than allowing one already registered), so destroy unregisters
   * it once no service allows it.
   */
  registered: boolean;
}

export type PrivateEndpoint = Resource<
  "ClickHouseCloud.Service.PrivateEndpoint",
  PrivateEndpointProps,
  PrivateEndpointAttributes,
  never,
  Providers
>;

/**
 * A private endpoint in your own cloud network (AWS PrivateLink, GCP
 * Private Service Connect, Azure Private Link) allowed to reach a service,
 * so traffic never crosses the public internet.
 *
 * Create the endpoint in your cloud first, pointing at the service's
 * endpoint service (the `endpointServiceId` attribute, also on the
 * service's `getServicePrivateEndpointConfig`). Deploy registers it with
 * the organization and allows it on the service; destroy removes it from
 * the service, and unregisters it from the organization when deploy
 * registered it and no other service allows it. Needs a tier with private networking (Scale or Enterprise).
 * @see https://clickhouse.com/docs/manage/security/aws-privatelink
 *
 * ### Connecting over PrivateLink
 * **Example:** Allow an AWS VPC endpoint
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [],
 * });
 * yield* ClickHouseCloud.Service.PrivateEndpoint("AppVpc", {
 *   serviceId: analytics.serviceId,
 *   endpointId: "vpce-0123456789abcdef0",
 *   description: "app vpc",
 * });
 * ```
 *
 * :::caution
 * Changing any prop replaces the resource: the old endpoint loses access
 * before the new one is allowed.
 * :::
 *
 * @resource
 * @product Service
 */
export const PrivateEndpoint = Resource<PrivateEndpoint>("ClickHouseCloud.Service.PrivateEndpoint");

const endpointConfig = (organizationId: string, serviceId: string) =>
  service
    .getServicePrivateEndpointConfig({ organizationId, serviceId })
    .pipe(Effect.flatMap(requireResult("getServicePrivateEndpointConfig")));

export const PrivateEndpointProvider = () =>
  Provider.effect(
    PrivateEndpoint,
    Effect.succeed({
      stables: ["serviceId", "organizationId", "endpointId"],
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (
          news.serviceId !== olds.serviceId ||
          news.endpointId !== olds.endpointId ||
          news.description !== olds.description
        ) {
          // Delete first: the same endpoint can't be allowed twice.
          return { action: "replace", deleteFirst: true } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const endpointId = output?.endpointId ?? olds.endpointId;
        const live = yield* getLiveService(organizationId, serviceId);
        if (live === undefined || !(live.privateEndpointIds ?? []).includes(endpointId)) {
          return undefined;
        }
        return {
          serviceId,
          organizationId,
          endpointId,
          endpointServiceId: output?.endpointServiceId,
          privateDnsHostname: output?.privateDnsHostname,
          registered: output?.registered ?? false,
        };
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId, endpointId } = news;
        // Observe
        const live = yield* service
          .getService({ organizationId, serviceId })
          .pipe(Effect.flatMap(requireResult("getService")));
        // Ensure: register with the organization and allow on the service,
        // or only allow one the organization already knows.
        let registered = output?.registered ?? false;
        if (!(live.privateEndpointIds ?? []).includes(endpointId)) {
          if ((live.availablePrivateEndpointIds ?? []).includes(endpointId)) {
            yield* service.updateService({
              organizationId,
              serviceId,
              privateEndpointIds: { add: [endpointId] },
            });
          } else {
            yield* service.createServicePrivateEndpoint({
              organizationId,
              serviceId,
              id: endpointId,
              description: news.description,
            });
            registered = true;
          }
        }
        const config = yield* endpointConfig(organizationId, serviceId);
        return {
          serviceId,
          organizationId,
          endpointId,
          endpointServiceId: config.endpointServiceId,
          privateDnsHostname: config.privateDnsHostname,
          registered,
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        const { organizationId, endpointId } = output;
        yield* service
          .updateService({
            organizationId,
            serviceId: output.serviceId,
            privateEndpointIds: { remove: [endpointId] },
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        if (!output.registered) return;
        // Unregister what this resource registered, once no service allows
        // it. The organization-level patch is the API's only way to.
        const services = yield* service
          .listServices({ organizationId })
          .pipe(Effect.flatMap(requireResult("listServices")));
        if (services.some((s) => (s.privateEndpointIds ?? []).includes(endpointId))) return;
        const org = yield* organization
          .getOrganization({ organizationId })
          .pipe(Effect.flatMap(requireResult("getOrganization")));
        const entry = (org.privateEndpoints ?? []).find((e) => e.id === endpointId);
        if (entry === undefined) return;
        yield* organization.updateOrganization({
          organizationId,
          privateEndpoints: {
            remove: [{ id: entry.id, cloudProvider: entry.cloudProvider, region: entry.region }],
          },
        });
      }),
    }),
  );

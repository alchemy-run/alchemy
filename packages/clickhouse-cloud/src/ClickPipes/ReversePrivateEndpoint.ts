import * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { ResultMissing, requireResult } from "../Errors.ts";
import { pollUntil } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

export interface ReversePrivateEndpointProps {
  /** ID of the service whose ClickPipes use the endpoint. Changing it replaces the endpoint. */
  serviceId: string;
  /** What the endpoint is for, up to 255 characters. Changing it replaces the endpoint. */
  description: string;
  /** What the endpoint connects to. Changing it replaces the endpoint. */
  type: "VPC_ENDPOINT_SERVICE" | "VPC_RESOURCE" | "MSK_MULTI_VPC" | "GCP_PSC_SERVICE_ATTACHMENT";
  /** AWS VPC endpoint service name (`VPC_ENDPOINT_SERVICE`). Changing it replaces the endpoint. */
  vpcEndpointServiceName?: string;
  /** AWS VPC Lattice resource configuration ID (`VPC_RESOURCE`). Changing it replaces the endpoint. */
  vpcResourceConfigurationId?: string;
  /** AWS RAM resource share ARN (`VPC_RESOURCE`). Changing it replaces the endpoint. */
  vpcResourceShareArn?: string;
  /** MSK cluster ARN (`MSK_MULTI_VPC`). Changing it replaces the endpoint. */
  mskClusterArn?: string;
  /** MSK authentication (`MSK_MULTI_VPC`). Changing it replaces the endpoint. */
  mskAuthentication?: "SASL_IAM" | "SASL_SCRAM";
  /** GCP PSC service attachment URI (`GCP_PSC_SERVICE_ATTACHMENT`, private preview). Changing it replaces the endpoint. */
  gcpServiceAttachment?: string;
  /** Private DNS names that resolve to the endpoint; the whole list is replaced on change. */
  customPrivateDnsMappings?: Array<{ privateDnsName: string; targetId?: string }>;
  /**
   * Whether deploy waits for `Ready`. By default it also returns at
   * `PendingAcceptance`: an AWS endpoint service that requires acceptance
   * needs its owner to accept the connection (the `endpointId` attribute).
   * @default false
   */
  waitForReady?: boolean;
}

export interface ReversePrivateEndpointAttributes {
  /** Reverse private endpoint ID: pass it in a Kafka pipe's `reversePrivateEndpointIds`. */
  reversePrivateEndpointId: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Cloud-side endpoint ID (the connection to accept on an AWS endpoint service). */
  endpointId: string | undefined;
  /** `Ready`, `PendingAcceptance`, `Provisioning`, …. */
  status: string | undefined;
  /** Internal DNS names of the endpoint. */
  dnsNames: string[];
  /** Private DNS names. */
  privateDnsNames: string[];
}

export type ReversePrivateEndpoint = Resource<
  "ClickHouseCloud.ClickPipes.ReversePrivateEndpoint",
  ReversePrivateEndpointProps,
  ReversePrivateEndpointAttributes,
  never,
  Providers
>;

/**
 * A reverse private endpoint: lets a service's ClickPipes reach a source
 * in your own network (an AWS VPC endpoint service or VPC Lattice
 * resource, an MSK cluster over multi-VPC connectivity, a GCP Private
 * Service Connect attachment) without a public address.
 *
 * Deploy waits until the endpoint is `Ready`, or `PendingAcceptance` when
 * the AWS endpoint service needs its owner to accept the connection
 * (`waitForReady` waits for `Ready`). Only the DNS mappings update in
 * place. Destroying the resource deletes the endpoint; delete pipes that
 * use it first.
 * @see https://clickhouse.com/docs/integrations/clickpipes/aws-privatelink
 *
 * ### Reaching a Private Source
 * **Example:** A VPC endpoint service in your AWS account
 * ```typescript
 * const rpe = yield* ClickHouseCloud.ClickPipes.ReversePrivateEndpoint("KafkaLink", {
 *   serviceId: analytics.serviceId,
 *   description: "kafka in the app vpc",
 *   type: "VPC_ENDPOINT_SERVICE",
 *   vpcEndpointServiceName: "com.amazonaws.vpce.us-east-1.vpce-svc-0123456789abcdef0",
 * });
 * ```
 *
 * :::caution
 * Changing anything but `customPrivateDnsMappings` replaces the endpoint,
 * and pipes using it lose their connection until they use the new one.
 * :::
 *
 * @resource
 * @product ClickPipes
 */
export const ReversePrivateEndpoint = Resource<ReversePrivateEndpoint>(
  "ClickHouseCloud.ClickPipes.ReversePrivateEndpoint",
);

const CREATE_ONLY = [
  "serviceId",
  "description",
  "type",
  "vpcEndpointServiceName",
  "vpcResourceConfigurationId",
  "vpcResourceShareArn",
  "mskClusterArn",
  "mskAuthentication",
  "gcpServiceAttachment",
] as const satisfies ReadonlyArray<keyof ReversePrivateEndpointProps>;

const toAttributes = (
  organizationId: string,
  serviceId: string,
  rpe: pipes.ReversePrivateEndpoint,
): ReversePrivateEndpointAttributes => ({
  reversePrivateEndpointId: rpe.id ?? "",
  serviceId,
  organizationId,
  endpointId: rpe.endpointId,
  status: rpe.status,
  dnsNames: rpe.dnsNames ?? [],
  privateDnsNames: rpe.privateDnsNames ?? [],
});

const getEndpoint = (organizationId: string, serviceId: string, reversePrivateEndpointId: string) =>
  pipes
    .getClickPipeReversePrivateEndpoint({ organizationId, serviceId, reversePrivateEndpointId })
    .pipe(
      Effect.flatMap(requireResult("getClickPipeReversePrivateEndpoint")),
      Effect.map((rpe) => (rpe.status === "Deleting" ? undefined : rpe)),
      Effect.catchTag("NotFound", () => Effect.undefined),
    );

const FAILED: Partial<Record<string, true>> = { Failed: true, Rejected: true, Expired: true };

export const ReversePrivateEndpointProvider = () =>
  Provider.effect(
    ReversePrivateEndpoint,
    Effect.succeed({
      stables: ["reversePrivateEndpointId", "serviceId", "organizationId", "endpointId"],
      nuke: { dependsOn: ["ClickHouseCloud.ClickPipes.ClickPipe"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (CREATE_ONLY.some((key) => !deepEqual(news[key], olds[key]))) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        if (output === undefined) return undefined;
        const found = yield* getEndpoint(
          output.organizationId,
          output.serviceId,
          output.reversePrivateEndpointId,
        );
        void olds;
        return found === undefined
          ? undefined
          : toAttributes(output.organizationId, output.serviceId, found);
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        // Observe
        let observed = output?.reversePrivateEndpointId
          ? yield* getEndpoint(organizationId, serviceId, output.reversePrivateEndpointId)
          : undefined;
        // Ensure
        if (observed === undefined) {
          const created = yield* pipes
            .createClickPipeReversePrivateEndpoint({
              organizationId,
              serviceId,
              description: news.description,
              type: news.type,
              vpcEndpointServiceName: news.vpcEndpointServiceName,
              vpcResourceConfigurationId: news.vpcResourceConfigurationId,
              vpcResourceShareArn: news.vpcResourceShareArn,
              mskClusterArn: news.mskClusterArn,
              mskAuthentication: news.mskAuthentication,
              gcpServiceAttachment: news.gcpServiceAttachment,
              customPrivateDnsMappings: news.customPrivateDnsMappings,
            })
            .pipe(Effect.flatMap(requireResult("createClickPipeReversePrivateEndpoint")));
          if (created.id === undefined) {
            return yield* new ResultMissing({
              operation: "createClickPipeReversePrivateEndpoint (id)",
            });
          }
          observed = created;
        }
        const id = observed.id!;
        // Sync the only mutable field: the whole DNS mapping list.
        const want = news.customPrivateDnsMappings ?? [];
        if (
          !deepEqual(
            want,
            (observed.customPrivateDnsMappings ?? []).map((m) => ({
              privateDnsName: m.privateDnsName,
              ...(m.targetId ? { targetId: m.targetId } : {}),
            })),
          )
        ) {
          yield* pipes.updateClickPipeReversePrivateEndpoint({
            organizationId,
            serviceId,
            reversePrivateEndpointId: id,
            customPrivateDnsMappings: want,
          });
        }
        // Wait
        const ready = yield* pollUntil({
          kind: "reverse private endpoint",
          id,
          waitingFor: news.waitForReady ? "Ready" : "Ready or PendingAcceptance",
          read: getEndpoint(organizationId, serviceId, id),
          state: (rpe) => rpe?.status,
          done: (rpe): rpe is pipes.ReversePrivateEndpoint =>
            rpe?.status === "Ready" || (!news.waitForReady && rpe?.status === "PendingAcceptance"),
          failed: (rpe) =>
            rpe === undefined
              ? "deleted while provisioning"
              : FAILED[rpe.status ?? ""]
                ? rpe.status
                : undefined,
          session,
          budget: Duration.minutes(30),
        });
        return toAttributes(organizationId, serviceId, ready);
      }),
      delete: Effect.fn(function* ({ output, session }) {
        const { organizationId, serviceId, reversePrivateEndpointId } = output;
        yield* pipes
          .deleteClickPipeReversePrivateEndpoint({
            organizationId,
            serviceId,
            reversePrivateEndpointId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* pollUntil({
          kind: "reverse private endpoint",
          id: reversePrivateEndpointId,
          waitingFor: "deleted",
          read: getEndpoint(organizationId, serviceId, reversePrivateEndpointId),
          state: (rpe) => rpe?.status,
          done: (rpe): rpe is undefined => rpe === undefined,
          session,
          budget: Duration.minutes(20),
        });
      }),
    }),
  );

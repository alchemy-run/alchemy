import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEventGridName, sameName } from "./common.ts";
import {
  isOwnedDescription,
  markedDescription,
  reconcileChild,
  userDescription,
} from "./MqttShared.ts";

export interface CaCertificateProps {
  /** Resource group of the namespace. Changing it replaces the CA certificate. */
  resourceGroup: string;
  /**
   * Name of the Event Grid namespace (MQTT broker enabled). Changing it
   * replaces the CA certificate.
   */
  namespace: string;
  /**
   * Client group name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the CA certificate.
   */
  name?: string;
  /**
   * The CA certificate in base64-encoded PEM form (the PEM body without the
   * `-----BEGIN/END CERTIFICATE-----` lines). Changing it replaces the
   * resource.
   */
  encodedCertificate: string;
  /** Description of the CA certificate. */
  description?: string;
}

export interface CaCertificate extends Resource<
  "Azure.EventGrid.CaCertificate",
  CaCertificateProps,
  {
    /** Name of the CA certificate. */
    caCertificateName: string;
    /** ARM resource ID of the CA certificate. */
    caCertificateId: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Name of the namespace. */
    namespace: string;
    /** Issue time of the certificate (UTC). */
    issueTimeInUtc: string | undefined;
    /** Expiry time of the certificate (UTC). */
    expiryTimeInUtc: string | undefined;
    /** Description (Alchemy ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A CA certificate registered with an Event Grid namespace's MQTT broker.
 * Clients whose certificates chain to it authenticate with the
 * `*MatchesAuthenticationName` validation schemes.
 *
 * CA certificates have no tags; Alchemy appends an ownership marker to the
 * `description`.
 *
 * @see https://learn.microsoft.com/azure/event-grid/mqtt-certificate-chain-client-authentication
 *
 * ### Registering a CA
 * **Example:** CA certificate from a PEM file
 * ```typescript
 * const pem = yield* fs.readFileString("ca.pem");
 * const ca = yield* Azure.EventGrid.CaCertificate("devices-ca", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   encodedCertificate: pem
 *     .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
 *     .replace(/\s/g, ""),
 *   description: "Device fleet CA",
 * });
 * ```
 *
 * @resource
 */
export const CaCertificate = Resource<CaCertificate>("Azure.EventGrid.CaCertificate");

type ObservedCaCertificate = Pick<eventgrid.CaCertificate, "id" | "properties">;

const getCaCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  caCertificateName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetCaCertificate({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      caCertificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  observed: ObservedCaCertificate,
): CaCertificate["Attributes"] => ({
  caCertificateName: name,
  caCertificateId: observed.id ?? "",
  resourceGroup,
  namespace,
  issueTimeInUtc: observed.properties?.issueTimeInUtc,
  expiryTimeInUtc: observed.properties?.expiryTimeInUtc,
  description: userDescription(observed.properties?.description),
});

export const CaCertificateProvider = () =>
  Provider.succeed(CaCertificate, {
    stables: ["caCertificateName", "caCertificateId", "resourceGroup", "namespace"],

    // Deleted with their namespace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespace) ||
        (news.name !== undefined && news.name !== output.caCertificateName) ||
        (olds?.encodedCertificate !== undefined &&
          news.encodedCertificate !== olds.encodedCertificate)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const name =
        output?.caCertificateName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
      const observed = yield* getCaCertificate(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      return (yield* isOwnedDescription(id, observed.properties?.description))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, namespace } = news;
      const name =
        news.name ??
        output?.caCertificateName ??
        (yield* createEventGridName(id, 50));
      const description = yield* markedDescription(id, news.description);
      const observed = yield* reconcileChild({
        label: `event grid CA certificate ${name}`,
        get: getCaCertificate(subscriptionId, resourceGroup, namespace, name),
        put: eventgrid.CaCertificatesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          caCertificateName: name,
          properties: {
            description,
            encodedCertificate: news.encodedCertificate,
          },
        }),
        // The certificate itself is immutable (a change replaces).
        differs: (have) => have.properties?.description !== description,
      });
      return toAttrs(resourceGroup, namespace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteCaCertificate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          caCertificateName: output.caCertificateName,
        }),
      );
      yield* waitUntilGone(
        `event grid CA certificate ${output.caCertificateName}`,
        getCaCertificate(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.caCertificateName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Namespace"] },
  });

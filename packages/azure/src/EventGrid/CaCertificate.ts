import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEventGridName, sameName } from "./common.ts";
import {
  isOwnedDescription,
  markedDescription,
  reconcileChild,
  userDescription,
} from "./MqttShared.ts";

export interface CaCertificateProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the CA certificate.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the Event Grid namespace, e.g. `namespace.namespaceName` of an
   * `Azure.EventGrid.Namespace` with the MQTT broker enabled.
   *
   * :::caution
   * Changing it replaces the CA certificate.
   * :::
   */
  namespace: string;
  /**
   * CA certificate name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the CA certificate.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * The CA certificate in PEM format, including the
   * `-----BEGIN CERTIFICATE-----` header and `-----END CERTIFICATE-----`
   * footer (surrounding whitespace is trimmed). Must not contain a private
   * key.
   *
   * :::caution
   * Changing it replaces the CA certificate.
   * :::
   */
  encodedCertificate: string;
  /**
   * Description of the CA certificate. Alchemy appends its ownership marker
   * (` [alchemy:{stack}/{stage}/{id}]`) to it.
   *
   * :::caution
   * Changing it replaces the CA certificate.
   * :::
   * @default no description (only the ownership marker)
   */
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
    /** Issue time of the certificate (ISO 8601, UTC). */
    issueTimeInUtc: string | undefined;
    /** Expiry time of the certificate (ISO 8601, UTC). */
    expiryTimeInUtc: string | undefined;
    /** Description (Alchemy ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A CA certificate of an Event Grid MQTT broker
 * (`Microsoft.EventGrid/namespaces/caCertificates`). Register your device
 * CA so clients whose certificates chain to it can authenticate with the
 * `*MatchesAuthenticationName` validation schemes of `Azure.EventGrid.Client`.
 *
 * CA certificates have no tags; Alchemy appends an ownership marker to the
 * `description`.
 *
 * :::caution[Changing any prop replaces the CA certificate]
 * Azure rejects every update of a CA certificate, so a change to
 * `encodedCertificate`, `description`, `name`, `namespace`, or
 * `resourceGroup` makes Alchemy create a new certificate and delete the old
 * one.
 * :::
 *
 * :::caution[The namespace needs the MQTT broker]
 * Declare the parent `Azure.EventGrid.Namespace` with
 * `topicSpacesConfiguration: { state: "Enabled" }`. Azure cannot turn the
 * broker off again: switching it to `Disabled` replaces the namespace.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/mqtt-certificate-chain-client-authentication
 *
 * ### Registering a CA
 * **Example:** CA certificate from a PEM file
 * ```typescript
 * const fs = yield* FileSystem.FileSystem;
 * const namespace = yield* Azure.EventGrid.Namespace("iot", {
 *   topicSpacesConfiguration: { state: "Enabled" },
 * });
 * const ca = yield* Azure.EventGrid.CaCertificate("devices-ca", {
 *   namespace: namespace.namespaceName,
 *   encodedCertificate: yield* fs.readFileString("ca.pem"),
 *   description: "Device fleet CA",
 * });
 * ```
 *
 * @resource
 */
export const CaCertificate = GroupedResource<CaCertificate>("Azure.EventGrid.CaCertificate");

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
        // Azure rejects every update of a CA certificate ("CA Certificates
        // cannot be updated"), so any change replaces it.
        (olds?.encodedCertificate !== undefined &&
          (news.encodedCertificate.trim() !== olds.encodedCertificate.trim() ||
            news.description !== olds.description))
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
      const name = output?.caCertificateName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getCaCertificate(subscriptionId, resourceGroup, namespace, name);
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
      const name = news.name ?? output?.caCertificateName ?? (yield* createEventGridName(id, 50));
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
            // Azure rejects a PEM with a trailing newline.
            encodedCertificate: news.encodedCertificate.trim(),
          },
        }),
        // Immutable: Azure rejects updates, and diff replaces on any change.
        differs: () => false,
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

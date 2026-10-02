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

/** How the broker validates a client's X.509 certificate. */
export type ClientValidationScheme =
  | "SubjectMatchesAuthenticationName"
  | "DnsMatchesAuthenticationName"
  | "UriMatchesAuthenticationName"
  | "IpMatchesAuthenticationName"
  | "EmailMatchesAuthenticationName"
  | "ThumbprintMatch";

/** Value of a client attribute. */
export type ClientAttributeValue = string | number | boolean | string[];

export interface ClientProps {
  /** Resource group of the namespace. Changing it replaces the client. */
  resourceGroup: string;
  /**
   * Name of the Event Grid namespace (MQTT broker enabled). Changing it
   * replaces the client.
   */
  namespace: string;
  /**
   * Client name: 3-50 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the client.
   */
  name?: string;
  /**
   * Name the client presents when it authenticates (matched against its
   * certificate according to `validationScheme`).
   * @default the client name
   */
  authenticationName?: string;
  /**
   * Certificate validation scheme.
   * @default "SubjectMatchesAuthenticationName"
   */
  validationScheme?: ClientValidationScheme;
  /**
   * SHA-256 thumbprints (hex) of the certificates the client may present.
   * Required with `validationScheme: "ThumbprintMatch"` (1-2 thumbprints).
   */
  allowedThumbprints?: string[];
  /**
   * Whether the client may connect.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
  /**
   * Attributes used by client group queries, e.g. `{ role: "sensor" }`.
   * @default {}
   */
  attributes?: Record<string, ClientAttributeValue>;
  /** Description of the client. */
  description?: string;
}

export interface Client extends Resource<
  "Azure.EventGrid.Client",
  ClientProps,
  {
    /** Name of the client. */
    clientName: string;
    /** ARM resource ID of the client. */
    clientId: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Name of the namespace. */
    namespace: string;
    /** Authentication name of the client. */
    authenticationName: string | undefined;
    /** Certificate validation scheme. */
    validationScheme: string | undefined;
    /** Whether the client may connect. */
    state: string | undefined;
    /** Client attributes. */
    attributes: Record<string, unknown>;
    /** Description (Alchemy ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An MQTT client registered with an Event Grid namespace's MQTT broker.
 * Clients authenticate with X.509 certificates; their attributes place them
 * in client groups, which permission bindings grant access to topic spaces.
 *
 * Clients have no tags; Alchemy appends an ownership marker to the
 * `description`.
 *
 * @see https://learn.microsoft.com/azure/event-grid/mqtt-clients
 *
 * ### Registering Clients
 * **Example:** Client authenticated by certificate thumbprint
 * ```typescript
 * const namespace = yield* Azure.EventGrid.Namespace("iot", {
 *   resourceGroup: group.resourceGroupName,
 *   topicSpacesConfiguration: { state: "Enabled" },
 * });
 * const device = yield* Azure.EventGrid.Client("device-1", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   validationScheme: "ThumbprintMatch",
 *   allowedThumbprints: [deviceCertThumbprint],
 *   attributes: { role: "sensor" },
 * });
 * ```
 *
 * **Example:** Client validated by a CA certificate (subject = name)
 * ```typescript
 * const device = yield* Azure.EventGrid.Client("device-2", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   authenticationName: "device-2",
 *   validationScheme: "SubjectMatchesAuthenticationName",
 * });
 * ```
 *
 * @resource
 */
export const Client = Resource<Client>("Azure.EventGrid.Client");

type ObservedClient = Pick<eventgrid.Client, "id" | "properties">;

const getClient = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  clientName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetClient({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      clientName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  observed: ObservedClient,
): Client["Attributes"] => ({
  clientName: name,
  clientId: observed.id ?? "",
  resourceGroup,
  namespace,
  authenticationName: observed.properties?.authenticationName,
  validationScheme:
    observed.properties?.clientCertificateAuthentication?.validationScheme,
  state: observed.properties?.state,
  attributes: { ...observed.properties?.attributes },
  description: userDescription(observed.properties?.description),
});

/** JSON with sorted keys, so attribute order does not matter. */
const canonical = (value: Record<string, unknown> | undefined) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value ?? {})
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

const sortedLower = (values: readonly string[] | undefined) =>
  JSON.stringify([...(values ?? [])].map((v) => v.toLowerCase()).sort());

export const ClientProvider = () =>
  Provider.succeed(Client, {
    stables: ["clientName", "clientId", "resourceGroup", "namespace"],

    // Deleted with their namespace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespace) ||
        (news.name !== undefined && news.name !== output.clientName)
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
        output?.clientName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getClient(
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
        news.name ?? output?.clientName ?? (yield* createEventGridName(id, 50));
      // The PUT replaces every property, so the desired body is complete.
      const properties = {
        description: yield* markedDescription(id, news.description),
        authenticationName: news.authenticationName ?? name,
        clientCertificateAuthentication: {
          validationScheme:
            news.validationScheme ?? "SubjectMatchesAuthenticationName",
          allowedThumbprints: news.allowedThumbprints,
        },
        state: news.state ?? "Enabled",
        attributes: news.attributes ?? {},
      } satisfies eventgrid.ClientPropertiesInput;
      const observed = yield* reconcileChild({
        label: `event grid client ${name}`,
        get: getClient(subscriptionId, resourceGroup, namespace, name),
        put: eventgrid.ClientsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          clientName: name,
          properties,
        }),
        differs: (have) => {
          const props = have.properties ?? {};
          const auth = props.clientCertificateAuthentication;
          return (
            props.description !== properties.description ||
            props.authenticationName !== properties.authenticationName ||
            (auth?.validationScheme ?? "SubjectMatchesAuthenticationName") !==
              properties.clientCertificateAuthentication.validationScheme ||
            sortedLower(auth?.allowedThumbprints) !==
              sortedLower(news.allowedThumbprints) ||
            (props.state ?? "Enabled") !== properties.state ||
            canonical(props.attributes) !== canonical(properties.attributes)
          );
        },
      });
      return toAttrs(resourceGroup, namespace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteClient({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          clientName: output.clientName,
        }),
      );
      yield* waitUntilGone(
        `event grid client ${output.clientName}`,
        getClient(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.clientName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Namespace"] },
  });

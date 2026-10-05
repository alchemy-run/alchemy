import * as communication from "@distilled.cloud/azure/communication";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  createCommunicationName,
  DEFAULT_DATA_LOCATION,
  GLOBAL_LOCATION,
  lower,
} from "./CommunicationShared.ts";

export type CommunicationServicePublicNetworkAccess =
  | "Enabled"
  | "Disabled"
  | "SecuredByPerimeter";

export interface CommunicationServiceIdentity {
  /** Identity type. `None` removes the identity. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM resource IDs of user-assigned identities (with `UserAssigned`). */
  userAssignedIdentities?: string[];
}

export interface CommunicationServiceProps {
  /**
   * Resource group the communication service is created in. Changing it
   * replaces the service.
   */
  resourceGroup: string;
  /**
   * Globally unique service name (it becomes
   * `{name}.communication.azure.com`): 1-63 letters, digits, and hyphens.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the service.
   */
  name?: string;
  /**
   * ARM location. Communication services are global resources. Changing it
   * replaces the service.
   * @default "global"
   */
  location?: string;
  /**
   * Geography where data is stored at rest, e.g. `United States`, `Europe`,
   * `UK`. Linked email domains must use the same data location. Changing it
   * replaces the service.
   * @default "United States"
   */
  dataLocation?: string;
  /**
   * ARM resource IDs of email domains (`EmailDomain.domainId`) the service
   * can send email from.
   * @default no linked domains
   */
  linkedDomains?: string[];
  /**
   * Whether the service is reachable from public networks.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: CommunicationServicePublicNetworkAccess;
  /**
   * Disable access-key authentication so only Entra ID tokens are accepted.
   * When `true`, the key attributes are not read.
   * @default false
   */
  disableLocalAuth?: boolean;
  /** Managed identity of the service. */
  identity?: CommunicationServiceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CommunicationService extends Resource<
  "Azure.Communication.CommunicationService",
  CommunicationServiceProps,
  {
    /** Name of the communication service. */
    communicationServiceName: string;
    /** ARM resource ID of the communication service. */
    communicationServiceId: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** ARM location of the service (`global`). */
    location: string;
    /** Geography where data is stored at rest. */
    dataLocation: string;
    /** Host name of the service, e.g. `name.unitedstates.communication.azure.com`. */
    hostName: string | undefined;
    /** HTTPS endpoint of the service. */
    endpoint: string | undefined;
    /** Immutable resource ID of the service. */
    immutableResourceId: string | undefined;
    /** Version of the service. */
    version: string | undefined;
    /** ARM resource IDs of the linked email domains. */
    linkedDomains: string[];
    /** Public network access setting. */
    publicNetworkAccess: string | undefined;
    /** Whether access-key authentication is disabled. */
    disableLocalAuth: boolean;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity, if any. */
    tenantId: string | undefined;
    /** Primary access key (undefined when local auth is disabled). */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary access key (undefined when local auth is disabled). */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** Connection string built from the primary key. */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Connection string built from the secondary key. */
    secondaryConnectionString: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Communication Services resource — the endpoint for sending email
 * and SMS, chat, and voice/video calling.
 *
 * Email is sent from the email domains listed in `linkedDomains`; they must
 * be in the same `dataLocation` as the service.
 *
 * @see https://learn.microsoft.com/azure/communication-services/overview
 *
 * ### Creating a Communication Service
 * **Example:** Communication service with data in the United States
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const acs = yield* Azure.Communication.CommunicationService("acs", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // acs.primaryConnectionString → Redacted connection string
 * ```
 *
 * ### Sending Email
 * **Example:** Link an Azure-managed email domain
 * ```typescript
 * const email = yield* Azure.Communication.EmailService("email", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const domain = yield* Azure.Communication.EmailDomain("domain", {
 *   resourceGroup: group.resourceGroupName,
 *   emailService: email.emailServiceName,
 * });
 * const acs = yield* Azure.Communication.CommunicationService("acs", {
 *   resourceGroup: group.resourceGroupName,
 *   linkedDomains: [domain.domainId],
 * });
 * ```
 *
 * ### Entra ID Only
 * **Example:** Disable access keys and add a managed identity
 * ```typescript
 * const acs = yield* Azure.Communication.CommunicationService("acs", {
 *   resourceGroup: group.resourceGroupName,
 *   disableLocalAuth: true,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const CommunicationService = Resource<CommunicationService>(
  "Azure.Communication.CommunicationService",
);

type Observed = communication.GetCommunicationServiceResponse;

interface Keys {
  primaryKey: Redacted.Redacted<string> | undefined;
  secondaryKey: Redacted.Redacted<string> | undefined;
  primaryConnectionString: Redacted.Redacted<string> | undefined;
  secondaryConnectionString: Redacted.Redacted<string> | undefined;
}

const NO_KEYS: Keys = {
  primaryKey: undefined,
  secondaryKey: undefined,
  primaryConnectionString: undefined,
  secondaryConnectionString: undefined,
};

const redact = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  communicationServiceName: string,
) =>
  orUndefinedIfNotFound(
    communication.GetCommunicationService({
      subscriptionId,
      resourceGroupName,
      communicationServiceName,
    }),
  );

const readKeys = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  communicationServiceName: string,
  observed: Observed,
) {
  if (observed.properties?.disableLocalAuth === true) return NO_KEYS;
  const keys = yield* communication.ListCommunicationServiceKeys({
    subscriptionId,
    resourceGroupName,
    communicationServiceName,
  });
  return {
    primaryKey: redact(keys.primaryKey),
    secondaryKey: redact(keys.secondaryKey),
    primaryConnectionString: redact(keys.primaryConnectionString),
    secondaryConnectionString: redact(keys.secondaryConnectionString),
  } satisfies Keys;
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed | communication.CommunicationServiceResource,
  keys: Keys,
): CommunicationService["Attributes"] => {
  const props = observed.properties;
  return {
    communicationServiceName: name,
    communicationServiceId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    dataLocation: props?.dataLocation ?? "",
    hostName: props?.hostName,
    endpoint:
      props?.hostName === undefined ? undefined : `https://${props.hostName}`,
    immutableResourceId: props?.immutableResourceId,
    version: props?.version,
    linkedDomains: [...(props?.linkedDomains ?? [])],
    publicNetworkAccess: props?.publicNetworkAccess,
    disableLocalAuth: props?.disableLocalAuth ?? false,
    principalId: observed.identity?.principalId,
    tenantId: observed.identity?.tenantId,
    ...keys,
    tags: userTags(observed.tags),
  };
};

const sortedJoin = (values: readonly string[] | undefined) =>
  (values ?? [])
    .map((v) => v.toLowerCase())
    .sort()
    .join(",");

/** Mutable properties whose observed value differs from the desired value. */
const propertyDelta = (
  news: CommunicationServiceProps,
  observed: communication.CommunicationServiceProperties | undefined,
): communication.CommunicationServiceUpdateProperties => {
  const delta: communication.CommunicationServiceUpdateProperties = {};
  if (
    news.linkedDomains !== undefined &&
    sortedJoin(news.linkedDomains) !== sortedJoin(observed?.linkedDomains)
  ) {
    delta.linkedDomains = news.linkedDomains;
  }
  if (
    news.publicNetworkAccess !== undefined &&
    lower(news.publicNetworkAccess) !==
      lower(observed?.publicNetworkAccess ?? "Enabled")
  ) {
    delta.publicNetworkAccess = news.publicNetworkAccess;
  }
  if (
    news.disableLocalAuth !== undefined &&
    news.disableLocalAuth !== (observed?.disableLocalAuth ?? false)
  ) {
    delta.disableLocalAuth = news.disableLocalAuth;
  }
  return delta;
};

const identityDelta = (
  desired: CommunicationServiceIdentity | undefined,
  observed: communication.GetCommunicationServiceResponseIdentity | undefined,
): communication.UpdateCommunicationServiceRequestIdentity | undefined => {
  if (desired === undefined) return undefined;
  const desiredIds = desired.userAssignedIdentities ?? [];
  if (
    lower(desired.type.replace(/\s/g, "")) ===
      lower((observed?.type ?? "None").replace(/\s/g, "")) &&
    sortedJoin(desiredIds) ===
      sortedJoin(Object.keys(observed?.userAssignedIdentities ?? {}))
  ) {
    return undefined;
  }
  return {
    type: desired.type,
    userAssignedIdentities:
      desiredIds.length > 0
        ? Object.fromEntries(desiredIds.map((id) => [id, {}]))
        : undefined,
  };
};

const WAIT = { interval: "3 seconds", times: 100 } as const;

export const CommunicationServiceProvider = () =>
  Provider.succeed(CommunicationService, {
    stables: [
      "communicationServiceName",
      "communicationServiceId",
      "resourceGroup",
      "location",
      "dataLocation",
      "hostName",
      "endpoint",
      "immutableResourceId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* communication
        .ListCommunicationServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListCommunicationServiceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) &&
          group !== undefined &&
          service.name !== undefined
          ? [toAttrs(group, service.name, service, NO_KEYS)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.communicationServiceName)) ||
        lower(news.location ?? GLOBAL_LOCATION) !== lower(output.location) ||
        lower(news.dataLocation ?? DEFAULT_DATA_LOCATION) !==
          lower(output.dataLocation)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.communicationServiceName ??
        olds?.name ??
        (yield* createCommunicationName(id));
      const observed = yield* getService(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* readKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed,
      );
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Communication");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.communicationServiceName ??
        (yield* createCommunicationName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        communicationServiceName: name,
      };
      const get = getService(subscriptionId, resourceGroup, name);
      const label = `communication service ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        const properties = propertyDelta(news, undefined);
        yield* communication.CommunicationServicesCreateOrUpdate({
          ...where,
          location: news.location ?? GLOBAL_LOCATION,
          tags,
          identity: identityDelta(news.identity, undefined),
          properties: {
            dataLocation: news.dataLocation ?? DEFAULT_DATA_LOCATION,
            ...properties,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (service) => service.properties?.provisioningState,
        WAIT,
      );

      // Sync mutable aspects against observed state; PATCH only deltas.
      const delta = propertyDelta(news, observed.properties);
      const identity = identityDelta(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        Object.keys(delta).length > 0 ||
        identity !== undefined ||
        tagsChanged
      ) {
        yield* communication.UpdateCommunicationService({
          ...where,
          properties: Object.keys(delta).length > 0 ? delta : undefined,
          identity,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (service) => {
            const state = service.properties?.provisioningState;
            if (state !== "Succeeded") return state;
            const pending =
              Object.keys(propertyDelta(news, service.properties)).length > 0 ||
              tagsDiffer(service.tags, tags);
            return pending ? "Updating" : state;
          },
          WAIT,
        );
      }

      const keys = yield* readKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed,
      );
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        communication.DeleteCommunicationService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          communicationServiceName: output.communicationServiceName,
        }),
      );
      yield* waitUntilGone(
        `communication service ${output.communicationServiceName}`,
        getService(
          subscriptionId,
          output.resourceGroup,
          output.communicationServiceName,
        ),
        { interval: "3 seconds", times: 100 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });

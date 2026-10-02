import * as relay from "@distilled.cloud/azure/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

export type RelayTlsVersion = relay.TlsVersion;

export interface NamespaceProps {
  /**
   * Resource group the namespace is created in. Changing it replaces the
   * namespace.
   */
  resourceGroup: string;
  /**
   * Globally unique namespace name (`<name>.servicebus.windows.net`): 6-50
   * letters, digits, and hyphens, starting with a letter and ending with a
   * letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the namespace.
   */
  name?: string;
  /**
   * Azure location of the namespace. Changing it replaces the namespace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Minimum TLS version accepted by the namespace endpoint.
   * @default "1.2"
   */
  minimumTlsVersion?: RelayTlsVersion;
  /**
   * Whether the public endpoint accepts traffic. Leave unset when a
   * `NetworkRuleSet` manages it.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled" | "SecuredByPerimeter";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Namespace extends Resource<
  "Azure.Relay.Namespace",
  NamespaceProps,
  {
    /** Name of the namespace. */
    namespaceName: string;
    /** ARM resource ID of the namespace; use it as a role-assignment scope. */
    namespaceId: string;
    /** Resource group that holds the namespace. */
    resourceGroup: string;
    /** Location of the namespace. */
    location: string;
    /** Pricing tier (always `Standard`). */
    sku: string;
    /** Endpoint, e.g. `https://<name>.servicebus.windows.net:443/`. */
    serviceBusEndpoint: string;
    /** Fully qualified host name, e.g. `<name>.servicebus.windows.net`. */
    hostName: string;
    /** Azure Monitor metric ID. */
    metricId: string | undefined;
    /** Namespace status (e.g. `Active`). */
    status: string | undefined;
    /** Minimum TLS version. */
    minimumTlsVersion: string | undefined;
    /** Whether the public endpoint accepts traffic. */
    publicNetworkAccess: string | undefined;
    /**
     * Primary connection string of the built-in
     * `RootManageSharedAccessKey` rule (full Manage rights).
     */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Relay namespace — the container for Hybrid Connections and WCF
 * relays, with its own `<name>.servicebus.windows.net` endpoint. Relay
 * exposes on-premises services to the cloud without opening inbound
 * firewall ports.
 *
 * Relay has a single `Standard` tier; an idle namespace with no listeners
 * costs next to nothing. The connection string of the built-in
 * `RootManageSharedAccessKey` rule is exposed as a secret; prefer
 * least-privilege authorization rules for applications.
 *
 * @see https://learn.microsoft.com/azure/azure-relay/relay-what-is-it
 *
 * ### Creating a Namespace
 * **Example:** Relay namespace
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const ns = yield* Azure.Relay.Namespace("relay", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Securing a Namespace
 * **Example:** TLS 1.3 only, tagged
 * ```typescript
 * const ns = yield* Azure.Relay.Namespace("relay", {
 *   resourceGroup: group.resourceGroupName,
 *   minimumTlsVersion: "1.3",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const Namespace = Resource<Namespace>("Azure.Relay.Namespace");

type ObservedNamespace = relay.GetNamespaceResponse | relay.RelayNamespace;

/** 6-50 chars, starts with a letter, ends with a letter or digit. */
const createNamespaceName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  }))
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-z]/.test(name) ? name : `relay-${name}`.slice(0, 50);
});

const getNamespace = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    relay.GetNamespace({ subscriptionId, resourceGroupName, namespaceName }),
  );

const ROOT_RULE = "RootManageSharedAccessKey";

const rootConnectionString = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    relay.ListNamespaceKeys({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      authorizationRuleName: ROOT_RULE,
    }),
  ).pipe(
    Effect.map((keys) =>
      keys?.primaryConnectionString === undefined
        ? undefined
        : Redacted.make(keys.primaryConnectionString),
    ),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedNamespace,
  primaryConnectionString: Redacted.Redacted<string> | undefined,
): Namespace["Attributes"] => {
  const endpoint = observed.properties?.serviceBusEndpoint ?? "";
  return {
    namespaceName: name,
    namespaceId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    sku: observed.sku?.name ?? "Standard",
    serviceBusEndpoint: endpoint,
    hostName:
      endpoint.match(/^https?:\/\/([^:/]+)/)?.[1] ??
      `${name}.servicebus.windows.net`,
    metricId: observed.properties?.metricId,
    status: observed.properties?.status,
    minimumTlsVersion: observed.properties?.minimumTlsVersion,
    publicNetworkAccess: observed.properties?.publicNetworkAccess,
    primaryConnectionString,
    tags: userTags(observed.tags),
  };
};

const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * ARM rejects a namespace write while a previous operation on it is still
 * running (`Conflict`); short waits converge.
 */
const whileBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: [
      "namespaceName",
      "namespaceId",
      "resourceGroup",
      "location",
      "serviceBusEndpoint",
      "hostName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* relay
        .ListNamespaces({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListNamespaces", page)),
        );
      return (page.value ?? []).flatMap((ns) => {
        const group = resourceGroupOf(ns.id);
        return hasAnyAlchemyTag(ns.tags) &&
          group !== undefined &&
          ns.name !== undefined
          ? [toAttrs(group, ns.name, ns, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.namespaceName)) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, ""))
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
        output?.namespaceName ?? olds?.name ?? (yield* createNamespaceName(id));
      const observed = yield* getNamespace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        yield* rootConnectionString(subscriptionId, resourceGroup, name),
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Relay");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.namespaceName ?? (yield* createNamespaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: name,
      };
      const get = getNamespace(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `relay namespace ${name}`,
        get,
        (ns) => ns.properties?.provisioningState,
        { interval: "5 seconds", times: 72 },
      );

      // Full PUT body: desired values where the user set them, the observed
      // value otherwise, so a PUT never resets settings owned by someone
      // else (e.g. `publicNetworkAccess` set by a NetworkRuleSet).
      const body = (observed: ObservedNamespace | undefined) =>
        ({
          ...where,
          location,
          tags,
          sku: { name: "Standard", tier: "Standard" },
          properties: {
            minimumTlsVersion: news.minimumTlsVersion ?? "1.2",
            publicNetworkAccess:
              news.publicNetworkAccess ??
              observed?.properties?.publicNetworkAccess,
          },
        }) satisfies relay.NamespacesCreateOrUpdateRequest;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* relay
          .NamespacesCreateOrUpdate(body(undefined))
          .pipe(Effect.retry(whileBusy));
      }
      observed = yield* waitReady;

      // Sync settings and tags against observed state.
      const props = observed.properties ?? {};
      const desired = body(observed);
      const changed =
        lower(props.minimumTlsVersion ?? "1.2") !==
          lower(desired.properties.minimumTlsVersion) ||
        (news.publicNetworkAccess !== undefined &&
          lower(props.publicNetworkAccess) !==
            lower(news.publicNetworkAccess)) ||
        tagsDiffer(observed.tags, tags);
      if (changed) {
        yield* relay
          .NamespacesCreateOrUpdate(desired)
          .pipe(Effect.retry(whileBusy));
        observed = yield* waitReady;
      }

      return toAttrs(
        resourceGroup,
        name,
        observed,
        yield* rootConnectionString(subscriptionId, resourceGroup, name),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        relay
          .DeleteNamespace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            namespaceName: output.namespaceName,
          })
          .pipe(Effect.retry(whileBusy)),
      );
      yield* waitUntilGone(
        `relay namespace ${output.namespaceName}`,
        getNamespace(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });

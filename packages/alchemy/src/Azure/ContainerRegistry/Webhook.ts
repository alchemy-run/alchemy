import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createRegistryName,
  getRegistry,
  normalizeLocation,
  sameName,
  sameSet,
} from "./Common.ts";

export type WebhookAction =
  | "push"
  | "delete"
  | "quarantine"
  | "chart_push"
  | "chart_delete";

export interface WebhookProps {
  /** Resource group of the registry. Changing it replaces the webhook. */
  resourceGroup: string;
  /** Registry that holds the webhook. Changing it replaces the webhook. */
  registry: string;
  /**
   * Webhook name: 5-50 letters and digits. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * webhook.
   */
  name?: string;
  /**
   * Location of the webhook; must be the registry's location or one of its
   * replication locations. Changing it replaces the webhook.
   * @default the registry's location
   */
  location?: string;
  /** Endpoint that receives the notifications (POST). */
  serviceUri: string | Redacted.Redacted<string>;
  /** Extra headers sent with each notification (e.g. an auth header). */
  customHeaders?: Record<string, string | Redacted.Redacted<string>>;
  /** Registry events that trigger a notification. */
  actions: WebhookAction[];
  /**
   * Repository scope, e.g. `app:*` (all tags of `app`) or `app:v1`. Empty
   * means all repositories.
   * @default ""
   */
  scope?: string;
  /**
   * Whether notifications are sent.
   * @default "enabled"
   */
  status?: "enabled" | "disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Webhook extends Resource<
  "Azure.ContainerRegistry.Webhook",
  WebhookProps,
  {
    /** Name of the webhook. */
    webhookName: string;
    /** ARM resource ID of the webhook. */
    webhookId: string;
    /** Registry that holds the webhook. */
    registry: string;
    /** Resource group of the registry. */
    resourceGroup: string;
    /** Location of the webhook. */
    location: string;
    /** Registry events that trigger a notification. */
    actions: string[];
    /** Repository scope. */
    scope: string;
    /** Whether notifications are sent. */
    status: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A container registry webhook — POSTs a notification to an HTTP endpoint
 * when images or charts are pushed, deleted, or quarantined.
 *
 * @see https://learn.microsoft.com/azure/container-registry/container-registry-webhook
 *
 * ### Creating a Webhook
 * **Example:** Notify on every push
 * ```typescript
 * const hook = yield* Azure.ContainerRegistry.Webhook("deploy-hook", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   serviceUri: "https://example.com/acr-hook",
 *   actions: ["push"],
 * });
 * ```
 *
 * **Example:** Scoped webhook with an auth header
 * ```typescript
 * const hook = yield* Azure.ContainerRegistry.Webhook("deploy-hook", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   serviceUri: "https://example.com/acr-hook",
 *   customHeaders: { Authorization: Redacted.make("Bearer secret") },
 *   actions: ["push", "delete"],
 *   scope: "app:*",
 * });
 * ```
 *
 * @resource
 */
export const Webhook = Resource<Webhook>("Azure.ContainerRegistry.Webhook");

const getWebhook = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  webhookName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetWebhook({
      subscriptionId,
      resourceGroupName,
      registryName,
      webhookName,
    }),
  );

const reveal = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const revealHeaders = (
  headers: Record<string, string | Redacted.Redacted<string>> | undefined,
) =>
  Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key, reveal(value)]),
  );

const sameHeaders = (
  observed: Record<string, string | undefined> | undefined,
  desired: Record<string, string>,
) => {
  const have = Object.entries(observed ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return (
    have.length === Object.keys(desired).length &&
    have.every(([key, value]) => desired[key] === value)
  );
};

const toAttrs = (
  resourceGroup: string,
  registry: string,
  name: string,
  webhook: containerregistry.GetWebhookResponse,
): Webhook["Attributes"] => ({
  webhookName: name,
  webhookId: webhook.id ?? "",
  registry,
  resourceGroup,
  location: webhook.location,
  actions: [...(webhook.properties?.actions ?? [])],
  scope: webhook.properties?.scope ?? "",
  status: webhook.properties?.status ?? "enabled",
  tags: userTags(webhook.tags),
});

export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: [
      "webhookName",
      "webhookId",
      "registry",
      "resourceGroup",
      "location",
    ],

    // Webhooks live inside a registry; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.registry, output.registry) ||
        (news.name !== undefined && !sameName(news.name, output.webhookName)) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !==
            normalizeLocation(output.location))
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && sameName(news.name, output.webhookName),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const registry = output?.registry ?? olds?.registry;
      if (resourceGroup === undefined || registry === undefined) {
        return undefined;
      }
      const name =
        output?.webhookName ?? olds?.name ?? (yield* createRegistryName(id));
      const observed = yield* getWebhook(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, registry, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");
      const { resourceGroup, registry } = news;
      const name =
        news.name ?? output?.webhookName ?? (yield* createRegistryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const serviceUri = reveal(news.serviceUri);
      const customHeaders = revealHeaders(news.customHeaders);
      const scope = news.scope ?? "";
      const status = news.status ?? "enabled";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: registry,
        webhookName: name,
      };
      const get = getWebhook(subscriptionId, resourceGroup, registry, name);
      const waitReady = waitForProvisioned(
        `webhook ${name}`,
        get,
        (webhook) => webhook.properties?.provisioningState,
        { interval: "2 seconds", times: 30 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The webhook must live in the registry's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getRegistry(subscriptionId, resourceGroup, registry))
            ?.location;
        yield* containerregistry.CreateWebhook({
          ...where,
          location: location ?? "",
          tags,
          properties: {
            serviceUri,
            customHeaders,
            actions: news.actions,
            scope,
            status,
          },
        });
        observed = yield* waitReady;
      } else {
        // Sync against the observed webhook; the endpoint and headers are
        // only readable through the callback config.
        const callback =
          yield* containerregistry.GetWebhookCallbackConfig(where);
        const props = observed.properties;
        const changed: containerregistry.WebhookPropertiesUpdateParameters = {};
        if (callback.serviceUri !== serviceUri) changed.serviceUri = serviceUri;
        if (!sameHeaders(callback.customHeaders, customHeaders)) {
          changed.customHeaders = customHeaders;
        }
        if (!sameSet(props?.actions, news.actions)) {
          changed.actions = news.actions;
        }
        if ((props?.scope ?? "") !== scope) changed.scope = scope;
        if ((props?.status ?? "enabled") !== status) changed.status = status;
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (Object.keys(changed).length > 0 || tagsChanged) {
          yield* containerregistry.UpdateWebhook({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          });
          observed = yield* waitReady;
        }
      }

      return toAttrs(resourceGroup, registry, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        containerregistry.DeleteWebhook({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registry,
          webhookName: output.webhookName,
        }),
      );
      yield* waitUntilGone(
        `webhook ${output.webhookName}`,
        getWebhook(
          subscriptionId,
          output.resourceGroup,
          output.registry,
          output.webhookName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerRegistry.Registry",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });

import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
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
import {
  createEntityName,
  matchesObserved,
  namespaceOwnedByStage,
} from "./Common.ts";

export type ApplicationGroupMetric =
  | "IncomingBytes"
  | "OutgoingBytes"
  | "IncomingMessages"
  | "OutgoingMessages";

/** A throttling policy that caps one metric of the application group. */
export interface ApplicationGroupThrottlingPolicy {
  /** Name of the policy, unique within the application group. */
  name: string;
  /** Per-second limit above which the application group is throttled. */
  rateLimitThreshold: number;
  /** Metric the limit applies to. */
  metricId: ApplicationGroupMetric;
}

export interface ApplicationGroupProps {
  /** Resource group of the namespace. Changing it replaces the application group. */
  resourceGroup: string;
  /** Namespace that hosts the application group. Changing it replaces the application group. */
  namespace: string;
  /**
   * Application group name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the application group.
   */
  name?: string;
  /**
   * Clients that belong to the group: `SASKeyName=<authorization rule>` or
   * `AADAppID=<application id>`. Changing it replaces the application group.
   */
  clientAppGroupIdentifier: string;
  /**
   * Whether clients of the group may connect. Disabling it drops every
   * existing connection of the group.
   * @default true
   */
  isEnabled?: boolean;
  /** Throttling policies applied to the group's clients. */
  policies?: ApplicationGroupThrottlingPolicy[];
}

export interface ApplicationGroup extends Resource<
  "Azure.EventHub.ApplicationGroup",
  ApplicationGroupProps,
  {
    /** Name of the application group. */
    applicationGroupName: string;
    /** ARM resource ID of the application group. */
    applicationGroupId: string;
    /** Namespace that hosts the application group. */
    namespace: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Client identifier (`SASKeyName=…` or `AADAppID=…`). */
    clientAppGroupIdentifier: string;
    /** Whether clients of the group may connect. */
    isEnabled: boolean;
    /** Policies observed on the group. */
    policies: eventhub.ApplicationGroupPolicy[];
  },
  never,
  Providers
> {}

/**
 * An Event Hubs application group — a set of client applications,
 * identified by a SAS rule or an Entra application ID, that share
 * resource-governance policies such as ingress/egress throttling.
 * Needs a `Premium` namespace or a namespace in a Dedicated cluster; Basic
 * and Standard namespaces reject application groups with
 * `EventHubApplicationGroupNotSupported`.
 *
 * Application groups have no tags; Alchemy treats a group as owned when
 * its namespace carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/resource-governance-overview
 *
 * ### Creating an Application Group
 * **Example:** Group the clients of a SAS rule
 * ```typescript
 * const rule = yield* Azure.EventHub.NamespaceAuthorizationRule("Producers", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   rights: ["Send"],
 * });
 * const producers = yield* Azure.EventHub.ApplicationGroup("producers", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   clientAppGroupIdentifier: Output.interpolate`SASKeyName=${rule.authorizationRuleName}`,
 * });
 * ```
 *
 * ### Throttling
 * **Example:** Cap incoming messages per second
 * ```typescript
 * const producers = yield* Azure.EventHub.ApplicationGroup("producers", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   clientAppGroupIdentifier: "AADAppID=00000000-0000-0000-0000-000000000000",
 *   policies: [
 *     {
 *       name: "ingress-cap",
 *       metricId: "IncomingMessages",
 *       rateLimitThreshold: 1000,
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Temporarily disconnect the group
 * ```typescript
 * const producers = yield* Azure.EventHub.ApplicationGroup("producers", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   clientAppGroupIdentifier: "SASKeyName=producers",
 *   isEnabled: false,
 * });
 * ```
 *
 * @resource
 */
export const ApplicationGroup = Resource<ApplicationGroup>(
  "Azure.EventHub.ApplicationGroup",
);

const getApplicationGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  applicationGroupName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetApplicationGroup({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      applicationGroupName,
    }),
  ).pipe(
    // A Basic/Standard namespace cannot hold application groups at all.
    Effect.catchTag("EventHubApplicationGroupNotSupported", () =>
      Effect.succeed(undefined),
    ),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  group: eventhub.GetApplicationGroupResponse,
): ApplicationGroup["Attributes"] => ({
  applicationGroupName: name,
  applicationGroupId: group.id ?? "",
  namespace,
  resourceGroup,
  clientAppGroupIdentifier: group.properties?.clientAppGroupIdentifier ?? "",
  isEnabled: group.properties?.isEnabled ?? true,
  policies: group.properties?.policies ?? [],
});

const toPolicies = (policies: ApplicationGroupThrottlingPolicy[]) =>
  policies.map((policy) => ({
    name: policy.name,
    type: "ThrottlingPolicy" as const,
    rateLimitThreshold: policy.rateLimitThreshold,
    metricId: policy.metricId,
  }));

export const ApplicationGroupProvider = () =>
  Provider.succeed(ApplicationGroup, {
    stables: [
      "applicationGroupName",
      "applicationGroupId",
      "namespace",
      "resourceGroup",
      "clientAppGroupIdentifier",
    ],

    // Application groups live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.applicationGroupName.toLowerCase()) ||
        news.clientAppGroupIdentifier.toLowerCase() !==
          output.clientAppGroupIdentifier.toLowerCase()
      ) {
        // A namespace accepts one application group per client identifier,
        // so the old group must go before its replacement is created.
        return { action: "replace", deleteFirst: true } as const;
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
        output?.applicationGroupName ??
        olds?.name ??
        (yield* createEntityName(id, 50));
      const observed = yield* getApplicationGroup(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      return (yield* namespaceOwnedByStage(
        subscriptionId,
        resourceGroup,
        namespace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace } = news;
      const name =
        news.name ??
        output?.applicationGroupName ??
        (yield* createEntityName(id, 50));
      const desired = {
        clientAppGroupIdentifier: news.clientAppGroupIdentifier,
        isEnabled: news.isEnabled ?? true,
        policies: toPolicies(news.policies ?? []),
      };
      const get = getApplicationGroup(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a synchronous full upsert, skipped when
      // the observed group already matches.
      if (
        observed?.properties === undefined ||
        !matchesObserved(
          { isEnabled: desired.isEnabled, policies: desired.policies },
          {
            isEnabled: observed.properties.isEnabled ?? true,
            policies: observed.properties.policies ?? [],
          },
        )
      ) {
        yield* eventhub.ApplicationGroupCreateOrUpdateApplicationGroup({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          applicationGroupName: name,
          properties: {
            clientAppGroupIdentifier:
              observed?.properties?.clientAppGroupIdentifier ??
              desired.clientAppGroupIdentifier,
            isEnabled: desired.isEnabled,
            policies: desired.policies,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `application group ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, namespace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventhub.DeleteApplicationGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          applicationGroupName: output.applicationGroupName,
        }),
      ).pipe(
        // The namespace tier cannot hold application groups: nothing exists.
        Effect.catchTag(
          "EventHubApplicationGroupNotSupported",
          () => Effect.void,
        ),
      );
      yield* waitUntilGone(
        `application group ${output.applicationGroupName}`,
        getApplicationGroup(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.applicationGroupName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.EventHub.Namespace", "Azure.Resources.ResourceGroup"],
    },
  });

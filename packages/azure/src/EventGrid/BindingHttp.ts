import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import { TopicEndpointMissing } from "./DataPlaneTypes.ts";
import type { NamespaceTopic } from "./NamespaceTopic.ts";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";
import type { Topic } from "./Topic.ts";

/**
 * Shared scaffolding for the Event Grid data-plane bindings: resolves the
 * distilled `eventgrid-data` / `eventgrid-namespace` operation once when the
 * layer is built, injects the bound topic's or subscription's identifiers,
 * and assigns the binding's role on that resource at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** Event Grid data actions (Azure RBAC). */
export const EventGridDataAction = {
  send: "Microsoft.EventGrid/events/send/action",
  receive: "Microsoft.EventGrid/events/receive/action",
} as const;

/**
 * A role an Event Grid binding assigns: a built-in role GUID, or a custom
 * role (`Azure.Authorization.RoleDefinition`, defined once per stack at the
 * subscription and assigned only on the bound resource) with exactly
 * `dataActions`.
 */
export type EventGridGrant =
  | { readonly builtIn: string }
  | { readonly role: string; readonly dataActions: readonly string[] };

export const EventGridRole = {
  /** **EventGrid Data Sender**: its only data action is `events/send/action`. */
  Send: { builtIn: BuiltInRole.EventGridDataSender },
  /** Custom `AzureEventGridReceiveRole`: exactly `events/receive/action`. */
  Receive: { role: "Receive", dataActions: [EventGridDataAction.receive] },
} as const satisfies Record<string, EventGridGrant>;

type Bound = Topic | NamespaceTopic | NamespaceTopicEventSubscription;

/** Assign `grants` on `scope` to the host, creating the custom roles they name. */
const GrantEventGridRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: Bound,
    scope: Output.Output<string, never>,
    grants: readonly EventGridGrant[],
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        if ("builtIn" in grant) {
          roleAssignments.push({ roleDefinitionId: grant.builtIn, scope });
          continue;
        }
        const role = yield* AzureRoleDefinition(`AzureEventGrid${grant.role}Role`, {
          description: `Alchemy Event Grid binding: ${grant.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...grant.dataActions] }],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope });
      }
      yield* bind`${tag}(${resource})`({ roleAssignments });
    }
  });
});

/** `topic1.westus2-1.eventgrid.azure.net` from `https://topic1.westus2-1.eventgrid.azure.net/api/events`. */
const hostOf = (endpoint: string) => endpoint.replace(/^https?:\/\//, "").split("/")[0] ?? "";

/**
 * Build the impl Effect for a custom-topic operation whose request carries
 * `topicHostname` (`PublishEventGridEvents`, `PublishCloudEventEvents`,
 * `PublishCustomEventEvents`): the runtime callable injects the bound
 * {@link Topic}'s hostname, and the deploy-time half assigns `grants` on the
 * topic.
 */
export const makeTopicHttpBinding = <I extends { topicHostname: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.EventGrid.PublishEventGridEvents`. */
  tag: string;
  /** The distilled operation; the topic hostname is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the topic. */
  grants: readonly EventGridGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantEventGridRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (topic: Topic) {
      yield* grant(options.tag, topic, topic.topicId, options.grants);
      const endpoint = yield* topic.endpoint;
      const topicName = yield* topic.topicName;
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (
        request: Omit<I, "topicHostname">,
      ) {
        const url = yield* endpoint;
        if (url === undefined || url === "") {
          const name = yield* topicName;
          return yield* new TopicEndpointMissing({
            topicName: name,
            message: `Event Grid topic ${name} has no publish endpoint`,
          });
        }
        return yield* op({ ...request, topicHostname: hostOf(url) } as I);
      });
    });
  });

/**
 * Build the impl Effect for a namespace-topic operation whose request
 * carries `endpoint` + `topicName` (`PublishCloudEvent`,
 * `PublishCloudEvents`): the runtime callable injects the bound
 * {@link NamespaceTopic}'s namespace endpoint and name, and the deploy-time
 * half assigns `grants` on the namespace topic.
 */
export const makeNamespaceTopicHttpBinding = <
  I extends { endpoint: string; topicName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.EventGrid.PublishCloudEvents`. */
  tag: string;
  /** The distilled operation; the namespace endpoint and topic name are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the namespace topic. */
  grants: readonly EventGridGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantEventGridRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (topic: NamespaceTopic) {
      yield* grant(options.tag, topic, topic.namespaceTopicId, options.grants);
      const endpoint = yield* Output.interpolate`https://${topic.topicsHostname}`;
      const topicName = yield* topic.namespaceTopicName;
      const at = Effect.all({ endpoint, topicName });
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (
        request: Omit<I, "endpoint" | "topicName">,
      ) {
        const where = yield* at;
        return yield* op({ ...request, ...where } as I);
      });
    });
  });

/**
 * Build the impl Effect for a pull-subscription operation whose request
 * carries `endpoint` + `topicName` + `eventSubscriptionName`
 * (`ReceiveCloudEvents`, `AcknowledgeCloudEvents`, `ReleaseCloudEvents`,
 * `RejectCloudEvents`, `RenewCloudEventLocks`): the runtime callable injects
 * the bound {@link NamespaceTopicEventSubscription}'s identifiers, and the
 * deploy-time half assigns `grants` on the subscription.
 */
export const makeSubscriptionHttpBinding = <
  I extends { endpoint: string; topicName: string; eventSubscriptionName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.EventGrid.ReceiveCloudEvents`. */
  tag: string;
  /** The distilled operation; the subscription's identifiers are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the event subscription. */
  grants: readonly EventGridGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantEventGridRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (subscription: NamespaceTopicEventSubscription) {
      yield* grant(options.tag, subscription, subscription.eventSubscriptionId, options.grants);
      const endpoint = yield* Output.interpolate`https://${subscription.topicsHostname}`;
      const topicName = yield* subscription.topic;
      const eventSubscriptionName = yield* subscription.eventSubscriptionName;
      const at = Effect.all({ endpoint, topicName, eventSubscriptionName });
      return Effect.fn(`${options.tag}(${subscription.LogicalId})`)(function* (
        request?: Omit<I, "endpoint" | "topicName" | "eventSubscriptionName">,
      ) {
        const where = yield* at;
        return yield* op({ ...request, ...where } as I);
      });
    });
  });

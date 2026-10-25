import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Hub } from "./Hub.ts";
import type { WebPubSub } from "./WebPubSub.ts";

/**
 * Shared scaffolding for the Web PubSub hub bindings: resolves the distilled
 * `webpubsub-data` operation once when the layer is built, fills in the
 * bound hub's endpoint and name on each call, and assigns the binding's
 * role on the hub's Web PubSub service at deploy time.
 *
 * Web PubSub checks data-plane roles on the service, not on a hub, so the
 * service is the narrowest scope a grant can have.
 *
 * NOT exported from `index.ts`.
 */

/** Web PubSub data actions (Azure RBAC). */
export const WebPubSubDataAction = {
  hubSend: "Microsoft.SignalRService/WebPubSub/hub/send/action",
  groupSend: "Microsoft.SignalRService/WebPubSub/group/send/action",
  groupRead: "Microsoft.SignalRService/WebPubSub/group/read",
  groupWrite: "Microsoft.SignalRService/WebPubSub/group/write",
  userSend: "Microsoft.SignalRService/WebPubSub/user/send/action",
  userRead: "Microsoft.SignalRService/WebPubSub/user/read",
  connectionSend: "Microsoft.SignalRService/WebPubSub/clientConnection/send/action",
  connectionRead: "Microsoft.SignalRService/WebPubSub/clientConnection/read",
  connectionWrite: "Microsoft.SignalRService/WebPubSub/clientConnection/write",
  generateToken: "Microsoft.SignalRService/WebPubSub/clientConnection/generateToken/action",
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound hub's service)
 * with exactly `dataActions`. The built-in roles are broader: **Web PubSub
 * Service Owner** grants `WebPubSub/*` and **Web PubSub Service Reader**
 * every `read`.
 */
export interface WebPubSubGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

/** Custom role per data action; the logical ID is `AzureWebPubSub<role>Role`. */
export const WebPubSubRole = {
  HubSend: { role: "HubSend", dataActions: [WebPubSubDataAction.hubSend] },
  GroupSend: { role: "GroupSend", dataActions: [WebPubSubDataAction.groupSend] },
  GroupRead: { role: "GroupRead", dataActions: [WebPubSubDataAction.groupRead] },
  GroupWrite: { role: "GroupWrite", dataActions: [WebPubSubDataAction.groupWrite] },
  UserSend: { role: "UserSend", dataActions: [WebPubSubDataAction.userSend] },
  UserRead: { role: "UserRead", dataActions: [WebPubSubDataAction.userRead] },
  ConnectionSend: { role: "ConnectionSend", dataActions: [WebPubSubDataAction.connectionSend] },
  ConnectionRead: { role: "ConnectionRead", dataActions: [WebPubSubDataAction.connectionRead] },
  ConnectionWrite: { role: "ConnectionWrite", dataActions: [WebPubSubDataAction.connectionWrite] },
  GenerateToken: { role: "GenerateToken", dataActions: [WebPubSubDataAction.generateToken] },
} as const satisfies Record<string, WebPubSubGrant>;

/** The request members the bound hub supplies. */
export type HubIds = "endpoint" | "hub";

/** ARM ID of the Web PubSub service that owns a hub (`…/webPubSub/{name}`). */
const serviceIdOf = (hubId: string) => hubId.replace(/\/hubs\/[^/]+$/i, "");

/** Assign `grants` on `scope` to the host, creating the custom roles they name. */
const GrantWebPubSubRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: Hub | WebPubSub,
    scope: Input<string>,
    grants: readonly WebPubSubGrant[],
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        const role = yield* AzureRoleDefinition(`AzureWebPubSub${grant.role}Role`, {
          description: `Alchemy Web PubSub binding: ${grant.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...grant.dataActions] }],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope });
      }
      yield* bind`${tag}(${resource})`({ roleAssignments });
    }
  });
});

/** Where a hub lives, resolved per call at runtime. */
interface HubAddress {
  readonly endpoint: Effect.Effect<string>;
  readonly hub: Effect.Effect<string>;
}

const hubAddressOf = Effect.fn(function* (hub: Hub) {
  const endpoint = yield* Output.interpolate`https://${hub.webPubSub}.webpubsub.azure.com`;
  const hubName = yield* hub.hubName;
  return { endpoint, hub: hubName } satisfies HubAddress;
});

/** A hub's endpoint and name, read per call at runtime. */
export type HubAt = Effect.Effect<Record<HubIds, string>>;

/**
 * Build a hub binding: assigns `grant` on the hub's service at deploy and
 * returns the client `makeClient` builds over the hub's address.
 */
export const makeHubBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.WebPubSub.ListConnectionsInGroup`. */
  tag: string;
  /** Role assigned on the hub's service. */
  grant: WebPubSubGrant;
  /** Resolved once when the layer is built. */
  makeClient: Effect.Effect<(name: string, at: HubAt) => Client>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantWebPubSubRoles;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (hub: Hub) {
      yield* grant(options.tag, hub, Output.map(hub.hubId, serviceIdOf), [options.grant]);
      const address = yield* hubAddressOf(hub);
      return makeClient(
        `${options.tag}(${hub.LogicalId})`,
        Effect.all({ endpoint: address.endpoint, hub: address.hub }),
      );
    });
  });

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/**
 * Build a per-operation hub binding: assigns `grant` on the hub's service at
 * deploy and returns `operation` with the hub's endpoint and name filled in.
 * `finish` maps the operation's result (the existence checks answer
 * `boolean`).
 */
export const makeHubOperationBinding = <
  I extends Record<HubIds, string>,
  A,
  E,
  B = A,
  E2 = E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.WebPubSub.SendToAll`. */
  tag: string;
  /** The distilled `webpubsub-data` operation; the endpoint and hub are injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Role assigned on the hub's service. */
  grant: WebPubSubGrant;
  finish?: (result: Effect.Effect<A, E>) => Effect.Effect<B, E2>;
}) =>
  makeHubBinding({
    tag: options.tag,
    grant: options.grant,
    makeClient: Effect.gen(function* () {
      const op = yield* AzureBindings.withCredentials(options.operation);
      const finish =
        options.finish ??
        // Without `finish`, `B = A` and `E2 = E`; TypeScript cannot narrow the defaults.
        ((result: Effect.Effect<A, E>) => result as unknown as Effect.Effect<B, E2>);
      return (name: string, at: HubAt) =>
        Effect.fn(name)(function* (request?: Omit<I, HubIds>) {
          const where = yield* at;
          // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
          return yield* finish(op({ ...request, ...where } as I));
        });
    }),
  });

/**
 * Build a service-level binding (`GetServiceStatus`): no role (the health
 * check needs none) and the service's endpoint filled in.
 */
export const makeServiceOperationBinding = <A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.WebPubSub.GetServiceStatus`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<Operation<{ endpoint: string }, A, E>, never, any>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantWebPubSubRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (service: WebPubSub) {
      yield* grant(options.tag, service, service.webPubSubId, []);
      const endpoint = yield* service.endpoint;
      return Effect.fn(`${options.tag}(${service.LogicalId})`)(function* () {
        const url = yield* endpoint;
        return yield* op({ endpoint: url });
      });
    });
  });

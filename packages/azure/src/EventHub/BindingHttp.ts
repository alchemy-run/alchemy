import * as Effect from "effect/Effect";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { EventHub } from "./EventHub.ts";

/**
 * Shared scaffolding for the Event Hubs send bindings: assigns **Azure
 * Event Hubs Data Sender** on the bound event hub at deploy time and fills
 * in the hub's namespace and name on each distilled `eventhubs-messaging`
 * call at runtime.
 *
 * NOT exported from `index.ts`.
 */

/** The request members the bound event hub supplies. */
export type EventHubIds = "namespaceName" | "eventHubName";

/** Where an event hub lives, resolved per call at runtime. */
export interface EventHubAddress {
  readonly namespaceName: Effect.Effect<string>;
  readonly eventHubName: Effect.Effect<string>;
}

/**
 * Attach the binding `tag` to its host with **Azure Event Hubs Data Sender**
 * on the event hub only. The role's only data action is `send` (plus the
 * control-plane `eventhubs/read`), so every send binding uses it.
 */
export const GrantOnEventHub = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  return Effect.fn(function* (tag: string, hub: EventHub) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* bind`${tag}(${hub})`({
        roleAssignments: [
          { roleDefinitionId: BuiltInRole.EventHubsDataSender, scope: hub.eventHubId },
        ],
      });
    }
  });
});

export const eventHubAddressOf = Effect.fn(function* (hub: EventHub) {
  const namespaceName = yield* hub.namespace;
  const eventHubName = yield* hub.eventHubName;
  return { namespaceName, eventHubName } satisfies EventHubAddress;
});

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/** Call `op` on the event hub at `address`, adding its namespace and name. */
export const onEventHub = <I, A, E>(
  name: string,
  op: Operation<I, A, E>,
  address: EventHubAddress,
) =>
  Effect.fn(name)(function* (request: Omit<I, EventHubIds>) {
    const namespaceName = yield* address.namespaceName;
    const eventHubName = yield* address.eventHubName;
    // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
    return yield* op({ ...request, namespaceName, eventHubName } as I);
  });

/**
 * Build a per-operation binding: assigns Data Sender on the event hub at
 * deploy and returns `operation` with the hub's namespace and name filled in.
 */
export const makeEventHubOperationBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.EventHub.SendEvent`. */
  tag: string;
  /** The distilled `eventhubs-messaging` operation. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
}) =>
  Effect.gen(function* () {
    const grantOnEventHub = yield* GrantOnEventHub;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (hub: EventHub) {
      yield* grantOnEventHub(options.tag, hub);
      const address = yield* eventHubAddressOf(hub);
      return onEventHub(`${options.tag}(${hub.LogicalId})`, op, address);
    });
  });

import * as Effect from "effect/Effect";
import { stackAndStage, waitForProvisioned } from "../Arm.ts";

/**
 * MQTT broker children (clients, client groups, topic spaces, permission
 * bindings, CA certificates) have no tags. Alchemy appends an ownership
 * marker ` [alchemy:{stack}/{stage}/{id}]` to their `description`.
 */
const MARKER = /\s*\[alchemy:[^\]]*\]$/;

const marker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `[alchemy:${stack}/${stage}/${id}]`;
});

/** Description sent to Azure: the user's description plus the marker. */
export const markedDescription = Effect.fn(function* (
  id: string,
  description: string | undefined,
) {
  const tag = yield* marker(id);
  return description ? `${description} ${tag}` : tag;
});

/** The user's description (marker stripped). */
export const userDescription = (description: string | undefined) => {
  const stripped = (description ?? "").replace(MARKER, "");
  return stripped === "" ? undefined : stripped;
};

/** Whether an observed description carries this resource's marker. */
export const isOwnedDescription = Effect.fn(function* (
  id: string,
  description: string | undefined,
) {
  const tag = yield* marker(id);
  return (description ?? "").endsWith(tag);
});

/**
 * Observe → ensure → sync for a namespace child that only supports a full
 * PUT: create when missing, re-PUT when any observed property differs,
 * and block until `provisioningState` is `Succeeded`.
 */
export const reconcileChild = <
  A extends { properties?: { provisioningState?: string } },
  E,
  R,
  E2,
  R2,
>(options: {
  readonly label: string;
  readonly get: Effect.Effect<A | undefined, E, R>;
  readonly put: Effect.Effect<unknown, E2, R2>;
  readonly differs: (observed: A) => boolean;
}) =>
  Effect.gen(function* () {
    const stateOf = (value: A) => value.properties?.provisioningState;

    // Observe.
    const observed = yield* options.get;

    // Ensure, then sync: the PUT replaces every property, so it is only
    // sent when the resource is missing or an observed property differs.
    if (observed === undefined || options.differs(observed)) {
      yield* options.put;
    }
    return yield* waitForProvisioned(options.label, options.get, stateOf, {
      times: 60,
    });
  });

/** Whether `want` is set and differs from `have` (structural). */
export const changed = <T>(want: T | undefined, have: T | undefined) =>
  want !== undefined && JSON.stringify(want) !== JSON.stringify(have);

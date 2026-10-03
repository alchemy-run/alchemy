import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  descriptionWithMarker,
  descriptionWithoutMarker,
  MARKER,
  ownershipMarker,
} from "../Authorization/Ownership.ts";

/**
 * Storage Mover child resources (projects, endpoints, job definitions,
 * connections) have no tags, so ownership is recorded as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of the description.
 */
export const describe = Effect.fn(function* (
  id: string,
  description: string | undefined,
) {
  return descriptionWithMarker(description, yield* ownershipMarker(id));
});

/** Whether the observed description carries this resource's marker. */
export const isOwnedByDescription = Effect.fn(function* (
  id: string,
  description: string | undefined,
) {
  return (description ?? "").endsWith(yield* ownershipMarker(id));
});

/** Whether the description carries any Alchemy marker (used by `list`). */
export const hasAnyMarker = (description: string | undefined) =>
  MARKER.test(description ?? "");

/** The user's description (ownership marker stripped). */
export const userDescription = descriptionWithoutMarker;

/**
 * Name for a Storage Mover resource: letters, digits, `-` and `_`, starting
 * with a letter or digit, at most `maxLength` characters.
 */
export const createMoverName = Effect.fn(function* (
  id: string,
  maxLength = 64,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    suffixLength: maxLength < 32 ? 8 : 16,
  });
  return name.replace(/^[^A-Za-z0-9]+/, "");
});

/** Polling budget for Storage Mover deletes (202 + poll until 404). */
export const DELETE_BUDGET = { interval: "5 seconds", times: 60 } as const;

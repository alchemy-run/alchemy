import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { stackAndStage } from "../Arm.ts";

/**
 * Authorization resources have no tags, so ownership is recorded as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of the description.
 */
export const MARKER = /\s*\[alchemy ([^\]]+)\]$/;

export const ownershipMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `[alchemy ${stack}/${stage}/${id}]`;
});

export const descriptionWithMarker = (
  description: string | undefined,
  marker: string,
) => (description ? `${description} ${marker}` : marker);

/** Strip the ownership marker, returning the user's description. */
export const descriptionWithoutMarker = (description: string | undefined) => {
  const stripped = (description ?? "").replace(MARKER, "");
  return stripped === "" ? undefined : stripped;
};

/** Deterministic RFC 4122 GUID from the stack, stage, logical ID and instance ID. */
export const deterministicGuid = Effect.fn(function* (
  id: string,
  instanceId: string,
) {
  const { stack, stage } = yield* stackAndStage;
  const hex = yield* Effect.sync(() =>
    createHash("sha256")
      .update(`${stack}/${stage}/${id}/${instanceId}`)
      .digest("hex"),
  );
  // Version 4 / variant bits so ARM accepts it.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
});

export const normalizeScope = (scope: string) =>
  `/${scope.replace(/^\/+|\/+$/g, "")}`.toLowerCase();

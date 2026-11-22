import { createHash } from "node:crypto";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import { stackAndStage } from "../Arm.ts";

/*
 * Shared, un-exported helpers for the Azure Sphere resources. Not
 * re-exported from `index.ts`.
 */

/**
 * `[alchemy <hash>]` — ownership marker for entities without tags. The hash
 * (first 12 hex digits of sha256 of `<stack>/<stage>/<id>`) keeps the
 * marker short: Azure Sphere descriptions hold at most 100 characters.
 */
export const ownershipMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  const hash = yield* Effect.sync(() =>
    createHash("sha256").update(`${stack}/${stage}/${id}`).digest("hex").slice(0, 12),
  );
  return `[alchemy ${hash}]`;
});

const MARKER = /\s*\[alchemy [^\]]+\]$/;

/** Description with the ownership marker appended. */
export const descriptionWithMarker = (description: string | undefined, marker: string) =>
  description ? `${description} ${marker}` : marker;

/** Description with any ownership marker stripped. */
export const stripMarker = (description: string | undefined) => {
  const stripped = (description ?? "").replace(MARKER, "");
  return stripped === "" ? undefined : stripped;
};

/** Whether the observed description ends with this stack/stage/id's marker. */
export const hasMarker = Effect.fn(function* (id: string, description: string | undefined) {
  return (description ?? "").endsWith(yield* ownershipMarker(id));
});

/** Catalog name: 1-29 letters, digits, `-`, and `_`. */
export const createCatalogName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 29 });
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
});

/**
 * Product and device group name: 3-50 letters, digits, and spaces. Generated
 * names are alphanumeric only.
 */
export const createAlphanumericName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 50, delimiter: "" });
  return name.replace(/[^A-Za-z0-9]/g, "");
});

export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

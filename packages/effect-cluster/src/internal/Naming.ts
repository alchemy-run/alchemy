/**
 * Names every pool Layer shares, kept apart from the bundling in
 * `PoolHost.ts` so a runtime that bundles a pool Layer (a Worker) never
 * pulls in the bundler.
 *
 * @internal
 */
import { createHash } from "node:crypto";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { EntityTypeId } from "../Entity.ts";

/** The resource types a pool hosts. */
export const HOSTED_TYPES = new Set<string>([
  EntityTypeId,
  "Cluster.Workflow",
  "Cluster.Singleton",
  "Cluster.Cron",
]);

/** `label` as a lowercase name of at most `max` characters, ending in a hash when shortened. */
const shorten = Effect.fn(function* (label: string, max: number) {
  const clean = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (clean.length <= max) return clean;
  const hash = yield* Effect.sync(() =>
    createHash("sha256").update(clean).digest("hex").slice(0, 8),
  );
  return `${clean.slice(0, max - 9).replace(/-+$/, "")}-${hash}`;
});

/**
 * `${stack}-${stage}-${id}` as a lowercase DNS label of at most `max`
 * characters. A longer one keeps its start and ends in a hash of the whole.
 */
export const stackDnsLabel = Effect.fn(function* (id: string, max = 63) {
  const stack = yield* Stack;
  return yield* shorten(`${stack.name}-${stack.stage}-${id}`, max);
});

/** `id` as a lowercase label of at most `max` characters, ending in a hash when shortened. */
export const shortLabel = (id: string, max: number) => shorten(id, max);

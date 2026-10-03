import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

/**
 * Deterministic name for a file share or snapshot: 3-63 lowercase letters,
 * digits, and single hyphens, starting and ending with a letter or digit.
 */
export const createFileShareName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

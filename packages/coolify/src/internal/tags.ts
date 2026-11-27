import * as Effect from "effect/Effect";

/**
 * Converge a resource's Coolify tags on `desired`, diffing against the tags
 * Coolify reports (never against state). Coolify lowercases tag names.
 *
 * Tags are user data here, not ownership markers: see `naming.ts` for why
 * Alchemy does not stamp its own tags on Coolify resources.
 */
export const syncTags = <E1, E2, E3, R1, R2, R3>(ops: {
  readonly list: () => Effect.Effect<ReadonlyArray<{ uuid?: string; name?: string }>, E1, R1>;
  readonly add: (names: string[]) => Effect.Effect<unknown, E2, R2>;
  readonly remove: (tagUuid: string) => Effect.Effect<unknown, E3, R3>;
  readonly desired: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const desired = new Set(ops.desired.map((name) => name.toLowerCase()));
    const observed = yield* ops.list();
    const observedNames = new Set(observed.map((tag) => tag.name ?? ""));
    const missing = [...desired].filter((name) => !observedNames.has(name));
    if (missing.length > 0) yield* ops.add(missing);
    for (const tag of observed) {
      if (tag.uuid && tag.name && !desired.has(tag.name)) yield* ops.remove(tag.uuid);
    }
  });

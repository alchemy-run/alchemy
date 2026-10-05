import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class InvalidChaosResourceId extends Data.TaggedError(
  "Azure.Chaos.InvalidResourceId",
)<{
  readonly resourceId: string;
  readonly message: string;
}> {}

/** Path parameters of a Chaos target (an extension resource on a parent). */
export interface TargetPath {
  readonly resourceGroupName: string;
  readonly parentProviderNamespace: string;
  readonly parentResourceType: string;
  readonly parentResourceName: string;
}

const PARENT =
  /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)\/providers\/([^/]+)\/([^/]+)\/([^/]+)$/i;

const TARGET =
  /^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/[^/]+\/[^/]+\/[^/]+)\/providers\/Microsoft\.Chaos\/targets\/([^/]+)$/i;

/**
 * Split a top-level ARM resource ID (`/subscriptions/{sub}/resourceGroups/{rg}/providers/{ns}/{type}/{name}`)
 * into the Chaos target path parameters.
 */
export const parseParentId = (
  resourceId: string,
): Effect.Effect<TargetPath, InvalidChaosResourceId> => {
  const match = resourceId.replace(/\/+$/, "").match(PARENT);
  return match
    ? Effect.succeed<TargetPath>({
        resourceGroupName: match[1]!,
        parentProviderNamespace: match[2]!,
        parentResourceType: match[3]!,
        parentResourceName: match[4]!,
      })
    : Effect.fail(
        new InvalidChaosResourceId({
          resourceId,
          message: `'${resourceId}' is not a top-level ARM resource ID (/subscriptions/{sub}/resourceGroups/{rg}/providers/{namespace}/{type}/{name})`,
        }),
      );
};

/** Split a Chaos target ID into its parent path and target name. */
export const parseTargetId = (
  targetId: string,
): Effect.Effect<
  TargetPath & { readonly parentResourceId: string; readonly targetName: string },
  InvalidChaosResourceId
> => {
  const match = targetId.replace(/\/+$/, "").match(TARGET);
  if (match === null) {
    return Effect.fail(
      new InvalidChaosResourceId({
        resourceId: targetId,
        message: `'${targetId}' is not a Chaos target ID ({parentResourceId}/providers/Microsoft.Chaos/targets/{name})`,
      }),
    );
  }
  return parseParentId(match[1]!).pipe(
    Effect.map((path) => ({
      ...path,
      parentResourceId: match[1]!,
      targetName: match[2]!,
    })),
  );
};

/** Canonical JSON (sorted keys, `undefined` dropped) for structural compares. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, inner]) => inner !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );

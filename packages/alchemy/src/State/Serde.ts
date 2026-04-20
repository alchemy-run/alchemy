import { isResource } from "../Resource.ts";
import type { ResourceState } from "./ResourceState.ts";

/**
 * Flattens ResourceLike refs to `{ id, type, props, attr }` for a
 * cycle-safe, interoperable wire shape across StateService backends.
 */
export const serializeResourceState = <V extends ResourceState>(
  value: V,
): string =>
  JSON.stringify(
    value,
    (_, v) => {
      if (isResource(v)) {
        return {
          id: v.LogicalId,
          type: v.Type,
          props: v.Props,
          attr: v.Attributes,
        };
      }
      return v;
    },
    2,
  );

/** Paired with serialize so backends stay in lockstep on wire changes. */
export const deserializeResourceState = <
  V extends ResourceState = ResourceState,
>(
  raw: string,
): V => JSON.parse(raw) as V;

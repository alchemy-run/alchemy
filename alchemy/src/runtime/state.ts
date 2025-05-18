import type { Resource } from "../resource.js";
import { Scope } from "../scope.js";
import type { Serialized } from "../serde.js";

export interface RuntimeState {
  get(id: string): Resource;
}

/**
 * Runtime state injected into the environment.
 */
export const STATE = {
  get(id: string): Resource {
    if (typeof __ALCHEMY_SERIALIZED_SCOPE__ === "undefined") {
      throw new Error("__ALCHEMY_SERIALIZED_SCOPE__ scope not found.");
    }
    const state: Serialized<Resource> =
      __ALCHEMY_SERIALIZED_SCOPE__[Scope.current.fqn(id)];
    if (!state) {
      throw new Error(
        `Resource ${id} not found in __ALCHEMY_SERIALIZED_SCOPE__`,
      );
    }
    // TODO: deserialize
    return state;
  },
};

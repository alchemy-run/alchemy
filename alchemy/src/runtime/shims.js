import { env } from "cloudflare:workers";
import { Scope } from "../scope.js";
import { Secret } from "../secret.js";
import { deserialize } from "../serde.js";

globalThis.process.env = env;

export const __ALCHEMY_RUNTIME__ = true;

export var __ALCHEMY_SERIALIZED_SCOPE__ = JSON.parse(
  env.__ALCHEMY_SERIALIZED_SCOPE__,
);

export const STATE = {
  async get(id) {
    const fqn = globalThis.__ALCHEMY_SCOPE__.current.fqn(id);
    const state = __ALCHEMY_SERIALIZED_SCOPE__[fqn];
    if (!state) {
      throw new Error(
        `Resource ${fqn} not found in __ALCHEMY_SERIALIZED_SCOPE__\n${JSON.stringify(__ALCHEMY_SERIALIZED_SCOPE__, null, 2)}`,
      );
    }
    return await deserialize(Scope.current, state, {
      transform: (value) => {
        if (value && typeof value === "object" && value["@secret-env"]) {
          return {
            value: new Secret(env[value["@secret-env"]]),
          };
        }
      },
    });
  },
};
// export const process = { env };

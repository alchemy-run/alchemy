import * as apikeys from "@distilled.cloud/gcp/apikeys_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { Key } from "./Key.ts";

/**
 * Runtime binding for API Keys `keys.getKeyString`.
 *
 * Bind this operation to a {@link Key} in a Function/Action init phase.
 * Provide {@link GetKeyStringHttp}. The key string is not included on
 * `keys.get` — this is the only way to read it.
 *
 * ### Reading the Key String
 * **Example:** Get the encrypted key string
 * ```typescript
 * const getKeyString = yield* GCP.ApiKeys.GetKeyString(maps);
 * const { keyString } = yield* getKeyString();
 * ```
 *
 * @binding
 * @category ApiKeys
 */
export interface GetKeyString extends Binding.Service<
  GetKeyString,
  "GCP.ApiKeys.GetKeyString",
  (
    key: Key,
  ) => Effect.Effect<
    () => Effect.Effect<
      apikeys.V2GetKeyStringResponse,
      apikeys.GetKeyStringProjectsLocationsKeysError,
      RuntimeContext
    >
  >
> {}

export const GetKeyString = Binding.Service<GetKeyString>("GCP.ApiKeys.GetKeyString");

/**
 * HTTP implementation of {@link GetKeyString}.
 *
 * @layer
 * @provides GCP.ApiKeys.GetKeyString
 */
export const GetKeyStringHttp = Layer.effect(
  GetKeyString,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getKeyStringProjectsLocationsKeys = yield* GCPBindings.withCredentials(
      apikeys.getKeyStringProjectsLocationsKeys,
    );
    return Effect.fn(function* <K extends Key>(key: K) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.ApiKeys.GetKeyString(${key})`({
          // API keys have no resource-level IAM.
          iam: [{ role: "roles/serviceusage.apiKeysViewer" }],
        });
      }
      const name = yield* key.name;
      return Effect.fn(`GCP.ApiKeys.GetKeyString(${key.LogicalId})`)(function* () {
        return yield* getKeyStringProjectsLocationsKeys({
          name: yield* name,
        });
      });
    });
  }),
);

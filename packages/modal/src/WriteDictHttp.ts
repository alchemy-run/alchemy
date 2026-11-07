import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Dict } from "./Dict.ts";
import { DictOps, makeWriteDictClient } from "./DictClient.ts";
import { WriteDict } from "./WriteDict.ts";

/**
 * {@link WriteDict} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the dict's environment.
 *
 * @layer
 * @product Dict
 * @provides Modal.WriteDict
 */
export const WriteDictHttp = Layer.effect(
  WriteDict,
  makeModalBinding({
    tag: "Modal.WriteDict",
    operations: DictOps,
    role: "contributor",
    make: Effect.fn(function* (dict: Dict, ops) {
      const dictId = yield* dict.dictId;
      return makeWriteDictClient(dictId, ops);
    }),
  }),
);

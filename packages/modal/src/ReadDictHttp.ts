import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Dict } from "./Dict.ts";
import { DictOps, makeReadDictClient } from "./DictClient.ts";
import { ReadDict } from "./ReadDict.ts";

/**
 * {@link ReadDict} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `viewer` role on the dict's environment.
 *
 * @layer
 * @product Dict
 * @provides Modal.ReadDict
 */
export const ReadDictHttp = Layer.effect(
  ReadDict,
  makeModalBinding({
    tag: "Modal.ReadDict",
    operations: DictOps,
    role: "viewer",
    make: Effect.fn(function* (dict: Dict, ops) {
      const dictId = yield* dict.dictId;
      return makeReadDictClient(dictId, ops);
    }),
  }),
);

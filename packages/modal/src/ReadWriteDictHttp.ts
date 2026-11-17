import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Dict } from "./Dict.ts";
import { DictOps, makeReadWriteDictClient } from "./DictClient.ts";
import { ReadWriteDict } from "./ReadWriteDict.ts";

/**
 * {@link ReadWriteDict} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the dict's environment.
 *
 * @layer
 * @product Dict
 * @provides Modal.ReadWriteDict
 */
export const ReadWriteDictHttp = Layer.effect(
  ReadWriteDict,
  makeModalBinding({
    tag: "Modal.ReadWriteDict",
    operations: DictOps,
    role: "contributor",
    make: Effect.fn(function* (dict: Dict, ops) {
      const dictId = yield* dict.dictId;
      return makeReadWriteDictClient(dictId, ops);
    }),
  }),
);

import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyClientHttpBinding, makeReadKeyClient } from "./BindingHttp.ts";
import { ReadKey } from "./ReadKey.ts";

/**
 * HTTP implementation of {@link ReadKey}.
 *
 * @layer
 * @provides Stackit.KMS.ReadKey
 */
export const ReadKeyHttp = Layer.effect(
  ReadKey,
  makeKeyClientHttpBinding({
    tag: "Stackit.KMS.ReadKey",
    access: KMS_READ_ACCESS,
    makeClient: makeReadKeyClient,
  }),
);

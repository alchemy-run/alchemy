import * as Layer from "effect/Layer";
import {
  KMS_READ_WRITE_ACCESS,
  makeKeyClientHttpBinding,
  makeReadWriteKeyClient,
} from "./BindingHttp.ts";
import { ReadWriteKey } from "./ReadWriteKey.ts";

/**
 * HTTP implementation of {@link ReadWriteKey}.
 *
 * @layer
 * @provides Stackit.KMS.ReadWriteKey
 */
export const ReadWriteKeyHttp = Layer.effect(
  ReadWriteKey,
  makeKeyClientHttpBinding({
    tag: "Stackit.KMS.ReadWriteKey",
    access: KMS_READ_WRITE_ACCESS,
    makeClient: makeReadWriteKeyClient,
  }),
);

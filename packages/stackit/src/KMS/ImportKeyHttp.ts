import * as Layer from "effect/Layer";
import { KMS_WRITE_ACCESS, makeKeyClientHttpBinding, makeImportKeyClient } from "./BindingHttp.ts";
import { ImportKey } from "./ImportKey.ts";

/**
 * HTTP implementation of {@link ImportKey}.
 *
 * @layer
 * @provides Stackit.KMS.ImportKey
 */
export const ImportKeyHttp = Layer.effect(
  ImportKey,
  makeKeyClientHttpBinding({
    tag: "Stackit.KMS.ImportKey",
    access: KMS_WRITE_ACCESS,
    makeClient: makeImportKeyClient,
  }),
);

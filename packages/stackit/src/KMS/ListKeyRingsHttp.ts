import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_LIST_ACCESS, makeKeyRingScopeHttpBinding } from "./BindingHttp.ts";
import { ListKeyRings } from "./ListKeyRings.ts";

/**
 * HTTP implementation of {@link ListKeyRings}.
 *
 * @layer
 * @provides Stackit.KMS.ListKeyRings
 */
export const ListKeyRingsHttp = Layer.effect(
  ListKeyRings,
  makeKeyRingScopeHttpBinding({
    tag: "Stackit.KMS.ListKeyRings",
    access: KMS_LIST_ACCESS,
    operation: kms.listKeyRings,
  }),
);

import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyRingHttpBinding } from "./BindingHttp.ts";
import { ListWrappingKeys } from "./ListWrappingKeys.ts";

/**
 * HTTP implementation of {@link ListWrappingKeys}.
 *
 * @layer
 * @provides Stackit.KMS.ListWrappingKeys
 */
export const ListWrappingKeysHttp = Layer.effect(
  ListWrappingKeys,
  makeKeyRingHttpBinding({
    tag: "Stackit.KMS.ListWrappingKeys",
    access: KMS_READ_ACCESS,
    operation: kms.listWrappingKeys,
  }),
);

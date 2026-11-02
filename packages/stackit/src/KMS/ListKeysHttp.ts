import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyRingHttpBinding } from "./BindingHttp.ts";
import { ListKeys } from "./ListKeys.ts";

/**
 * HTTP implementation of {@link ListKeys}.
 *
 * @layer
 * @provides Stackit.KMS.ListKeys
 */
export const ListKeysHttp = Layer.effect(
  ListKeys,
  makeKeyRingHttpBinding({
    tag: "Stackit.KMS.ListKeys",
    access: KMS_READ_ACCESS,
    operation: kms.listKeys,
  }),
);

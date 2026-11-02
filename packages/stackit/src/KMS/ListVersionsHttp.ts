import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyHttpBinding } from "./BindingHttp.ts";
import { ListVersions } from "./ListVersions.ts";

/**
 * HTTP implementation of {@link ListVersions}.
 *
 * @layer
 * @provides Stackit.KMS.ListVersions
 */
export const ListVersionsHttp = Layer.effect(
  ListVersions,
  makeKeyHttpBinding({
    tag: "Stackit.KMS.ListVersions",
    access: KMS_READ_ACCESS,
    operation: kms.listVersions,
  }),
);

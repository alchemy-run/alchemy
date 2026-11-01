import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Layer from "effect/Layer";
import { makeServiceAccountHttpBinding } from "./BindingHttp.ts";
import { ListServiceAccountKeys } from "./ListServiceAccountKeys.ts";

/**
 * HTTP implementation of {@link ListServiceAccountKeys}.
 *
 * @layer
 * @provides Stackit.IAM.ListServiceAccountKeys
 */
export const ListServiceAccountKeysHttp = Layer.effect(
  ListServiceAccountKeys,
  makeServiceAccountHttpBinding({
    tag: "Stackit.IAM.ListServiceAccountKeys",
    access: { permissions: ["iam.service-account-key.list"] },
    operation: serviceAccount.listServiceAccountKeys,
  }),
);

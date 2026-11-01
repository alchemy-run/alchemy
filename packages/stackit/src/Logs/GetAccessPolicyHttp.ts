import * as logs from "@distilled.cloud/stackit/logs";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAccessPolicy } from "./GetAccessPolicy.ts";

/**
 * HTTP implementation of {@link GetAccessPolicy}.
 *
 * @layer
 * @provides Stackit.Logs.GetAccessPolicy
 */
export const GetAccessPolicyHttp = Layer.effect(
  GetAccessPolicy,
  makeInstanceHttpBinding({
    tag: "Stackit.Logs.GetAccessPolicy",
    permission: "logs.instance.access-policies.get",
    operation: logs.getAccessPolicy,
  }),
);

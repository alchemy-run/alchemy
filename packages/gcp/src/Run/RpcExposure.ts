import type * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Data from "effect/Data";
import { RPC_METHODS_ENV } from "../HostContext.ts";

/** Members that make a Cloud Run service callable by anyone. */
const PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);

/** Predefined roles that carry `run.routes.invoke`. */
const INVOKER_ROLES = new Set([
  "roles/run.invoker",
  "roles/run.servicesInvoker",
  "roles/run.developer",
  "roles/run.admin",
]);

/**
 * The service returns RPC methods but anyone can call it — through
 * `invokerIamDisabled`, or a public invoker grant on its IAM policy.
 */
export class ServiceRpcPublic extends Data.TaggedError("GCP.Run.ServiceRpcPublic")<{
  service: string;
  via: string;
}> {
  override get message() {
    return `GCP.Run.Service ${this.service} returns RPC methods but ${this.via}, so they would be public. Keep the service private and call it with GCP.Run.InvokeService.`;
  }
}

/** Whether a role → member grant lets anyone invoke the service. */
export const isPublicInvokerGrant = (role: string, member: string) =>
  INVOKER_ROLES.has(role) && PUBLIC_MEMBERS.has(member);

/** The public invoker grant on a service's IAM policy, if any. */
export const publicInvokerGrant = (policy: cloudrun.GoogleIamV1Policy | undefined) => {
  for (const binding of policy?.bindings ?? []) {
    for (const member of binding.members ?? []) {
      if (isPublicInvokerGrant(binding.role ?? "", member)) {
        return `${member} holds ${binding.role}`;
      }
    }
  }
  return undefined;
};

/** Whether a deployed service's program returns RPC methods. */
export const servesRpc = (service: cloudrun.GoogleCloudRunV2Service | undefined) =>
  (service?.template?.containers ?? []).some((container) =>
    (container.env ?? []).some((env) => env.name === RPC_METHODS_ENV),
  );

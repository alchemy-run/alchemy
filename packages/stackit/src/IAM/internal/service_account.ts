import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Effect from "effect/Effect";

/** Every service account of a project (one page: the API has no paging). */
export const listServiceAccounts = (projectId: string) =>
  serviceAccount.listServiceAccounts({ projectId }).pipe(Effect.map((list) => list.items));

/**
 * Whether the service account exists. Sub-resources (keys, federated
 * identity providers) check it before touching their own endpoints, so a
 * deleted account reads as "gone" rather than as whatever status those
 * endpoints answer for a missing parent (STACKIT's own Terraform provider
 * sees 400/403/404 there).
 */
export const hasServiceAccount = (projectId: string, email: string) =>
  listServiceAccounts(projectId).pipe(
    Effect.map((accounts) => accounts.some((account) => account.email === email)),
  );

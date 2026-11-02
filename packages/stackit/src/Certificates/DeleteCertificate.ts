import type * as certificates from "@distilled.cloud/stackit/certificates";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface DeleteCertificateRequest extends Omit<
  certificates.DeleteCertificateRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for Certificates `DeleteCertificate`: delete a stored certificate by id, such as one a renewal replaced.
 *
 * STACKIT refuses with `BadRequest` while a load balancer uses it. Pass the id
 * on each request: don't delete a certificate this stack manages.
 *
 * Bind this operation to any resource with `projectId` and `region` attributes, such as a `Certificate`, in a Function/Worker init phase and provide
 * {@link DeleteCertificateHttp}. The resource's project and region are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `alb.certificateservice.certificate.delete`
 * on the project holding the bound resource, so it reaches every certificate in
 * that project: STACKIT binds roles on projects, folders and organizations, not on
 * a single certificate. The deployer needs `iam.role.add` on that scope to define
 * the role.
 *
 * ### Deleting a Certificate
 * **Example:** Remove an old certificate from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Tls = Stackit.Certificates.Certificate("Tls", {
 *   publicKey: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
 *   privateKey: Redacted.make("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"),
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const deleteCertificate = yield* Stackit.Certificates.DeleteCertificate(yield* Tls);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteCertificate({ id: "www-renewed-v1-123456" });
 *         return HttpServerResponse.text("deleted");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Certificates.DeleteCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category Certificates
 */
export interface DeleteCertificate extends Binding.Service<
  DeleteCertificate,
  "Stackit.Certificates.DeleteCertificate",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: DeleteCertificateRequest,
    ) => Effect.Effect<
      certificates.DeleteCertificateResponse2,
      certificates.DeleteCertificateError,
      RuntimeContext
    >
  >
> {}

export const DeleteCertificate = Binding.Service<DeleteCertificate>(
  "Stackit.Certificates.DeleteCertificate",
);

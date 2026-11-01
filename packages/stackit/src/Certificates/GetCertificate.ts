import type * as certificates from "@distilled.cloud/stackit/certificates";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Certificate } from "./Certificate.ts";

export interface GetCertificateRequest extends Omit<
  certificates.GetCertificateRequest,
  "projectId" | "region" | "id"
> {}

/**
 * Runtime binding for Certificates `GetCertificate`: read a stored certificate's public parts, validity and usage.
 *
 * Bind this operation to a {@link Certificate} in a Function/Worker init phase and provide
 * {@link GetCertificateHttp}. The resource's project, region and id are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `alb.certificateservice.certificate.get` on
 * the project holding the certificate, so it reaches every certificate in that
 * project: STACKIT binds roles on projects, folders and organizations, not on a
 * single certificate. The deployer needs `iam.role.add` on that scope to define
 * the role.
 *
 * ### Reading the Certificate
 * **Example:** Check expiry from a Cloudflare Worker
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
 *     const getCertificate = yield* Stackit.Certificates.GetCertificate(yield* Tls);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getCertificate();
 *         return yield* HttpServerResponse.json({ notAfter: live.data?.notAfter });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Certificates.GetCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category Certificates
 */
export interface GetCertificate extends Binding.Service<
  GetCertificate,
  "Stackit.Certificates.GetCertificate",
  (
    certificate: Certificate,
  ) => Effect.Effect<
    (
      request?: GetCertificateRequest,
    ) => Effect.Effect<
      certificates.GetCertificateResponse,
      certificates.GetCertificateError,
      RuntimeContext
    >
  >
> {}

export const GetCertificate = Binding.Service<GetCertificate>(
  "Stackit.Certificates.GetCertificate",
);

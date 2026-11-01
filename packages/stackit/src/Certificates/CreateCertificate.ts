import type * as certificates from "@distilled.cloud/stackit/certificates";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface CreateCertificateRequest extends Omit<
  certificates.CreateCertificateRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for Certificates `CreateCertificate`: store a TLS certificate, such as a pair an ACME client renewed at runtime.
 *
 * The private key stays `Redacted`: it is only sent to STACKIT and never
 * returned.
 *
 * Bind this operation to any resource with `projectId` and `region` attributes, such as a `Certificate`, in a Function/Worker init phase and provide
 * {@link CreateCertificateHttp}. The resource's project and region are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `alb.certificateservice.certificate.create`
 * on the project holding the bound resource, so it reaches every certificate in
 * that project: STACKIT binds roles on projects, folders and organizations, not on
 * a single certificate. The deployer needs `iam.role.add` on that scope to define
 * the role.
 *
 * ### Storing a Certificate
 * **Example:** Store a renewed pair from a Cloudflare Worker
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
 *     const createCertificate = yield* Stackit.Certificates.CreateCertificate(yield* Tls);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const created = yield* createCertificate({
 *           name: "www-renewed",
 *           publicKey: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
 *           privateKey: Redacted.make("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"),
 *         });
 *         return yield* HttpServerResponse.json({ id: created.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Certificates.CreateCertificateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category Certificates
 */
export interface CreateCertificate extends Binding.Service<
  CreateCertificate,
  "Stackit.Certificates.CreateCertificate",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: CreateCertificateRequest,
    ) => Effect.Effect<
      certificates.GetCertificateResponse,
      certificates.CreateCertificateError,
      RuntimeContext
    >
  >
> {}

export const CreateCertificate = Binding.Service<CreateCertificate>(
  "Stackit.Certificates.CreateCertificate",
);

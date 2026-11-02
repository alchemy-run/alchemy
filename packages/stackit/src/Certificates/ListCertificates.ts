import type * as certificates from "@distilled.cloud/stackit/certificates";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListCertificatesRequest extends Omit<
  certificates.ListCertificatesRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for Certificates `ListCertificates`: list the certificates stored in a project and region.
 *
 * Bind this operation to any resource with `projectId` and `region` attributes, such as a `Certificate`, in a Function/Worker init phase and provide
 * {@link ListCertificatesHttp}. The resource's project and region are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `alb.certificateservice.certificate.list` on
 * the project holding the bound resource, so it reaches every certificate in that
 * project: STACKIT binds roles on projects, folders and organizations, not on a
 * single certificate. The deployer needs `iam.role.add` on that scope to define
 * the role.
 *
 * ### Listing Certificates
 * **Example:** List stored certificates from a Cloudflare Worker
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
 *     const listCertificates = yield* Stackit.Certificates.ListCertificates(yield* Tls);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listCertificates({ pageSize: "100" });
 *         return yield* HttpServerResponse.json({ names: (items ?? []).map((item) => item.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Certificates.ListCertificatesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category Certificates
 */
export interface ListCertificates extends Binding.Service<
  ListCertificates,
  "Stackit.Certificates.ListCertificates",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListCertificatesRequest,
    ) => Effect.Effect<
      certificates.ListCertificatesResponse,
      certificates.ListCertificatesError,
      RuntimeContext
    >
  >
> {}

export const ListCertificates = Binding.Service<ListCertificates>(
  "Stackit.Certificates.ListCertificates",
);

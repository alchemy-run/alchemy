import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { CERT_A_PEM, CERT_B_PEM, KEY_A_PEM, KEY_B_PEM } from "./certs.ts";

export const Tls = Stackit.Certificates.Certificate("CertificatesBindingsTls", {
  publicKey: CERT_A_PEM,
  privateKey: Redacted.make(KEY_A_PEM),
});

/**
 * A Cloudflare Worker with every Certificates binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class CertificatesBindingsWorker extends Cloudflare.Worker<CertificatesBindingsWorker>()(
  "StackitCertificatesBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const certificate = yield* Tls;
    const createCertificate = yield* Stackit.Certificates.CreateCertificate(certificate);
    const getCertificate = yield* Stackit.Certificates.GetCertificate(certificate);
    const listCertificates = yield* Stackit.Certificates.ListCertificates(certificate);
    const deleteCertificate = yield* Stackit.Certificates.DeleteCertificate(certificate);
    const getQuota = yield* Stackit.Certificates.GetQuota(certificate);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/create-certificate":
            return yield* respond(
              createCertificate({
                name: param("name"),
                publicKey: CERT_B_PEM,
                privateKey: Redacted.make(KEY_B_PEM),
              }),
            );
          case "/get-certificate":
            return yield* respond(getCertificate());
          case "/list-certificates":
            return yield* respond(listCertificates({ pageSize: "100" }));
          case "/delete-certificate":
            return yield* respond(deleteCertificate({ id: param("id") }));
          case "/get-quota":
            return yield* respond(getQuota());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Certificates.CreateCertificateHttp,
        Stackit.Certificates.GetCertificateHttp,
        Stackit.Certificates.ListCertificatesHttp,
        Stackit.Certificates.DeleteCertificateHttp,
        Stackit.Certificates.GetQuotaHttp,
      ),
    ),
  ),
) {}

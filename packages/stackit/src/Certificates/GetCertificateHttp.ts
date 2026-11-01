import * as certificates from "@distilled.cloud/stackit/certificates";
import * as Layer from "effect/Layer";
import { makeCertificateHttpBinding } from "./BindingHttp.ts";
import { GetCertificate } from "./GetCertificate.ts";

/**
 * HTTP implementation of {@link GetCertificate}.
 *
 * @layer
 * @provides Stackit.Certificates.GetCertificate
 */
export const GetCertificateHttp = Layer.effect(
  GetCertificate,
  makeCertificateHttpBinding({
    tag: "Stackit.Certificates.GetCertificate",
    permission: "alb.certificateservice.certificate.get",
    operation: certificates.getCertificate,
  }),
);

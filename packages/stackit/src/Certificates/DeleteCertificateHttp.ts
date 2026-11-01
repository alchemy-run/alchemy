import * as certificates from "@distilled.cloud/stackit/certificates";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { DeleteCertificate } from "./DeleteCertificate.ts";

/**
 * HTTP implementation of {@link DeleteCertificate}.
 *
 * @layer
 * @provides Stackit.Certificates.DeleteCertificate
 */
export const DeleteCertificateHttp = Layer.effect(
  DeleteCertificate,
  makeScopeHttpBinding({
    tag: "Stackit.Certificates.DeleteCertificate",
    permission: "alb.certificateservice.certificate.delete",
    operation: certificates.deleteCertificate,
  }),
);

import * as certificates from "@distilled.cloud/stackit/certificates";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { CreateCertificate } from "./CreateCertificate.ts";

/**
 * HTTP implementation of {@link CreateCertificate}.
 *
 * @layer
 * @provides Stackit.Certificates.CreateCertificate
 */
export const CreateCertificateHttp = Layer.effect(
  CreateCertificate,
  makeScopeHttpBinding({
    tag: "Stackit.Certificates.CreateCertificate",
    permission: "alb.certificateservice.certificate.create",
    operation: certificates.createCertificate,
  }),
);

import * as certificates from "@distilled.cloud/stackit/certificates";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { ListCertificates } from "./ListCertificates.ts";

/**
 * HTTP implementation of {@link ListCertificates}.
 *
 * @layer
 * @provides Stackit.Certificates.ListCertificates
 */
export const ListCertificatesHttp = Layer.effect(
  ListCertificates,
  makeScopeHttpBinding({
    tag: "Stackit.Certificates.ListCertificates",
    permission: "alb.certificateservice.certificate.list",
    operation: certificates.listCertificates,
  }),
);

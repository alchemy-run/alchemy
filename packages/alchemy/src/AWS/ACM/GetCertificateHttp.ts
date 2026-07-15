import * as acm from "@distilled.cloud/aws/acm";
import * as Layer from "effect/Layer";
import { makeAcmCertificateHttpBinding } from "./BindingHttp.ts";
import { GetCertificate } from "./GetCertificate.ts";

export const GetCertificateHttp = Layer.effect(
  GetCertificate,
  makeAcmCertificateHttpBinding<
    {},
    acm.GetCertificateResponse,
    acm.GetCertificateError
  >({
    capability: "GetCertificate",
    iamActions: ["acm:GetCertificate"],
    operation: acm.getCertificate,
  }),
);

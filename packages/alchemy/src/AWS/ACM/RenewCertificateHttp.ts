import * as acm from "@distilled.cloud/aws/acm";
import * as Layer from "effect/Layer";
import { makeAcmCertificateHttpBinding } from "./BindingHttp.ts";
import { RenewCertificate } from "./RenewCertificate.ts";

export const RenewCertificateHttp = Layer.effect(
  RenewCertificate,
  makeAcmCertificateHttpBinding<
    {},
    acm.RenewCertificateResponse,
    acm.RenewCertificateError
  >({
    capability: "RenewCertificate",
    iamActions: ["acm:RenewCertificate"],
    operation: acm.renewCertificate,
  }),
);

import * as Layer from "effect/Layer";
import {
  CertificateOrder,
  CertificateOrderProvider,
} from "./CertificateOrder.ts";
import {
  CertificateOrderCertificate,
  CertificateOrderCertificateProvider,
} from "./CertificateOrderCertificate.ts";

export const resources = [CertificateOrder, CertificateOrderCertificate];
export const layers = () =>
  Layer.mergeAll(
    CertificateOrderProvider(),
    CertificateOrderCertificateProvider(),
  );

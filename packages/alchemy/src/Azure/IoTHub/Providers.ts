import * as Layer from "effect/Layer";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { ConsumerGroup, ConsumerGroupProvider } from "./ConsumerGroup.ts";
import { IotHub, IotHubProvider } from "./IotHub.ts";

export const resources = [Certificate, ConsumerGroup, IotHub];
export const layers = () =>
  Layer.mergeAll(
    CertificateProvider(),
    ConsumerGroupProvider(),
    IotHubProvider(),
  );

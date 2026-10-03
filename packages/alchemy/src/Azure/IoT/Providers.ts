import * as Layer from "effect/Layer";
import {
  ProvisioningService,
  ProvisioningServiceProvider,
} from "./ProvisioningService.ts";
import {
  ProvisioningServiceCertificate,
  ProvisioningServiceCertificateProvider,
} from "./ProvisioningServiceCertificate.ts";
import {
  ProvisioningServicePrivateEndpointConnection,
  ProvisioningServicePrivateEndpointConnectionProvider,
} from "./ProvisioningServicePrivateEndpointConnection.ts";

export const resources = [
  ProvisioningService,
  ProvisioningServiceCertificate,
  ProvisioningServicePrivateEndpointConnection,
];
export const layers = () =>
  Layer.mergeAll(
    ProvisioningServiceProvider(),
    ProvisioningServiceCertificateProvider(),
    ProvisioningServicePrivateEndpointConnectionProvider(),
  );

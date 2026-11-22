import * as Layer from "effect/Layer";
import { Application, ApplicationProvider } from "./Application.ts";
import { ApplicationPassword, ApplicationPasswordProvider } from "./ApplicationPassword.ts";
import {
  FederatedIdentityCredential,
  FederatedIdentityCredentialProvider,
} from "./FederatedIdentityCredential.ts";
import { ServicePrincipal, ServicePrincipalProvider } from "./ServicePrincipal.ts";

export const resources = [
  Application,
  ApplicationPassword,
  FederatedIdentityCredential,
  ServicePrincipal,
];
export const layers = () =>
  Layer.mergeAll(
    ApplicationProvider(),
    ApplicationPasswordProvider(),
    FederatedIdentityCredentialProvider(),
    ServicePrincipalProvider(),
  );

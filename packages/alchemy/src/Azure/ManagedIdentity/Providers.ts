import * as Layer from "effect/Layer";
import {
  FederatedIdentityCredential,
  FederatedIdentityCredentialProvider,
} from "./FederatedIdentityCredential.ts";
import {
  UserAssignedIdentity,
  UserAssignedIdentityProvider,
} from "./UserAssignedIdentity.ts";

export const resources = [UserAssignedIdentity, FederatedIdentityCredential];
export const layers = () =>
  Layer.mergeAll(
    UserAssignedIdentityProvider(),
    FederatedIdentityCredentialProvider(),
  );

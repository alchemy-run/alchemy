import * as Layer from "effect/Layer";
import {
  UserAssignedIdentity,
  UserAssignedIdentityProvider,
} from "./UserAssignedIdentity.ts";

export const resources = [UserAssignedIdentity];
export const layers = () => Layer.mergeAll(UserAssignedIdentityProvider());

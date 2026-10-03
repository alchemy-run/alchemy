import * as Layer from "effect/Layer";
import {
  PrivateLinkAssociation,
  PrivateLinkAssociationProvider,
} from "./PrivateLinkAssociation.ts";
import { RoleAssignment, RoleAssignmentProvider } from "./RoleAssignment.ts";
import { RoleDefinition, RoleDefinitionProvider } from "./RoleDefinition.ts";

export const resources = [
  PrivateLinkAssociation,
  RoleAssignment,
  RoleDefinition,
];
export const layers = () =>
  Layer.mergeAll(
    PrivateLinkAssociationProvider(),
    RoleAssignmentProvider(),
    RoleDefinitionProvider(),
  );

import * as Layer from "effect/Layer";
import { RoleAssignment, RoleAssignmentProvider } from "./RoleAssignment.ts";
import { RoleDefinition, RoleDefinitionProvider } from "./RoleDefinition.ts";

export const resources = [RoleAssignment, RoleDefinition];
export const layers = () =>
  Layer.mergeAll(RoleAssignmentProvider(), RoleDefinitionProvider());

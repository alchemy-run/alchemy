import * as Layer from "effect/Layer";
import { RoleAssignment, RoleAssignmentProvider } from "./RoleAssignment.ts";

export const resources = [RoleAssignment];
export const layers = () => Layer.mergeAll(RoleAssignmentProvider());

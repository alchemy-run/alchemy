import * as Layer from "effect/Layer";
import {
  RegistrationAssignment,
  RegistrationAssignmentProvider,
} from "./RegistrationAssignment.ts";
import {
  RegistrationDefinition,
  RegistrationDefinitionProvider,
} from "./RegistrationDefinition.ts";

export const resources = [RegistrationAssignment, RegistrationDefinition];
export const layers = () =>
  Layer.mergeAll(
    RegistrationAssignmentProvider(),
    RegistrationDefinitionProvider(),
  );

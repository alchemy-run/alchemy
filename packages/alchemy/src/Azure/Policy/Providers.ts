import * as Layer from "effect/Layer";
import {
  PolicyAssignment,
  PolicyAssignmentProvider,
} from "./PolicyAssignment.ts";
import {
  PolicyDefinition,
  PolicyDefinitionProvider,
} from "./PolicyDefinition.ts";
import {
  PolicyDefinitionVersion,
  PolicyDefinitionVersionProvider,
} from "./PolicyDefinitionVersion.ts";
import {
  PolicySetDefinition,
  PolicySetDefinitionProvider,
} from "./PolicySetDefinition.ts";
import {
  PolicySetDefinitionVersion,
  PolicySetDefinitionVersionProvider,
} from "./PolicySetDefinitionVersion.ts";

export const resources = [
  PolicyAssignment,
  PolicyDefinition,
  PolicyDefinitionVersion,
  PolicySetDefinition,
  PolicySetDefinitionVersion,
];
export const layers = () =>
  Layer.mergeAll(
    PolicyAssignmentProvider(),
    PolicyDefinitionProvider(),
    PolicyDefinitionVersionProvider(),
    PolicySetDefinitionProvider(),
    PolicySetDefinitionVersionProvider(),
  );

import * as Layer from "effect/Layer";
import {
  ConfigurationProfile,
  ConfigurationProfileProvider,
} from "./ConfigurationProfile.ts";
import {
  ConfigurationProfileAssignment,
  ConfigurationProfileAssignmentProvider,
} from "./ConfigurationProfileAssignment.ts";
import {
  ConfigurationProfileVersion,
  ConfigurationProfileVersionProvider,
} from "./ConfigurationProfileVersion.ts";

export const resources = [
  ConfigurationProfile,
  ConfigurationProfileAssignment,
  ConfigurationProfileVersion,
];
export const layers = () =>
  Layer.mergeAll(
    ConfigurationProfileProvider(),
    ConfigurationProfileAssignmentProvider(),
    ConfigurationProfileVersionProvider(),
  );

import * as Layer from "effect/Layer";
import { Capability, CapabilityProvider } from "./Capability.ts";
import { Experiment, ExperimentProvider } from "./Experiment.ts";
import { Target, TargetProvider } from "./Target.ts";

export const resources = [Capability, Experiment, Target];
export const layers = () =>
  Layer.mergeAll(CapabilityProvider(), ExperimentProvider(), TargetProvider());

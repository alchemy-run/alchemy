import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeSfnServiceBinding } from "./Binding.ts";
import { ValidateStateMachineDefinition } from "./ValidateStateMachineDefinition.ts";

export const ValidateStateMachineDefinitionHttp = Layer.effect(
  ValidateStateMachineDefinition,
  makeSfnServiceBinding({
    name: "AWS.StepFunctions.ValidateStateMachineDefinition",
    actions: ["states:ValidateStateMachineDefinition"],
    operation: sfn.validateStateMachineDefinition,
  }),
);

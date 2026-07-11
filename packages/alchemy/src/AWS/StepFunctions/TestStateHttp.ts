import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeSfnServiceBinding } from "./Binding.ts";
import { TestState } from "./TestState.ts";

export const TestStateHttp = Layer.effect(
  TestState,
  makeSfnServiceBinding({
    name: "AWS.StepFunctions.TestState",
    actions: ["states:TestState"],
    operation: sfn.testState,
  }),
);

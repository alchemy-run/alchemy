import * as Layer from "effect/Layer";
import { OnboardingState, OnboardingStateProvider } from "./OnboardingState.ts";

export const resources = [OnboardingState];
export const layers = () => Layer.mergeAll(OnboardingStateProvider());

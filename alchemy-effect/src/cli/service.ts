import type { IPlan } from "../plan.ts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { ApplyEvent } from "../event.ts";

export interface PlanStatusSession {
  emit: (event: ApplyEvent) => Effect.Effect<void>;
  done: () => Effect.Effect<void>;
}

export interface ScopedPlanStatusSession extends PlanStatusSession {
  note: (note: string) => Effect.Effect<void>;
}

export interface CLIService {
  approvePlan: <P extends IPlan>(plan: P) => Effect.Effect<boolean>;
  displayPlan: <P extends IPlan>(plan: P) => Effect.Effect<void>;
  startApplySession: <P extends IPlan>(
    plan: P,
  ) => Effect.Effect<PlanStatusSession>;
}

export class CLI extends Context.Tag("CLIService")<CLI, CLIService>() {}

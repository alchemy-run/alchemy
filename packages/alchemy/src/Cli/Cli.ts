import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Plan } from "../Plan.ts";
import type { ApplyEvent } from "./Event.ts";

export interface PlanStatusSession {
  emit: (event: ApplyEvent) => Effect.Effect<void>;
  done: (outcome: "success" | "failure") => Effect.Effect<void>;
}

export interface PlanningStatusSession {
  update: (label: string, detail?: string) => Effect.Effect<void>;
  succeed: (message?: string) => Effect.Effect<void>;
  fail: (message?: string) => Effect.Effect<void>;
  close: Effect.Effect<void>;
}

export interface ScopedPlanStatusSession extends PlanStatusSession {
  note: (note: string) => Effect.Effect<void>;
}

export interface PlanDisplayOptions {
  /** Show declared resource inputs as structured YAML. */
  detailed?: boolean;
  /** Stage displayed in terminal lifecycle updates. */
  stage?: string;
}

export interface CLIService {
  startPlanningSession: (
    label: string,
    detail?: string,
    title?: string,
  ) => Effect.Effect<PlanningStatusSession>;
  approvePlan: <P extends Plan>(
    plan: P,
    options?: PlanDisplayOptions,
  ) => Effect.Effect<boolean>;
  displayPlan: <P extends Plan>(
    plan: P,
    options?: PlanDisplayOptions,
  ) => Effect.Effect<void>;
  startApplySession: <P extends Plan>(
    plan: P,
    options?: PlanDisplayOptions,
  ) => Effect.Effect<PlanStatusSession>;
}

export class Cli extends Context.Service<Cli, CLIService>()("CLI") {}

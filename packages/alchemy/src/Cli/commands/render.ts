import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { Progress } from "../../Alchemist/Progress.ts";
import type { Plan } from "../../Plan.ts";
import * as Report from "../../Report.ts";
import { CliKit } from "../CliKit/CliKit.ts";
import { formatElapsed } from "../Format.ts";

/** How often a non-interactive plan reports diffs that are still running. */
const SLOW_DIFF_INTERVAL = "30 seconds";

export const renderPlanning =
  (options: { operation: string; stage: string; computingLabel?: string; readyLabel?: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const phaseLabel: Record<Report.PlanningPhase, string> = {
        "importing-module": "Importing stack module",
        "resolving-services": "Resolving stack services",
        "loading-state": "Loading stack state",
        "computing-plan": options.computingLabel ?? "Computing plan",
        "plan-ready": options.readyLabel ?? "Plan ready",
      };
      const cli = yield* Report.Cli;
      const planning = yield* cli.startPlanningSession(
        phaseLabel["importing-module"],
        options.stage,
        `${options.operation} · ${options.stage}`,
      );
      const interactive = (yield* CliKit).terminal.input;
      // fqn -> when its diff started; insertion order keeps the oldest first.
      const inFlight = new Map<string, number>();
      const failures: Report.ResourceDiffFailed[] = [];
      let done = 0;
      let total = 0;
      const showCounter = (fallback: string) =>
        Effect.suspend(() => {
          const current: string = inFlight.keys().next().value ?? fallback;
          const rest = inFlight.size > 1 ? ` +${inFlight.size - 1}` : "";
          return planning.update(
            phaseLabel["computing-plan"],
            `${done}/${total} · ${current}${rest}`,
          );
        });
      // A plain log has no spinner detail to show what is in flight, so a
      // diff stuck retrying a cloud call would leave "Computing plan" silent
      // until it gives up. Name the slow tail periodically instead (#2357).
      const reportSlowDiffs = Effect.gen(function* () {
        const oldest = inFlight.entries().next().value;
        if (oldest === undefined) return;
        const [fqn, startedAt] = oldest;
        const now = yield* Clock.currentTimeMillis;
        const rest = inFlight.size > 1 ? ` +${inFlight.size - 1} more` : "";
        yield* planning.update(
          `Still planning ${fqn}${rest} (${formatElapsed(now - startedAt)})`,
          options.stage,
        );
      });
      const heartbeat = interactive
        ? undefined
        : yield* reportSlowDiffs.pipe(
            Effect.repeat(Schedule.spaced(SLOW_DIFF_INTERVAL)),
            Effect.delay(SLOW_DIFF_INTERVAL),
            Effect.forkDetach,
          );
      const failedLabel = () => {
        if (failures.length === 0) return "Planning failed";
        const [first] = failures;
        const rest = failures.length > 1 ? ` (+${failures.length - 1} more failed)` : "";
        return `Planning failed: ${first!.fqn} (${first!.resourceType}): ${first!.message}${rest}`;
      };
      return yield* effect.pipe(
        Effect.provideService(Progress, (event) => {
          switch (event._tag) {
            case "plan.phase":
              return event.phase === "plan-ready"
                ? planning.succeed(phaseLabel["plan-ready"])
                : planning.update(phaseLabel[event.phase], options.stage, {
                    spinning: event.phase !== "importing-module",
                  });
            case "state.bootstrap.started":
              return planning.update(`Bootstrapping state store '${event.store}'`, options.stage);
            case "state.bootstrap.completed":
              return planning.update(phaseLabel["loading-state"], options.stage);
            case "plan.resource.started":
              return Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => {
                  inFlight.set(event.fqn, now);
                  total = Math.max(total, event.total);
                  return interactive ? showCounter(event.fqn) : Effect.void;
                }),
              );
            case "plan.resource.failed":
              inFlight.delete(event.fqn);
              failures.push(event);
              return Effect.void;
            case "plan.resource.completed":
            case "plan.action.completed":
              inFlight.delete(event.fqn);
              if (!interactive) return Effect.void;
              done = event.completed;
              total = event.total;
              return showCounter(event.fqn);
            default:
              return Effect.void;
          }
        }),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : planning.fail(failedLabel()),
        ),
        Effect.ensuring(
          Effect.andThen(
            heartbeat === undefined ? Effect.void : Fiber.interrupt(heartbeat),
            planning.close,
          ),
        ),
      );
    });

export const renderApply =
  (plan: Plan, options?: Report.PlanDisplayOptions) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const cli = yield* Report.Cli;
      const session = yield* cli.startApplySession(plan, options);
      // Dev keeps the widget mounted after apply settles and parks in the
      // ambient scope; bind the widget's teardown to that scope so a reload
      // or Ctrl+C removes it instead of stacking it under the next one.
      if (options?.dev && session.close !== undefined) {
        const scope = yield* Effect.serviceOption(Scope.Scope);
        if (Option.isSome(scope)) {
          yield* Scope.addFinalizer(scope.value, session.close);
        }
      }
      return yield* effect.pipe(
        Effect.provideService(Progress, (event) =>
          event._tag === "apply.resource.status" || event._tag === "apply.resource.note"
            ? session.emit(event)
            : Effect.void,
        ),
        Effect.tap((value) =>
          options?.dev && session.setOutput !== undefined ? session.setOutput(value) : Effect.void,
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? session.done("success")
            : Cause.hasInterruptsOnly(exit.cause)
              ? Effect.void
              : session.done("failure"),
        ),
      );
    });

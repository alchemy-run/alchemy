/** @jsxImportSource react */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Plan } from "../../Plan.ts";
import { type PlanStatusSession, Cli } from "../Cli.ts";
import { CliKit } from "../CliKit/index.ts";
import type { ApplyEvent } from "../Event.ts";
import { approvePlanScreen } from "./ApprovePlan.tsx";
import { Plan as PlanComponent } from "./Plan.tsx";
import { PlanProgress, PlanProgressStore } from "./PlanProgress.tsx";

export const sigilCli = () =>
  Layer.effect(
    Cli,
    Effect.map(CliKit, (cli) =>
      Cli.of({
        startPlanningSession: (label, detail, title) =>
          startPlanningSession(cli, label, detail, title),
        approvePlan: (plan, options) => approvePlan(cli, plan, options),
        displayPlan: (plan, options) => displayPlan(cli, plan, options),
        startApplySession: (plan, options) =>
          startApplySession(cli, plan, options),
      }),
    ),
  );

const approvePlan = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
  options?: import("../Cli.ts").PlanDisplayOptions,
) {
  const screen = approvePlanScreen(plan, options?.detailed);
  return yield* cli
    .route<boolean>({
      initialPath: "/deploy/approve",
      routes: [
        {
          path: "/deploy/approve",
          render: ({ exit, cancel }) => screen.render({ submit: exit, cancel }),
        },
      ],
    })
    .pipe(
      Effect.catchTag("TerminalCancelled", () => Effect.succeed(false)),
      Effect.orDie,
    );
});

const displayPlan = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
  options?: import("../Cli.ts").PlanDisplayOptions,
) {
  yield* cli.output.print(
    <PlanComponent plan={plan} detailed={options?.detailed} />,
  );
});

const startPlanningSession = Effect.fn(function* (
  cli: CliKit["Service"],
  label: string,
  detail?: string,
  title?: string,
) {
  const scope = yield* Scope.make();
  const progress = yield* cli.live
    .progress({
      label,
      detail,
      title: title === undefined ? undefined : `${label} · ${title}`,
      spinning: false,
    })
    .pipe(Scope.provide(scope));
  let closed = false;
  const finish = (effect: Effect.Effect<void>) =>
    Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      return effect.pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
    });
  return {
    update: (nextLabel: string, nextDetail?: string) =>
      progress.update({
        label: nextLabel,
        detail: nextDetail,
        title: title === undefined ? undefined : `${nextLabel} · ${title}`,
        spinning: true,
      }),
    succeed: (message?: string) => finish(progress.succeed(message)),
    fail: (message?: string) => finish(progress.fail(message)),
    close: finish(progress.close),
  };
});

const startApplySession = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
  options?: import("../Cli.ts").PlanDisplayOptions,
) {
  // Approval intentionally collapses before progress starts. Preserve the
  // requested YAML review in scrollback, including for --yes deployments.
  if (options?.detailed) {
    yield* cli.output.print(<PlanComponent plan={plan} detailed />);
  }
  const progress = new PlanProgressStore(plan);
  // The session outlives this effect — the caller settles it via `done` on
  // every exit path (Apply.ts's onExit). live.open is Scope-bound, so give
  // it a manually managed scope that `done` closes; Apply deliberately runs
  // the session in the ambient scope, so we cannot lean on Effect.scoped
  // here.
  const scope = yield* Scope.make();
  const live = yield* cli.live
    .open(<PlanProgress store={progress} stage={options?.stage} />, {
      persistOnClose: true,
    })
    .pipe(Scope.provide(scope));
  return {
    done: (outcome) =>
      Effect.sync(() => progress.finish(outcome)).pipe(
        Effect.andThen(live.close),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      ),
    emit: (event: ApplyEvent) => Effect.sync(() => progress.emit(event)),
  } satisfies PlanStatusSession;
});

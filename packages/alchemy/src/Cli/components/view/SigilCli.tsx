/** @jsxImportSource react */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Plan } from "../../../Plan.ts";
import { type PlanStatusSession, Cli } from "../../../Report.ts";
import { CliKit } from "../../CliKit/index.ts";
import type { ApplyEvent } from "../../../Report.ts";
import { formatElapsed } from "../../Format.ts";
import { approvePlanScreen } from "./ApprovePlan.tsx";
import { Plan as PlanComponent, PlanView, PlanViewStore } from "./PlanView.tsx";

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
  options?: import("../../../Report.ts").PlanDisplayOptions,
) {
  // A dismissed screen means "declined"; NonInteractiveTerminal propagates
  // typed to the command-level handlers (a friendly line, not a raw cause).
  return yield* cli.prompt
    .custom(approvePlanScreen(plan, options?.detailed))
    .pipe(Effect.catchTag("TerminalCancelled", () => Effect.succeed(false)));
});

const displayPlan = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
  options?: import("../../../Report.ts").PlanDisplayOptions,
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
  const startedAt = yield* Clock.currentTimeMillis;
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
  // Settle messages carry the total planning duration, mirroring the plain
  // renderer's "(1.8s)" suffix.
  const settled = (message: string | undefined) =>
    message === undefined
      ? Effect.succeed(undefined)
      : Clock.currentTimeMillis.pipe(
          Effect.map((now) => `${message} (${formatElapsed(now - startedAt)})`),
        );
  return {
    update: (
      nextLabel: string,
      nextDetail?: string,
      options?: { readonly spinning?: boolean },
    ) =>
      progress.update({
        label: nextLabel,
        detail: nextDetail,
        title: title === undefined ? undefined : `${nextLabel} · ${title}`,
        spinning: options?.spinning ?? true,
      }),
    succeed: (message?: string) =>
      finish(Effect.flatMap(settled(message), progress.succeed)),
    fail: (message?: string) =>
      finish(Effect.flatMap(settled(message), progress.fail)),
    close: finish(progress.close),
  };
});

const startApplySession = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
  options?: import("../../../Report.ts").PlanDisplayOptions,
) {
  // Detailed applies render their YAML diffs inline in the progress tree;
  // persistOnClose keeps the final full render (diffs included) in
  // scrollback, covering --yes deployments too.
  const progress = new PlanViewStore(plan, { detailed: options?.detailed });
  // The session outlives this effect — the caller settles it via `done` on
  // every exit path (Apply.ts's onExit). live.open is Scope-bound, so give
  // it a manually managed scope that `done` closes; Apply deliberately runs
  // the session in the ambient scope, so we cannot lean on Effect.scoped
  // here.
  const scope = yield* Scope.make();
  const live = yield* cli.live
    .open(
      <PlanView
        store={progress}
        mode="apply"
        detailed={options?.detailed}
        stage={options?.stage}
      />,
      { persistOnClose: true },
    )
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

import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

class ScheduledTask extends Context.Service<
  ScheduledTask,
  { run: Effect.Effect<void, never, RuntimeContext> }
>()("test/ScheduledTask") {}

const ScheduleExpression = "* * * * *";

const runScheduledTask = Effect.fn("ScheduledWorker.runTask")(function* () {
  const task = yield* ScheduledTask;
  yield* task.run;
});

export const ScheduledTaskCronBinding = Cloudflare.Workers.cron(
  ScheduleExpression,
  Effect.fn("ScheduledWorker.cron")(function* () {
    yield* runScheduledTask();
  }),
);

type RequirementsOf<T> = T extends Effect.Effect<unknown, unknown, infer Req> ? Req : never;
type Assert<T extends true> = T;

type _PreservesUserRequirement = Assert<
  ScheduledTask extends RequirementsOf<typeof ScheduledTaskCronBinding> ? true : false
>;
type _StillRequiresCronEventSource = Assert<
  Cloudflare.Workers.CronEventSource extends RequirementsOf<typeof ScheduledTaskCronBinding>
    ? true
    : false
>;
type _HidesRuntimeContext = Assert<
  RuntimeContext extends RequirementsOf<typeof ScheduledTaskCronBinding> ? false : true
>;

// The bridge gives every event its own `Scope`, so a handler may use
// `Effect.addFinalizer` without the Worker's init needing a `Scope`.
export const ScopedCronBinding = Cloudflare.Workers.cron(ScheduleExpression, () =>
  Effect.addFinalizer(() => Effect.void),
);

type _HidesScope = Assert<
  Scope.Scope extends RequirementsOf<typeof ScopedCronBinding> ? false : true
>;

export const ScopedEmailBinding = Cloudflare.email().subscribe(() =>
  Effect.addFinalizer(() => Effect.void),
);

type _EmailHidesScope = Assert<
  Scope.Scope extends RequirementsOf<typeof ScopedEmailBinding> ? false : true
>;

export const EmailTaskBinding = Cloudflare.email().subscribe(() => runScheduledTask());

type _EmailPreservesUserRequirement = Assert<
  ScheduledTask extends RequirementsOf<typeof EmailTaskBinding> ? true : false
>;

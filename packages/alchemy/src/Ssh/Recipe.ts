import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Client, type ClientShape } from "./Client.ts";
import type { ExecError } from "./Errors.ts";

export type Mode = "apply" | "check";

export type Json = Record<string, unknown>;

/**
 * What a step's read-only `check` found: converged (with the step's output),
 * or diverged, with the current and desired state a dry run reports.
 */
export type Check<Out> =
  | { readonly converged: true; readonly output: Out }
  | {
      readonly converged: false;
      readonly current: Json;
      readonly desired: Json;
    };

export const converged = <Out>(output: Out): Check<Out> => ({
  converged: true,
  output,
});

export const diverged = (current: Json, desired: Json): Check<never> => ({
  converged: false,
  current,
  desired,
});

/** What `apply` did. `Skipped` means it decided no change was needed. */
export type Outcome<Out> =
  | { readonly _tag: "Applied"; readonly output: Out }
  | { readonly _tag: "Skipped"; readonly output: Out };

export const applied = <Out>(output: Out): Outcome<Out> => ({
  _tag: "Applied",
  output,
});

export const skipped = <Out>(output: Out): Outcome<Out> => ({
  _tag: "Skipped",
  output,
});

/** A command exited non-zero, or the host's state could not be read. */
export class StepFailed extends Data.TaggedError("Ssh.StepFailed")<{
  message: string;
  kind: string;
  /** The step's name (`name` itself is `Error.name`). */
  step: string;
  command?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
}> {}

export class StepTimeout extends Data.TaggedError("Ssh.StepTimeout")<{
  message: string;
  kind: string;
  step: string;
  phase: "check" | "apply";
  timeout: string;
}> {}

/** The vars did not decode against the recipe's schema. */
export class VarsInvalid extends Data.TaggedError("Ssh.VarsInvalid")<{
  message: string;
  recipe: string;
}> {}

export class HandlerUnknown extends Data.TaggedError("Ssh.HandlerUnknown")<{
  message: string;
  handler: string;
  step: string;
}> {}

export type StepError = StepFailed | StepTimeout | ExecError;

export interface StepPolicy {
  /** Per phase. */
  timeout?: Duration.Input;
  /** Extra `check` attempts after a lost session. @default 2 */
  retries?: number;
}

/**
 * One idempotent operation. `check` is read-only and decides whether the host
 * already matches; `apply` converges it, after which `check` must report
 * converged.
 */
export interface Step<Out> {
  readonly kind: string;
  readonly name: string;
  readonly check: Effect.Effect<Check<Out>, StepError, Client>;
  readonly apply: Effect.Effect<Outcome<Out>, StepError, Client>;
  readonly notify?: ReadonlyArray<string>;
  readonly policy?: StepPolicy;
  /**
   * Re-run `check` after `apply` and fail when the host still diverges. Off
   * for imperative steps, whose `check` diverges by design.
   * @default true
   */
  readonly verify?: boolean;
}

export type StepStatus = "ok" | "changed" | "wouldChange";

export interface StepReport {
  readonly kind: string;
  readonly name: string;
  readonly status: StepStatus;
  readonly durationMs: number;
  readonly diff?: { readonly current: Json; readonly desired: Json };
}

export interface StepResult<Out> {
  readonly status: StepStatus;
  readonly changed: boolean;
  /** Absent after a dry-run `wouldChange`. */
  readonly output: Out | undefined;
}

export interface Facts {
  readonly distroId: string;
  readonly distroVersion: string;
  readonly arch: string;
  readonly initSystem: "systemd" | undefined;
  readonly pkgManager: "apt" | "dnf" | undefined;
}

export interface RunContextShape {
  readonly mode: Mode;
  readonly facts: Effect.Effect<Facts, ExecError>;
  readonly report: (report: StepReport) => Effect.Effect<void>;
  readonly notify: (
    handlers: ReadonlyArray<string>,
    step: string,
  ) => Effect.Effect<void, HandlerUnknown>;
  /** Run every handler notified so far, once each, in declaration order. */
  readonly flush: Effect.Effect<void, StepError | HandlerUnknown>;
}

export class RunContext extends Context.Service<RunContext, RunContextShape>()(
  "Ssh.RunContext",
) {}

const probeFacts = Effect.fn("Ssh.facts")(function* (
  client: Pick<ClientShape, "exec">,
) {
  const { stdout } = yield* client.exec(
    [
      ". /etc/os-release 2>/dev/null",
      'printf "%s\\n%s\\n" "$ID" "$VERSION_ID"',
      "uname -m",
      "command -v systemctl >/dev/null 2>&1 && echo systemd || echo -",
      "if command -v apt-get >/dev/null 2>&1; then echo apt; elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then echo dnf; else echo -; fi",
    ].join("; "),
  );
  const [distroId = "", distroVersion = "", arch = "", init = "", pkg = ""] =
    stdout.trim().split("\n");
  return {
    distroId,
    distroVersion,
    arch,
    initSystem: init === "systemd" ? "systemd" : undefined,
    pkgManager: pkg === "apt" || pkg === "dnf" ? pkg : undefined,
  } satisfies Facts;
});

const withTimeout = <A, E, R>(
  step: Step<unknown>,
  phase: "check" | "apply",
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StepTimeout, R> => {
  const timeout = step.policy?.timeout;
  if (timeout === undefined) return self;
  const formatted = Duration.format(Duration.fromInputUnsafe(timeout));
  return self.pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new StepTimeout({
            message: `${step.kind}[${step.name}] ${phase} did not finish within ${formatted}`,
            kind: step.kind,
            step: step.name,
            phase,
            timeout: formatted,
          }),
        ),
    }),
  );
};

const redactDeep = (redact: (value: string) => string, value: unknown): any =>
  typeof value === "string"
    ? redact(value)
    : Array.isArray(value)
      ? value.map((entry) => redactDeep(redact, entry))
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
              key,
              redactDeep(redact, entry),
            ]),
          )
        : value;

const redactError = <E extends { readonly _tag: string }>(
  redact: (value: string) => string,
  error: E,
): E =>
  error instanceof StepFailed
    ? (new StepFailed({
        message: redact(error.message),
        kind: error.kind,
        step: redact(error.step),
        command: error.command && redact(error.command),
        code: error.code,
        stdout: error.stdout && redact(error.stdout),
        stderr: error.stderr && redact(error.stderr),
      }) as unknown as E)
    : error;

/**
 * Run one step: `check`, then `apply` if the host diverged and the run is not
 * a dry run. Only `check` is retried on a lost session: a session lost during
 * `apply` may leave the command running on the host, so running it again
 * could start a second copy.
 */
export const execute = <Out>(
  step: Step<Out>,
): Effect.Effect<
  StepResult<Out>,
  StepError | HandlerUnknown,
  Client | RunContext
> =>
  Effect.gen(function* () {
    const ctx = yield* RunContext;
    const { redact } = yield* Client;
    const name = redact(step.name);
    const label = `${step.kind}[${name}]`;
    const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const report = (
      status: StepStatus,
      diff?: Check<Out> & { converged: false },
    ) =>
      Effect.gen(function* () {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        yield* ctx.report({
          kind: step.kind,
          name,
          status,
          durationMs: now - started,
          ...(diff === undefined
            ? {}
            : {
                diff: {
                  current: redactDeep(redact, diff.current),
                  desired: redactDeep(redact, diff.desired),
                },
              }),
        });
      });
    const check = withTimeout(step, "check", step.check).pipe(
      Effect.retry({
        while: (error) => error._tag === "Ssh.ConnectionLost",
        schedule: Schedule.exponential("1 second").pipe(
          Schedule.jittered,
          Schedule.upTo({ times: step.policy?.retries ?? 2 }),
        ),
      }),
    );

    const run = Effect.gen(function* () {
      const before = yield* check;
      if (before.converged) {
        yield* report("ok");
        return { status: "ok", changed: false, output: before.output } as const;
      }
      if (ctx.mode === "check") {
        yield* report("wouldChange", before);
        if (step.notify?.length) yield* ctx.notify(step.notify, label);
        return {
          status: "wouldChange",
          changed: true,
          output: undefined,
        } as const;
      }
      const outcome = yield* withTimeout(step, "apply", step.apply);
      if (outcome._tag === "Skipped") {
        yield* report("ok");
        return {
          status: "ok",
          changed: false,
          output: outcome.output,
        } as const;
      }
      if (step.verify !== false) {
        const after = yield* check;
        if (!after.converged) {
          return yield* new StepFailed({
            message: `${label} still diverges after apply: ${JSON.stringify(after.current)} → ${JSON.stringify(after.desired)}`,
            kind: step.kind,
            step: step.name,
          });
        }
      }
      yield* report("changed", before);
      if (step.notify?.length) yield* ctx.notify(step.notify, label);
      return {
        status: "changed",
        changed: true,
        output: outcome.output,
      } as const;
    });

    return yield* run.pipe(
      Effect.mapError((error) => redactError(redact, error)),
    );
  }).pipe(Effect.withSpan(`Ssh.step.${step.kind}`));

export type Handler = Effect.Effect<
  unknown,
  StepError | HandlerUnknown,
  Client | RunContext
>;

/** A vars schema that decodes without services. */
export type VarsSchema = Schema.Top & { readonly DecodingServices: never };

export interface RecipeDefinition<S extends VarsSchema> {
  /** The recipe module's URL: always `import.meta.url`. */
  readonly main: string;
  /** Unique within its module. */
  readonly name: string;
  readonly vars: S;
  /**
   * Run once each, in declaration order, when notified by a changed step. A
   * function receives the decoded vars.
   */
  readonly handlers?:
    | Record<string, Handler>
    | ((vars: S["Type"]) => Record<string, Handler>);
  readonly run: (
    vars: S["Type"],
  ) => Effect.Effect<void, StepError | HandlerUnknown, Client | RunContext>;
}

/**
 * A recipe is code, not state: as a class instance it is passed through
 * props untouched and never persisted. `Ssh.Provision` records its `name` and
 * module path to load it again for a dry run.
 */
export class Recipe<S extends VarsSchema> {
  readonly _tag = "Ssh.Recipe";
  constructor(readonly definition: RecipeDefinition<S>) {}
  get name() {
    return this.definition.name;
  }
  get main() {
    return this.definition.main;
  }
}

/**
 * Define a recipe in its own module and export it.
 *
 * @example
 * export const Web = Ssh.make({ main: import.meta.url, name: "web", vars, run });
 */
export const make = <S extends VarsSchema>(
  definition: RecipeDefinition<S>,
): Recipe<S> => new Recipe(definition);

export const isRecipe = (value: unknown): value is Recipe<VarsSchema> =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "Ssh.Recipe";

export interface RunSummary {
  readonly steps: ReadonlyArray<StepReport>;
  readonly ok: number;
  readonly changed: number;
  /** Steps (and handlers) a dry run found would change, as `kind[name]`. */
  readonly pending: ReadonlyArray<string>;
}

export interface RunOptions {
  readonly client: ClientShape;
  readonly mode: Mode;
  readonly vars: unknown;
  /** Called as each step finishes. */
  readonly onReport?: (report: StepReport) => Effect.Effect<void>;
}

export type RunError = VarsInvalid | HandlerUnknown | StepError;

/**
 * Decode the vars, run the recipe against the client, flush the notified
 * handlers, and summarise. In `check` mode notified handlers are reported as
 * pending instead of run.
 */
export const run = <S extends VarsSchema>(
  { definition: recipe }: Recipe<S>,
  options: RunOptions,
): Effect.Effect<RunSummary, RunError> =>
  Effect.gen(function* () {
    const vars = yield* Schema.decodeUnknownEffect(recipe.vars)(
      options.vars,
    ).pipe(
      Effect.mapError(
        (error) =>
          new VarsInvalid({
            message: `vars for recipe ${recipe.name} do not match its schema: ${error.message}`,
            recipe: recipe.name,
          }),
      ),
    );
    const reports = yield* Ref.make<ReadonlyArray<StepReport>>([]);
    const queued = yield* Ref.make<ReadonlyArray<string>>([]);
    const handlers =
      typeof recipe.handlers === "function"
        ? recipe.handlers(vars)
        : (recipe.handlers ?? {});
    const facts = yield* Effect.cached(probeFacts(options.client));

    const report = (entry: StepReport) =>
      Ref.update(reports, (all) => [...all, entry]).pipe(
        Effect.andThen(options.onReport?.(entry) ?? Effect.void),
      );

    const flush = Effect.gen(function* () {
      const names = yield* Ref.getAndSet(queued, []);
      for (const [name, handler] of Object.entries(handlers)) {
        if (!names.includes(name)) continue;
        if (options.mode === "check") {
          yield* report({
            kind: "handler",
            name,
            status: "wouldChange",
            durationMs: 0,
          });
        } else {
          yield* handler.pipe(
            Effect.withSpan("Ssh.handler", { attributes: { handler: name } }),
          );
        }
      }
    });

    const provide = <A, E>(
      self: Effect.Effect<A, E, Client | RunContext>,
    ): Effect.Effect<A, E> =>
      self.pipe(
        Effect.provideService(Client, options.client),
        Effect.provideService(RunContext, context),
      );

    const context: RunContextShape = {
      mode: options.mode,
      facts,
      report,
      notify: (names, step) =>
        Effect.forEach(names, (name) =>
          name in handlers
            ? Ref.update(queued, (all) =>
                all.includes(name) ? all : [...all, name],
              )
            : Effect.fail(
                new HandlerUnknown({
                  message: `${step} notifies handler "${name}", which recipe ${recipe.name} does not declare`,
                  handler: name,
                  step,
                }),
              ),
        ).pipe(Effect.asVoid),
      flush: Effect.suspend(() => provide(flush)),
    };

    yield* provide(recipe.run(vars).pipe(Effect.andThen(flush)));

    const steps = yield* Ref.get(reports);
    return {
      steps,
      ok: steps.filter((step) => step.status === "ok").length,
      changed: steps.filter((step) => step.status === "changed").length,
      pending: steps
        .filter((step) => step.status === "wouldChange")
        .map((step) => `${step.kind}[${step.name}]`),
    };
  }).pipe(
    Effect.withSpan("Ssh.recipe", {
      attributes: { recipe: recipe.name, mode: options.mode },
    }),
  );

/** Run the handlers notified so far, now. Ansible's `flush_handlers`. */
export const flushHandlers: Effect.Effect<
  void,
  StepError | HandlerUnknown,
  RunContext
> = Effect.flatMap(RunContext, (ctx) => ctx.flush);

/** The host's facts, probed once per run. */
export const facts: Effect.Effect<Facts, ExecError, RunContext> =
  Effect.flatMap(RunContext, (ctx) => ctx.facts);

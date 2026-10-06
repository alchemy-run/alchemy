import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Semaphore from "effect/Semaphore";
import * as Interaction from "../Interaction.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { GitHubBrowser, type GitHubBrowserError } from "./Browser.ts";

/** A GitHub App step that has no API and must be done in the browser. */
export type ManualStep = "register-app" | "delete-app" | "install-app";

const rerun = (step: ManualStep) =>
  step === "delete-app" ? "destroy" : "deploy";

/** Bounds every wait for a human to finish a {@link ManualStep}. */
export const ManualStepTimeout = Context.Reference<Duration.Input>(
  "GitHub::ManualStepTimeout",
  { defaultValue: () => "10 minutes" },
);

/** A manual step was needed, but no interactive terminal is attached. */
export class GitHubManualStepRequired extends Data.TaggedError(
  "GitHubManualStepRequired",
)<{
  readonly step: ManualStep;
  readonly url: string;
  readonly action: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return this.step === "register-app"
      ? `GitHub has no API to ${this.action}. Run deploy in an interactive terminal and alchemy opens the page for you.`
      : `GitHub has no API to ${this.action}. Do it in your browser, then run ${rerun(this.step)} again: ${this.url}`;
  }
}

/** Nobody finished a manual step within {@link ManualStepTimeout}. */
export class GitHubManualStepTimeout extends Data.TaggedError(
  "GitHubManualStepTimeout",
)<{
  readonly step: ManualStep;
  readonly url: string;
  readonly action: string;
  readonly after: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    const waited = `Waited ${this.after} for you to ${this.action}.`;
    return this.step === "register-app"
      ? `${waited} Run deploy again to restart it.`
      : `${waited} Do it in your browser, then run ${rerun(this.step)} again: ${this.url}`;
  }
}

// Apply runs resources concurrently; one permit keeps two apps from
// prompting the human at once.
const permit = Semaphore.makeUnsafe(1);

/** Serialize an effect that talks to the human with every other manual step. */
export const oneAtATime = permit.withPermits(1);

/** Repeat `probe` every few seconds until it yields a value. */
export const pollUntilDefined = <A, E, R>(
  probe: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    while (true) {
      const value = yield* probe;
      if (value !== undefined) return value;
      yield* Effect.sleep("3 seconds");
    }
  });

/**
 * Run `automate` when a {@link GitHubBrowser} session is in context, else
 * yield `None` without running anything. Lets a resource repair UI-only
 * drift when it can and report it when it cannot.
 */
export const withBrowser = <A, E, R>(
  automate: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, Exclude<R, GitHubBrowser>> =>
  Effect.serviceOption(GitHubBrowser).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<A>()),
        onSome: (browser) =>
          Effect.provideService(automate, GitHubBrowser, browser).pipe(
            Effect.map(Option.some),
          ),
      }),
    ),
  );

/**
 * Do `step` in the browser. With a {@link GitHubBrowser} session in context,
 * `automate` drives the page and `until` confirms the result from the API,
 * without any prompt; an automation failure fails the step. Otherwise ask
 * the human: open `open` (default `url`) and race `until` against the
 * waiting prompt. The prompt is raised first so that without a terminal
 * the step fails at once, before any browser opens. Either way the step is
 * bounded by {@link ManualStepTimeout}.
 */
export const manualStep = <A, E, R>(options: {
  readonly step: ManualStep;
  readonly url: string;
  readonly open?: string;
  /** Lowercase verb phrase, e.g. `create GitHub App my-app`. */
  readonly action: string;
  /** What to click on the opened page, e.g. `Click "Create GitHub App"`. */
  readonly instruction: string;
  readonly until: Effect.Effect<A, E, R>;
  readonly automate: Effect.Effect<void, GitHubBrowserError, GitHubBrowser>;
}) =>
  oneAtATime(
    Effect.gen(function* () {
      const { step, url, action } = options;
      const open = options.open ?? url;
      const timeout = yield* ManualStepTimeout;
      const timedOut = () =>
        Effect.fail(
          new GitHubManualStepTimeout({
            step,
            url,
            action,
            after: Duration.format(Duration.fromInputUnsafe(timeout)),
          }),
        );
      const browser = yield* Effect.serviceOption(GitHubBrowser);
      if (Option.isSome(browser)) {
        return yield* Effect.provideService(
          options.automate,
          GitHubBrowser,
          browser.value,
        ).pipe(
          Effect.andThen(options.until),
          Effect.timeoutOrElse({ duration: timeout, orElse: timedOut }),
        );
      }
      const interaction = yield* Interaction.Interaction;
      // Invoked later by the prompt's keyboard handler, outside this fiber.
      const reopen = Effect.runPromiseWith(
        yield* Effect.context<ChildProcessSpawner>(),
      );
      return yield* Effect.raceFirst(
        interaction.prompt
          .awaitExternal({
            message: `${action[0]!.toUpperCase()}${action.slice(1)} in your browser`,
            waitingLabel: `GitHub has no API for this. ${options.instruction} on the page below; alchemy continues once it's done.`,
            url: open,
            allowManualInput: false,
            onOpen: () => reopen(Interaction.openUrl(open).pipe(Effect.ignore)),
          })
          .pipe(
            Effect.catchTag("NonInteractiveTerminal", () =>
              Effect.fail(new GitHubManualStepRequired({ step, url, action })),
            ),
            Effect.andThen(Effect.never),
          ),
        Interaction.openUrl(open).pipe(
          Effect.ignore,
          Effect.andThen(options.until),
        ),
      ).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: timedOut }));
    }),
  );

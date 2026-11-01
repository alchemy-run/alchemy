import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * A STACKIT resource did not reach the awaited state within its time budget.
 * Raised by {@link waitFor}; never a defect, so the engine reports it as a
 * failed operation and the next deploy resumes.
 */
export class StackitWaitTimeout extends Data.TaggedError("Stackit.WaitTimeout")<{
  readonly resource: string;
  readonly budget: string;
  readonly lastState: string | undefined;
  readonly message: string;
}> {}

/**
 * A STACKIT resource reported a terminal failure state (e.g.
 * `CREATE_FAILED`, `ERROR`) while {@link waitFor} was waiting for it.
 */
export class StackitResourceFailed extends Data.TaggedError("Stackit.ResourceFailed")<{
  readonly resource: string;
  readonly state: string | undefined;
  readonly message: string;
}> {}

export interface WaitForOptions<A, E, R> {
  /** What is waited on, for error messages (e.g. `DNS zone example.com`). */
  readonly resource: string;
  /** Read the current status. Called once per poll. */
  readonly read: Effect.Effect<A, E, R>;
  /** The status is the awaited one; {@link waitFor} returns it. */
  readonly ready: (status: A) => boolean;
  /**
   * The status is terminal and will never become ready. Return a reason
   * (or `true`) to fail with {@link StackitResourceFailed}; return
   * `undefined`/`false` to keep polling.
   */
  readonly failed?: (status: A) => string | boolean | undefined;
  /** A short label of the status for errors and logs (e.g. `s.state`). */
  readonly state?: (status: A) => string | undefined;
  /**
   * Total time budget. Choose it per resource from the documented
   * provisioning time: seconds for DNS records, minutes for networks,
   * servers and databases.
   */
  readonly timeout: Duration.Input;
  /** First delay between polls; grows ×1.5 up to {@link maxInterval}. @default "1 second" */
  readonly interval?: Duration.Input;
  /** Longest delay between polls. @default "10 seconds" */
  readonly maxInterval?: Duration.Input;
}

/**
 * The one readiness poller for every STACKIT resource.
 *
 * Polls `read` until `ready` holds, failing with
 * {@link StackitResourceFailed} when `failed` reports a terminal state, or
 * with {@link StackitWaitTimeout} once `timeout` has elapsed. Errors from
 * `read` propagate unchanged (handle typed tags such as `NotFound` inside
 * `read` when "not visible yet" is expected).
 *
 * ```ts
 * const zone = yield* waitFor({
 *   resource: `DNS zone ${name}`,
 *   read: dns.getZone({ projectId, zoneId }).pipe(Effect.map((r) => r.zone)),
 *   ready: (z) => z.state === "CREATE_SUCCEEDED" || z.state === "UPDATE_SUCCEEDED",
 *   failed: (z) => (z.state?.endsWith("_FAILED") ? z.state : undefined),
 *   state: (z) => z.state,
 *   timeout: "5 minutes",
 * });
 * ```
 */
export const waitFor = <A, E, R>(
  options: WaitForOptions<A, E, R>,
): Effect.Effect<A, E | StackitWaitTimeout | StackitResourceFailed, R> => {
  const first = Duration.fromInputUnsafe(options.interval ?? "1 second");
  const max = Duration.fromInputUnsafe(options.maxInterval ?? "10 seconds");
  const budget = Duration.fromInputUnsafe(options.timeout);
  let lastState: string | undefined;

  const poll = (delay: Duration.Duration): Effect.Effect<A, E | StackitResourceFailed, R> =>
    Effect.gen(function* () {
      const status = yield* options.read;
      lastState = options.state?.(status);
      const reason = options.failed?.(status);
      if (reason !== undefined && reason !== false) {
        return yield* new StackitResourceFailed({
          resource: options.resource,
          state: lastState,
          message:
            typeof reason === "string" && reason !== ""
              ? `${options.resource} failed: ${reason}`
              : `${options.resource} entered terminal state ${lastState ?? "(unknown)"}`,
        });
      }
      if (options.ready(status)) return status;
      yield* Effect.sleep(delay);
      return yield* poll(Duration.min(Duration.times(delay, 1.5), max));
    });

  return poll(first).pipe(
    Effect.timeoutOption(budget),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(
            new StackitWaitTimeout({
              resource: options.resource,
              budget: Duration.format(budget),
              lastState,
              message: `Timed out after ${Duration.format(budget)} waiting for ${options.resource}${
                lastState === undefined ? "" : ` (last state: ${lastState})`
              }`,
            }),
          ),
    ),
  );
};

/**
 * Wait until a resource is gone. `read` returns `undefined` once the
 * resource no longer exists (catch the operation's typed `NotFound` inside
 * `read`). Use after an asynchronous delete so dependants and replacements
 * don't race the deletion.
 */
export const waitUntilGone = <A, E, R>(options: {
  readonly resource: string;
  readonly read: Effect.Effect<A | undefined, E, R>;
  readonly state?: (status: A) => string | undefined;
  readonly failed?: (status: A) => string | boolean | undefined;
  readonly timeout: Duration.Input;
  readonly interval?: Duration.Input;
  readonly maxInterval?: Duration.Input;
}): Effect.Effect<void, E | StackitWaitTimeout | StackitResourceFailed, R> =>
  waitFor<A | undefined, E, R>({
    resource: options.resource,
    read: options.read,
    ready: (status) => status === undefined,
    failed: (status) => (status === undefined ? undefined : options.failed?.(status)),
    state: (status) => (status === undefined ? "gone" : options.state?.(status)),
    timeout: options.timeout,
    interval: options.interval,
    maxInterval: options.maxInterval,
  }).pipe(Effect.asVoid);

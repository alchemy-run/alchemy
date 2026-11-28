import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { RenderPollConfig, type PollConfig } from "../Credentials.ts";
import { RenderOperationTimeoutError } from "../Errors.ts";

const DEFAULT_POLL_CONFIG: PollConfig = {
  intervalMs: 2_000,
  maxAttempts: 45,
};

export const pollUntil = <A, E, R, EFail = never>(options: {
  readonly operation: string;
  readonly resourceId: string;
  readonly check: Effect.Effect<A, E, R>;
  readonly isDone: (value: A) => boolean;
  readonly failIf?: (value: A) => EFail | undefined;
  readonly statusOf?: (value: A) => string | undefined;
}): Effect.Effect<A, E | EFail | RenderOperationTimeoutError, R> =>
  Effect.gen(function* () {
    const configOption = yield* Effect.serviceOption(RenderPollConfig);
    const config = Option.getOrElse(configOption, () => DEFAULT_POLL_CONFIG);
    const maxAttempts = Math.max(1, config.maxAttempts);

    let lastStatus: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const current = yield* options.check;
      lastStatus = options.statusOf?.(current);
      if (options.failIf) {
        const failure = options.failIf(current);
        if (failure !== undefined) {
          return yield* Effect.fail(failure);
        }
      }
      if (options.isDone(current)) {
        return current;
      }
      if (attempt < maxAttempts) {
        yield* Effect.sleep(Duration.millis(config.intervalMs));
      }
    }

    return yield* new RenderOperationTimeoutError({
      operation: options.operation,
      resourceId: options.resourceId,
      attempts: maxAttempts,
      lastStatus,
      message: `Timed out waiting for ${options.operation} on ${options.resourceId} after ${maxAttempts} checks${lastStatus ? ` (last status: ${lastStatus})` : ""}`,
    });
  });

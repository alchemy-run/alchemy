import type * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { ScopedPlanStatusSession } from "../../Report.ts";
import {
  ContainerImagePreparationError,
  imagePreparationTimeoutMillis,
} from "./ContainerConfiguration.ts";

/** Wait for Cloudflare preparation, with an interruptible deadline including API calls. */
export const waitForContainerImage = <E, R>(options: {
  image: string;
  name: string;
  timeout?: Duration.Input;
  prepare: Effect.Effect<Containers.PrepareContainerImageResponse, E, R>;
  session: Pick<ScopedPlanStatusSession, "note">;
}) =>
  Effect.gen(function* () {
    const timeout = yield* imagePreparationTimeoutMillis(options.timeout);
    const started = yield* Clock.currentTimeMillis;
    const elapsed = (now: number) => {
      const seconds = Math.floor((now - started) / 1000);
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    };
    yield* options.session.note(`Preparing ${options.name} image… 0m 0s`, { kind: "status" });
    yield* Effect.gen(function* () {
      while (true) {
        const result = yield* options.prepare;
        const time = elapsed(yield* Clock.currentTimeMillis);
        if (result.status === "ready") {
          yield* options.session.note(`Prepared ${options.name} image (${time}).`, {
            kind: "status",
          });
          return;
        }
        if (result.status === "error") {
          return yield* new ContainerImagePreparationError({
            image: options.image,
            status: "error",
            message: result.reason ?? `Cloudflare could not prepare image '${options.name}'.`,
          });
        }
        yield* options.session.note(`Preparing ${options.name} image… ${time}`, { kind: "status" });
        yield* Effect.sleep("5 seconds");
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new ContainerImagePreparationError({
              image: options.image,
              status: "pending",
              message: `Image '${options.name}' (${options.image}) was not ready within ${timeout / 60000} minutes. Deploy again to resume from the published image, or increase imagePreparationTimeout.`,
            }),
          ),
      }),
    );
  });

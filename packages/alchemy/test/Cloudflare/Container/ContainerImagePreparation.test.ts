import { describe, expect, it } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { validateContainerConfiguration } from "@/Cloudflare/Containers/ContainerConfiguration.ts";
import { waitForContainerImage } from "@/Cloudflare/Containers/ContainerImagePreparation.ts";
import type { NoteKind } from "@/Report.ts";

const image = "registry.cloudflare.com/account/shell@sha256:digest";
const fixture = () => {
  const notes: { message: string; kind?: NoteKind }[] = [];
  return {
    notes,
    session: {
      note: (message: string, options?: { kind?: NoteKind }) =>
        Effect.sync(() => {
          notes.push({ message, kind: options?.kind });
        }),
    },
  };
};
describe(
  "container image preparation",
  { tags: ["unit", "local", "provider:cloudflare:container"] },
  () => {
    it.effect("waits for a large image and reports elapsed preparation time", () =>
      Effect.gen(function* () {
        const { notes, session } = fixture();
        const start = yield* Clock.currentTimeMillis;
        const prepare = Clock.currentTimeMillis.pipe(
          Effect.map((now) => ({
            image,
            status: now - start >= 17 * 60000 ? ("ready" as const) : ("pending" as const),
          })),
        );
        const fiber = yield* waitForContainerImage({ image, name: "shell", prepare, session }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("17 minutes");
        yield* Fiber.join(fiber);
        expect(notes.some((n) => n.message.includes("16m 55s"))).toBe(true);
        expect(notes.at(-1)?.message).toBe("Prepared shell image (17m 0s).");
        expect(notes.every((n) => n.kind === "status")).toBe(true);
      }),
    );
    it.effect("bounds pending preparation at the default thirty-minute deadline", () =>
      Effect.gen(function* () {
        const { session } = fixture();
        const fiber = yield* waitForContainerImage({
          image,
          name: "shell",
          prepare: Effect.succeed({ image, status: "pending" }),
          session,
        }).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("30 minutes");
        const error = yield* Fiber.join(fiber);
        expect(error._tag).toBe("ContainerImagePreparationError");
        expect(error.message).toContain("30 minutes");
        expect(error.message).toContain(image);
        expect(error.message).toContain("resume from the published image");
      }),
    );
    it.effect("applies a configured deadline to a stalled API call", () =>
      Effect.gen(function* () {
        const { session } = fixture();
        let interrupted = false;
        const prepare = Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        );
        const fiber = yield* waitForContainerImage({
          image,
          name: "shell",
          timeout: "10 seconds",
          prepare,
          session,
        }).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("ContainerImagePreparationError");
        expect(interrupted).toBe(true);
      }),
    );
    it.effect("fails immediately with Cloudflare's preparation reason", () =>
      Effect.gen(function* () {
        const { session } = fixture();
        let calls = 0;
        const error = yield* waitForContainerImage({
          image,
          name: "shell",
          session,
          prepare: Effect.sync(() => {
            calls++;
            return { image, status: "error" as const, reason: "unsupported image" };
          }),
        }).pipe(Effect.flip);
        expect(error.message).toBe("unsupported image");
        expect(calls).toBe(1);
      }),
    );
    it.effect("propagates API failures without polling them as pending", () =>
      Effect.gen(function* () {
        const { session } = fixture();
        const failure = new Error("unauthorized");
        expect(
          yield* waitForContainerImage({
            image,
            name: "shell",
            session,
            prepare: Effect.fail(failure),
          }).pipe(Effect.flip),
        ).toBe(failure);
      }),
    );
    it.effect("stops polling when deployment is cancelled", () =>
      Effect.gen(function* () {
        const { session } = fixture();
        let calls = 0;
        const fiber = yield* waitForContainerImage({
          image,
          name: "shell",
          session,
          prepare: Effect.sync(() => {
            calls++;
            return { image, status: "pending" as const };
          }),
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.interrupt(fiber);
        const stoppedAt = calls;
        yield* TestClock.adjust("1 minute");
        expect(calls).toBe(stoppedAt);
      }),
    );
    for (const timeout of [0, -1, Infinity, "Infinity", "nonsense"] as const) {
      it.effect(`rejects invalid deadline ${timeout} before publication`, () =>
        Effect.gen(function* () {
          const error = yield* validateContainerConfiguration({
            schedulingPolicy: "durable_object",
            imagePreparationTimeout: timeout as number,
          }).pipe(Effect.flip);
          expect(error.message).toContain("finite, positive duration");
        }),
      );
    }
  },
);

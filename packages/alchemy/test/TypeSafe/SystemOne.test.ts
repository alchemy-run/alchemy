import { RuntimeContext } from "@/RuntimeContext.ts";
import * as TypeSafe from "@/TypeSafe";
import { asChoice } from "@distilled.cloud/typesafe-ai";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/**
 * The binding against the REAL System One API — what a host gets when it
 * provides {@link TypeSafe.SystemOneHttp}: the key read from `Config`, the
 * client resolved ONCE, and judgments that need nothing provided per call.
 *
 * Gated on `TYPESAFE_API_KEY`; skips clean where the key is absent.
 */
describe.skipIf(!process.env.TYPESAFE_API_KEY)("TypeSafe.SystemOne", () => {
  it.live(
    "judges a state through the binding",
    () =>
      Effect.gen(function* () {
        const query = yield* TypeSafe.SystemOne;

        const verdict = yield* query(
          {
            disposition: TypeSafe.Choice("How should `message` be handled?", {
              inline: "A short question answerable in one message",
              thread: "Real work: investigation, code changes, many steps",
            }),
            urgent: TypeSafe.Noul("Does `message` convey time pressure?"),
          },
          {
            state: {
              channel: "engineering",
              message:
                "The dev worker OOMs importing the distilled repo — please " +
                "dig into the pack ingest path today, it blocks the demo.",
            },
          },
        );

        expect(verdict.value.disposition).toBe("thread");
        expect(verdict.value.urgent).toBe(true);

        const disposition = asChoice(verdict.answers.disposition);
        if (disposition === undefined) throw new Error("expected a choice");
        expect(disposition.confidence).toBeGreaterThan(0.5);
        const total = Object.values(disposition.probabilities).reduce(
          (sum: number, value) => sum + (value ?? 0),
          0,
        );
        expect(total).toBeCloseTo(1, 1);
      }).pipe(
        Effect.provide(RuntimeContext.phantom),
        Effect.provide(
          TypeSafe.SystemOneHttp.pipe(Layer.provide(FetchHttpClient.layer)),
        ),
      ),
    { timeout: 30_000 },
  );
});

import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Detector } from "./Detector.ts";

/**
 * The `detectorId` filter is injected by the binding from the bound detector;
 * the remaining filters (event id, event type, detector version, prediction
 * time range) and pagination controls are the caller's.
 */
export interface ListEventPredictionsRequest extends Omit<
  frauddetector.ListEventPredictionsRequest,
  "detectorId"
> {}

/**
 * List the past predictions made by a bound Amazon Fraud Detector detector —
 * the effectful search call made from a deployed Lambda or Task, e.g. to find
 * the `predictionTimestamp` needed by `GetEventPredictionMetadata`.
 *
 * ### Auditing Predictions
 * Provide the `ListEventPredictionsHttp` implementation layer on the Function
 * effect, bind the detector in the init phase, then call the returned client
 * at runtime. The binding grants `frauddetector:ListEventPredictions` (the
 * action supports no resource-level scoping) and filters results to the bound
 * detector automatically.
 *
 * **Example:** List from a Lambda
 * ```typescript
 * // init
 * const listEventPredictions =
 *   yield* FraudDetector.ListEventPredictions(detector);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { eventPredictionSummaries } = yield* listEventPredictions({
 *       eventId: { value: "order-123" },
 *     });
 *     return HttpServerResponse.json({
 *       predictions: eventPredictionSummaries ?? [],
 *     });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.ListEventPredictionsHttp))
 * ```
 *
 * @binding
 */
export interface ListEventPredictions extends Binding.Service<
  ListEventPredictions,
  "AWS.FraudDetector.ListEventPredictions",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request: ListEventPredictionsRequest,
    ) => Effect.Effect<
      frauddetector.ListEventPredictionsResult,
      frauddetector.ListEventPredictionsError
    >
  >
> {}
export const ListEventPredictions = Binding.Service<ListEventPredictions>(
  "AWS.FraudDetector.ListEventPredictions",
);

/**
 * Bespoke implementation — unlike the other detector-scoped operations, the
 * detector is a `FilterCondition` (`{ value }`) rather than a plain
 * `detectorId` field, and `frauddetector:ListEventPredictions` supports no
 * resource-level IAM scoping, so the grant is on `*`.
 */
export const ListEventPredictionsHttp = Layer.effect(
  ListEventPredictions,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(frauddetector.listEventPredictions);

    return Effect.fn(function* (detector: Detector) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const DetectorId = yield* detector.detectorId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.FraudDetector.ListEventPredictions(${detector})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["frauddetector:ListEventPredictions"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.FraudDetector.ListEventPredictions(${detector.LogicalId})`)(function* (
        request: Omit<frauddetector.ListEventPredictionsRequest, "detectorId">,
      ) {
        const detectorId = yield* DetectorId;
        return yield* op({ ...request, detectorId: { value: detectorId } });
      });
    });
  }),
);

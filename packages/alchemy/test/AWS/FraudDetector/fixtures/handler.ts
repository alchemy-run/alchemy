import * as FraudDetector from "@/AWS/FraudDetector";
import * as Lambda from "@/AWS/Lambda";
import * as Output from "@/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/** The email value the sample rule flags as high-risk. */
export const FRAUD_EMAIL = "fraud@example.com";
/** The outcome the sample rule returns on a match. */
export const REVIEW_OUTCOME = "alchemy_test_review";

export class FraudDetectorTestFunction extends Lambda.Function<Lambda.Function>()(
  "FraudDetectorTestFunction",
) {}

export default FraudDetectorTestFunction.make(
  {
    main,
    url: true,
    // getEventPrediction fans out over the detector's active version; give it
    // headroom over the 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Build the whole rule-based detector: entity type + variables + outcome +
    // event type + detector + an ACTIVE detector version with one rule. The
    // Output wiring (eventVariables/entityTypes/eventTypeName/detectorId/rule
    // outcomes) forces the deploy order EntityType/Variable/Outcome →
    // EventType → Detector → DetectorVersion.
    const customer = yield* FraudDetector.EntityType("Customer", {
      description: "the buyer placing an order",
    });
    const email = yield* FraudDetector.Variable("Email", {
      dataType: "STRING",
      dataSource: "EVENT",
      defaultValue: "unknown",
      variableType: "EMAIL_ADDRESS",
    });
    const ip = yield* FraudDetector.Variable("Ip", {
      dataType: "STRING",
      dataSource: "EVENT",
      defaultValue: "0.0.0.0",
      variableType: "IP_ADDRESS",
    });
    const review = yield* FraudDetector.Outcome("Review", {
      name: REVIEW_OUTCOME,
      description: "send the event to manual review",
    });
    const eventType = yield* FraudDetector.EventType("Purchase", {
      eventVariables: [email.name, ip.name],
      entityTypes: [customer.name],
      labels: [],
    });
    const detector = yield* FraudDetector.Detector("Checkout", {
      eventTypeName: eventType.name,
      description: "rule-based checkout fraud detector",
    });

    // Runtime needs the resolved names to build the prediction request. The
    // yields return Accessors that resolve to strings inside the handler.
    const emailVar = yield* email.name;
    const ipVar = yield* ip.name;
    const entityTypeName = yield* customer.name;
    const eventTypeName = yield* eventType.name;

    yield* FraudDetector.DetectorVersion("V1", {
      detectorId: detector.detectorId,
      status: "ACTIVE",
      ruleExecutionMode: "FIRST_MATCHED",
      rules: [
        {
          ruleId: "high_risk",
          expression: Output.map(
            email.name,
            (name) => `$${name} == "${FRAUD_EMAIL}"`,
          ),
          outcomes: [review.name],
          description: "flag a known-fraud email for review",
        },
      ],
    });

    const getEventPrediction =
      yield* FraudDetector.GetEventPrediction(detector);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/predict") {
          const body = (yield* request.json) as {
            email: string;
            ip?: string;
            entityId?: string;
          };
          const resolvedEventTypeName = yield* eventTypeName;
          const resolvedEntityTypeName = yield* entityTypeName;
          const emailVarName = yield* emailVar;
          const ipVarName = yield* ipVar;
          const result = yield* getEventPrediction({
            eventId: `evt-${Date.now()}`,
            eventTypeName: resolvedEventTypeName,
            eventTimestamp: new Date().toISOString(),
            entities: [
              {
                entityType: resolvedEntityTypeName,
                entityId: body.entityId ?? "cust-1",
              },
            ],
            eventVariables: {
              [emailVarName]: body.email,
              [ipVarName]: body.ip ?? "1.2.3.4",
            },
          });
          const outcomes = (result.ruleResults ?? []).flatMap(
            (r) => r.outcomes ?? [],
          );
          return yield* HttpServerResponse.json({
            outcomes,
            ruleResults: result.ruleResults ?? [],
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(FraudDetector.GetEventPredictionHttp)),
);

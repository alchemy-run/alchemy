import * as AWS from "@/AWS";
import { Detector, EventType, Variable } from "@/AWS/FraudDetector";
import * as Test from "@/Test/Vitest";
import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const ENTITY_TYPE = "alchemy_test_customer";
const EMAIL_VAR = "alchemy_test_email";
const IP_VAR = "alchemy_test_ip";
const EVENT_TYPE = "alchemy_test_purchase";
const DETECTOR_ID = "alchemy_test_checkout";

// Ungated typed-error probe: proves credentials reach Fraud Detector and the
// SDK decodes a typed error. In an entitled account the missing detector
// surfaces as ResourceNotFoundException; the standing test account has no
// frauddetector:* grant, so it surfaces as the shared AccessDeniedException.
// Either way the boundary is a typed tag — the full lifecycle below is gated.
test.provider("getDetectors on a nonexistent id fails with a typed error", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      frauddetector.getDetectors({ detectorId: "does_not_exist_detector" }),
    );
    expect(
      ["ResourceNotFoundException", "AccessDeniedException"].includes(
        error._tag,
      ),
    ).toBe(true);
  }),
);

// Fraud Detector variables, event types, and detectors are cheap metadata
// objects, but the standing test account has no frauddetector:* IAM grant, so
// the live lifecycle is gated behind AWS_TEST_ML=1 and runs unchanged in an
// entitled account. A prerequisite entity type is provisioned out-of-band (no
// EntityType resource in scope). Models, rules, and detector versions (which
// produce predictions) are out of scope.
test.provider.skipIf(!process.env.AWS_TEST_ML)(
  "create and destroy a variable, event type, and detector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Out-of-band prerequisite: the event type references an entity type.
      yield* frauddetector.putEntityType({ name: ENTITY_TYPE });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const email = yield* Variable("Email", {
            name: EMAIL_VAR,
            dataType: "STRING",
            dataSource: "EVENT",
            defaultValue: "unknown",
            variableType: "EMAIL_ADDRESS",
            tags: { Environment: "test" },
          });
          const ip = yield* Variable("Ip", {
            name: IP_VAR,
            dataType: "STRING",
            dataSource: "EVENT",
            defaultValue: "0.0.0.0",
            variableType: "IP_ADDRESS",
          });
          const eventType = yield* EventType("Purchase", {
            name: EVENT_TYPE,
            eventVariables: [email.name, ip.name],
            entityTypes: [ENTITY_TYPE],
            labels: [],
          });
          const detector = yield* Detector("Checkout", {
            detectorId: DETECTOR_ID,
            eventTypeName: eventType.name,
            description: "checkout fraud detector",
            tags: { Environment: "test" },
          });
          return { email, ip, eventType, detector };
        }),
      );

      expect(created.email.name).toBe(EMAIL_VAR);
      expect(created.email.arn).toContain(":variable/");
      expect(created.eventType.name).toBe(EVENT_TYPE);
      expect(created.detector.detectorId).toBe(DETECTOR_ID);
      expect(created.detector.eventTypeName).toBe(EVENT_TYPE);

      // Out-of-band verification via distilled.
      const variables = yield* frauddetector.getVariables({ name: EMAIL_VAR });
      expect(variables.variables?.[0]?.variableType).toBe("EMAIL_ADDRESS");
      expect(variables.variables?.[0]?.defaultValue).toBe("unknown");

      const eventTypes = yield* frauddetector.getEventTypes({
        name: EVENT_TYPE,
      });
      expect(eventTypes.eventTypes?.[0]?.eventVariables?.sort()).toEqual(
        [EMAIL_VAR, IP_VAR].sort(),
      );

      const detectors = yield* frauddetector.getDetectors({
        detectorId: DETECTOR_ID,
      });
      expect(detectors.detectors?.[0]?.eventTypeName).toBe(EVENT_TYPE);

      const detectorTags = yield* frauddetector.listTagsForResource({
        resourceARN: created.detector.arn,
      });
      expect(
        detectorTags.tags?.some(
          (t) => t.key === "alchemy::id" && t.value === "Checkout",
        ),
      ).toBe(true);

      // Update: change the variable default value and detector description
      // in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const email = yield* Variable("Email", {
            name: EMAIL_VAR,
            dataType: "STRING",
            dataSource: "EVENT",
            defaultValue: "none@example.com",
            variableType: "EMAIL_ADDRESS",
            tags: { Environment: "test" },
          });
          const ip = yield* Variable("Ip", {
            name: IP_VAR,
            dataType: "STRING",
            dataSource: "EVENT",
            defaultValue: "0.0.0.0",
            variableType: "IP_ADDRESS",
          });
          const eventType = yield* EventType("Purchase", {
            name: EVENT_TYPE,
            eventVariables: [email.name, ip.name],
            entityTypes: [ENTITY_TYPE],
            labels: [],
          });
          const detector = yield* Detector("Checkout", {
            detectorId: DETECTOR_ID,
            eventTypeName: eventType.name,
            description: "updated checkout fraud detector",
            tags: { Environment: "test" },
          });
          return { email, ip, eventType, detector };
        }),
      );
      expect(updated.email.arn).toBe(created.email.arn);
      expect(updated.detector.detectorId).toBe(DETECTOR_ID);

      const reVariables = yield* frauddetector.getVariables({
        name: EMAIL_VAR,
      });
      expect(reVariables.variables?.[0]?.defaultValue).toBe("none@example.com");
      const reDetectors = yield* frauddetector.getDetectors({
        detectorId: DETECTOR_ID,
      });
      expect(reDetectors.detectors?.[0]?.description).toBe(
        "updated checkout fraud detector",
      );

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();

      const goneDetector = yield* frauddetector
        .getDetectors({
          detectorId: DETECTOR_ID,
        })
        .pipe(
          Effect.map((r) => r.detectors ?? []),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed([]),
          ),
        );
      expect(goneDetector).toHaveLength(0);

      const goneVariables = yield* frauddetector
        .getVariables({
          name: EMAIL_VAR,
        })
        .pipe(
          Effect.map((r) => r.variables ?? []),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed([]),
          ),
        );
      expect(goneVariables).toHaveLength(0);

      // Clean up the out-of-band entity type prerequisite.
      yield* frauddetector
        .deleteEventType({ name: EVENT_TYPE })
        .pipe(Effect.catchTag("ValidationException", () => Effect.void));
      yield* frauddetector
        .deleteEntityType({ name: ENTITY_TYPE })
        .pipe(Effect.catchTag("ValidationException", () => Effect.void));
    }),
  { timeout: 300_000 },
);

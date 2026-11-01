import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as serviceEnablement from "@distilled.cloud/stackit/service_enablement";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// A service no other suite depends on, so toggling it cannot break a
// concurrent test. Every case toggles the same service, so they share an
// exclusive label and run one at a time.
const THROWAWAY_SERVICE = "cloud.stackit.model-experiments";
const options = {
  tags: stackitTags("serviceenablement", "service"),
  timeout: 420_000,
  exclusive: "stackit:service-enablement",
} as const;

const stateOf = (projectId: string, region: string, serviceId: string) =>
  serviceEnablement.getServiceStatusRegional({ projectId, region, serviceId }).pipe(
    Effect.map((status) => status.state),
    Effect.catchTag("NotFound", () => Effect.succeed("DISABLED" as const)),
  );

// Enabling and disabling are asynchronous and can take a few minutes.
const waitForState = (
  projectId: string,
  region: string,
  serviceId: string,
  state: serviceEnablement.ServiceStatusState,
) =>
  stateOf(projectId, region, serviceId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === state,
      times: 60,
    }),
  );

/** Out-of-band: put the throwaway service into `state` before a case runs. */
const setState = (
  projectId: string,
  region: string,
  serviceId: string,
  state: "ENABLED" | "DISABLED",
) =>
  Effect.gen(function* () {
    const current = yield* stateOf(projectId, region, serviceId);
    if (current === state) return;
    // Let an in-flight transition settle before flipping it.
    if (current === "ENABLING") yield* waitForState(projectId, region, serviceId, "ENABLED");
    if (current === "DISABLING") yield* waitForState(projectId, region, serviceId, "DISABLED");
    const settled = yield* stateOf(projectId, region, serviceId);
    if (settled === state) return;
    if (state === "ENABLED") {
      yield* serviceEnablement.enableServiceRegional({ projectId, region, serviceId });
    } else {
      yield* serviceEnablement.disableServiceRegional({ projectId, region, serviceId });
    }
    yield* waitForState(projectId, region, serviceId, state);
  });

test.provider(
  "enables a disabled service and disables it again on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      yield* setState(projectId, region, THROWAWAY_SERVICE, "DISABLED");

      const service = yield* stack.deploy(
        Stackit.ServiceEnablement.Service("Throwaway", { serviceId: THROWAWAY_SERVICE }),
      );

      expect(service.serviceId).toEqual(THROWAWAY_SERVICE);
      expect(service.projectId).toEqual(projectId);
      expect(service.region).toEqual(region);
      expect(service.state).toEqual("ENABLED");
      expect(service.enabledByAlchemy).toEqual(true);
      expect(service.disableOnDelete).toEqual(true);
      expect(yield* stateOf(projectId, region, THROWAWAY_SERVICE)).toEqual("ENABLED");

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        Stackit.ServiceEnablement.Service("Throwaway", { serviceId: THROWAWAY_SERVICE }),
      );
      expect(plan.resources.Throwaway).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      expect(yield* waitForState(projectId, region, THROWAWAY_SERVICE, "DISABLED")).toEqual(
        "DISABLED",
      );
    }).pipe(logLevel),
  options,
);

test.provider(
  "takes over an already-enabled service and leaves it enabled on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      yield* setState(projectId, region, THROWAWAY_SERVICE, "ENABLED");

      const service = yield* stack.deploy(
        Stackit.ServiceEnablement.Service("Throwaway", { serviceId: THROWAWAY_SERVICE }),
      );

      expect(service.state).toEqual("ENABLED");
      expect(service.enabledByAlchemy).toEqual(false);

      yield* stack.destroy();

      expect(yield* stateOf(projectId, region, THROWAWAY_SERVICE)).toEqual("ENABLED");
      yield* setState(projectId, region, THROWAWAY_SERVICE, "DISABLED");
    }).pipe(logLevel),
  options,
);

test.provider(
  "disableOnDelete: false keeps a service it enabled",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      yield* setState(projectId, region, THROWAWAY_SERVICE, "DISABLED");

      const enabled = yield* stack.deploy(
        Stackit.ServiceEnablement.Service("Throwaway", { serviceId: THROWAWAY_SERVICE }),
      );
      expect(enabled.enabledByAlchemy).toEqual(true);

      // Updating the flag keeps the recorded provenance.
      const kept = yield* stack.deploy(
        Stackit.ServiceEnablement.Service("Throwaway", {
          serviceId: THROWAWAY_SERVICE,
          disableOnDelete: false,
        }),
      );
      expect(kept.enabledByAlchemy).toEqual(true);
      expect(kept.disableOnDelete).toEqual(false);

      yield* stack.destroy();

      expect(yield* stateOf(projectId, region, THROWAWAY_SERVICE)).toEqual("ENABLED");
      yield* setState(projectId, region, THROWAWAY_SERVICE, "DISABLED");
    }).pipe(logLevel),
  options,
);

test.provider(
  "changing the service id replaces the resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const service = yield* stack.deploy(
        Stackit.ServiceEnablement.Service("Throwaway", { serviceId: THROWAWAY_SERVICE }),
      );
      const plan = yield* stack.plan(
        Stackit.ServiceEnablement.Service("Throwaway", { serviceId: "cloud.stackit.other" }),
      );
      expect(plan.resources.Throwaway).toMatchObject({ action: "replace" });
      expect(service.serviceId).toEqual(THROWAWAY_SERVICE);
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

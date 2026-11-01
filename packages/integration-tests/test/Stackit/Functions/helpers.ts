import { expect } from "@alchemy.run/test";
import * as functions from "@distilled.cloud/stackit/functions";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { noHarborIdentity } from "../ContainerRegistry/harbor.ts";

/**
 * STACKIT Functions is an alpha API and an account may not be entitled to it, so
 * lifecycles are gated. The probe in `Function.test.ts` always runs. Set
 * `STACKIT_TEST_FUNCTIONS=1` on an account the probe passes on.
 *
 * Consumption-billed with no published rate: not cost-gated. Recheck when a SKU
 * appears in the price list.
 */
export const noFunctions = !process.env.STACKIT_TEST_FUNCTIONS;

/** Functions built from `main` also need a registry login. */
export const noBuiltFunctions = noFunctions || noHarborIdentity;

/**
 * The image in STACKIT's Go SDK example (`examples/functions/functions.go`):
 * the only image known to fit the API's reference pattern.
 */
export const EXAMPLE_IMAGE = "ghcr.io/stackitcloud/example-image:0.1.0";

/** Bounded check that a function is gone, by its typed `NotFound`. */
export const expectFunctionGone = (projectId: string, functionId: string) =>
  functions.getFunction({ projectId, functionId }).pipe(
    Effect.as("present" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (state) => state === "gone",
      times: 20,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

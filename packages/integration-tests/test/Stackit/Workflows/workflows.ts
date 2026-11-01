import { expect } from "@alchemy.run/test";
import * as workflows from "@distilled.cloud/stackit/workflows";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Workflows suites.
 *
 * STACKIT bills per started hour. Its service certificate says fees per instance per hour, its
 * concepts page says a fixed monthly fee, and its price list (v1.0.44, read 2026-11-01) has no
 * Workflows row, so read the rate in the portal's order flow before a first run. Every suite that
 * creates an instance needs `STACKIT_TEST_SLOW`. A full run creates six instances, so at least six
 * instance-hours, plus the pods of the runs the bindings suite starts: four in the instance suite's
 * first three tests (a major version replacement takes two), one for its identity provider test,
 * and one in the bindings suite.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/**
 * An OAuth2 client of an identity provider of yours, which STACKIT Workflows needs for its REST API
 * (an external system, so an env var): the Workflows application, with `apiAudience`, and the
 * client that calls the API. Without them, the suites that need them skip.
 */
export const noIdentityProvider =
  !process.env.STACKIT_TEST_WORKFLOWS_IDP_DISCOVERY ||
  !process.env.STACKIT_TEST_WORKFLOWS_IDP_CLIENT_ID ||
  !process.env.STACKIT_TEST_WORKFLOWS_IDP_CLIENT_SECRET ||
  !process.env.STACKIT_TEST_WORKFLOWS_IDP_AUDIENCE ||
  !process.env.STACKIT_TEST_WORKFLOWS_API_CLIENT_ID ||
  !process.env.STACKIT_TEST_WORKFLOWS_API_CLIENT_SECRET;

/** Airflow 3, as STACKIT's docs name it. */
export const AIRFLOW_3 = "workflows-3.0-airflow-3.1";

/** Airflow 2, as STACKIT's docs name it. */
export const AIRFLOW_2 = "workflows-2.3-airflow-2.11";

/** A public repository holding DAGs at a fixed tag. Airflow only reads it. */
export const gitBundle = (name: string) =>
  ({
    type: "git",
    name,
    url: "https://github.com/apache/airflow",
    branch: "3.1.8",
    subdir: "airflow-core/src/airflow/example_dags",
    auth: { type: "none" },
  }) as const;

/** The instance, or `"gone"` on the typed not-found error. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  workflows
    .getInstance({ projectId, regionId: region, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 24,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

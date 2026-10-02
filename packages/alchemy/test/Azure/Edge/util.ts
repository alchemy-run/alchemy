import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:edge", "live"];

/** Workload orchestration is offered in eastus and eastus2 only. */
export const location = "eastus";

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/**
 * Azure allows one workload orchestration context per subscription
 * ("Context ... already exists"), so tests that create one run one at a
 * time.
 */
const contexts = Semaphore.makeUnsafe(1);

/** Run a test body while holding the subscription's single context slot. */
export const withContext = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => contexts.withPermits(1)(self);

/** A minimal config template with an inline schema. */
export const configTemplateYaml = (key: string) =>
  [
    "schema:",
    "  rules:",
    "    configs:",
    `      ${key}:`,
    "        type: string",
    "        required: true",
    "        editableBy:",
    "          - OT",
    "configs:",
    `  ${key}: \${{$val(${key})}}`,
    "",
  ].join("\n");

/** A minimal Helm solution specification. */
export const helmSpecification = (version: string) => ({
  components: [
    {
      name: "app",
      type: "helm.v3",
      properties: {
        chart: { repo: "mcr.microsoft.com/azure-arc/helm/app", version },
      },
    },
  ],
});

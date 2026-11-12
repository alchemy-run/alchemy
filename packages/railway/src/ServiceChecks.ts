import { Query } from "@distilled.cloud/core/query";
import { Railway } from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import { withEnvironmentConfigLock } from "./transient.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `source.checkSuites` ("Wait for CI") for `serviceId` inside an
 * environment config. Railway omits it while it is off, so an absent key
 * reads as `false`.
 */
export const serviceCheckSuites = (config: unknown, serviceId: string): boolean => {
  if (!isRecord(config)) return false;
  const services = config.services;
  if (!isRecord(services)) return false;
  const service = services[serviceId];
  if (!isRecord(service)) return false;
  const source = service.source;
  if (!isRecord(source)) return false;
  return source.checkSuites === true;
};

/**
 * Whether `desired` differs from what the config reports. `undefined`
 * (prop omitted) never differs, and `false` over an absent key is already
 * satisfied.
 */
export const checkSuitesChanged = (desired: boolean | undefined, observed: boolean): boolean =>
  desired !== undefined && desired !== observed;

const readEnvironmentConfig = Query.fn((args: { id: string; projectId?: string }) => ({
  config: Railway.environment(args).config,
}));

// `skipDeploys`: this setting gates later deploys. Flipping it must not
// start one of its own.
const environmentPatchCommit = Query.fn(
  (args: { environmentId: string; commitMessage: string; patch: unknown; skipDeploys: boolean }) =>
    Railway.environmentPatchCommit(args),
);

/**
 * Converge "Wait for CI" on a GitHub-sourced service. Railway's own IaC and
 * CLI write `source.checkSuites` in the environment config, so this reads
 * that config and patches only when it differs from `waitForChecks`.
 * Returns whether it wrote.
 */
export const syncCheckSuites = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  waitForChecks: boolean | undefined;
}) {
  const desired = input.waitForChecks;
  if (desired === undefined) return false;
  return yield* withEnvironmentConfigLock(
    input.environmentId,
    Effect.gen(function* () {
      const environment = yield* readEnvironmentConfig(
        input.projectId.length > 0
          ? { id: input.environmentId, projectId: input.projectId }
          : { id: input.environmentId },
      );
      if (!checkSuitesChanged(desired, serviceCheckSuites(environment.config, input.serviceId))) {
        return false;
      }
      yield* environmentPatchCommit({
        environmentId: input.environmentId,
        commitMessage: `Set Railway service wait for CI to ${desired}`,
        patch: { services: { [input.serviceId]: { source: { checkSuites: desired } } } },
        skipDeploys: true,
      });
      return true;
    }),
  );
});

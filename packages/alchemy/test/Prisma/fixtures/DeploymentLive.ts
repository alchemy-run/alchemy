import { getDeployment, getService } from "@distilled.cloud/prisma/management";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Deployment as PrismaDeployment } from "@/Prisma/Deployment";
import * as Provider from "@/Provider";
import { isActionState, State } from "@/State/State.ts";
import type * as Test from "@/Test/Alchemy";
import { expectGone } from "./Live.ts";

/**
 * Prebuilt Prisma Compute artifacts (`compute.manifest.json` plus a
 * `bundle/server.js` Bun server that answers and logs its version string).
 * Generated once with `createComputeArchive` and checked in so their bytes,
 * and therefore their artifact hashes, are stable.
 */
export const artifactV1Path = `${import.meta.dirname}/deployment/v1.tar.gz`;
export const artifactV2Path = `${import.meta.dirname}/deployment/v2.tar.gz`;

export const observeDeployment = (deploymentId: string) =>
  getDeployment({ deploymentId }).pipe(Effect.map((response) => response.data));

export const observeApp = (appId: string) =>
  getService({ serviceId: appId }).pipe(Effect.map((response) => response.data));

export const expectDeploymentGone = (deploymentId: string) =>
  expectGone(
    getDeployment({ deploymentId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

export const expectAppGone = (appId: string) =>
  expectGone(
    getService({ serviceId: appId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

/** Poll a deployment until it reports `status` (bounded to ~50 s). */
export const waitForStatus = (deploymentId: string, status: string) =>
  observeDeployment(deploymentId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      times: 10,
      until: (deployment) => deployment.status === status,
    }),
  );

/** The persisted state row of a resource, as the state store holds it. */
export const stateRow = (stack: Test.ScratchStack, fqn: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const stored = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
    if (!stored || isActionState(stored)) {
      return yield* Effect.die(new Error(`Expected a resource state row for '${fqn}'`));
    }
    return stored;
  }).pipe(Effect.provide(stack.state));

/**
 * Tail a deployed resource's logs the way `alchemy logs --tail` does
 * (`Alchemist/routes/logs.ts`): the persisted row supplies the request and the
 * provider's `tail` streams it. That route opens a stack from its entrypoint
 * file, which a scratch stack does not have, so this mirrors its `select`.
 */
export const tailFromState = (stack: Test.ScratchStack, fqn: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const stored = yield* stateRow(stack, fqn);
      const provider = yield* Provider.findProvider(PrismaDeployment);
      return provider.tail!({
        id: stored.logicalId,
        fqn,
        instanceId: stored.instanceId,
        props: stored.props as never,
        output: stored.attr as PrismaDeployment["Attributes"],
      });
    }),
  );

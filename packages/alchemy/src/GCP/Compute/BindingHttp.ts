import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Instance } from "./Instance.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Compute Engine instance bindings.
 * NOT exported from index.ts.
 */
export const makeInstanceHttpBinding = <
  I extends { instance?: string; zone?: string; project?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (instance: Instance) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: instance,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const instanceName = yield* instance.instanceName;
      const zone = yield* instance.zone;
      const project = yield* instance.project;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "instance" | "zone" | "project">,
      ) {
        return yield* run({
          ...(request as I),
          instance: yield* instanceName,
          zone: yield* zone,
          project: yield* project,
        } as I);
      });
    });
  });

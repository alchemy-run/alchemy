import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Model } from "./Model.ts";
import type { ModelsVersion } from "./ModelsVersion.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for AI Platform (legacy ML Engine) bindings.
 * NOT exported from index.ts.
 */
export const makeModelHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (model: Model) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: model,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* model.name;
      return Effect.fn(`${options.tag}(${model.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeVersionHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (version: ModelsVersion) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: version,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* version.name;
      return Effect.fn(`${options.tag}(${version.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

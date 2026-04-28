import * as Axiom from "@distilled.cloud/axiom";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type VirtualFieldProps = Axiom.CreateVirtualFieldInput;

export type VirtualField = Resource<
  "Axiom.VirtualField",
  VirtualFieldProps,
  Axiom.CreateVirtualFieldOutput,
  never,
  Providers
>;

/**
 * An Axiom virtual field — a saved APL expression that appears as a derived
 * column on a dataset at query time. Use these to standardise common
 * computations (status classes, latency buckets, parsed JSON paths) so
 * dashboards and monitors don't have to redefine them.
 *
 * Bound to a single `dataset`; changing the dataset triggers a replacement.
 *
 * @see https://axiom.co/docs/query-data/virtual-fields
 *
 * @section Creating a Virtual Field
 * @example HTTP status class (e.g. 200 → "2xx")
 * ```typescript
 * yield* Axiom.VirtualField("status-class", {
 *   dataset: "my-app-traces",
 *   name: "status_class",
 *   description: "HTTP response class bucket",
 *   expression: 'strcat(tostring(toint(status / 100)), "xx")',
 *   type: "string",
 * });
 * ```
 *
 * @example Latency bucket in seconds
 * ```typescript
 * yield* Axiom.VirtualField("latency-bucket", {
 *   dataset: "my-app-traces",
 *   name: "latency_bucket_s",
 *   expression: "bin(duration_ms / 1000.0, 0.5)",
 *   type: "number",
 *   unit: "s",
 * });
 * ```
 */
export const VirtualField = Resource<VirtualField>("Axiom.VirtualField");

export const VirtualFieldProvider = () =>
  Provider.effect(
    VirtualField,
    Effect.gen(function* () {
      const create = yield* Axiom.createVirtualField;
      const update = yield* Axiom.updateVirtualField;
      const get = yield* Axiom.getVirtualField;
      const del = yield* Axiom.deleteVirtualField;

      return {
        stables: ["id"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.dataset !== output.dataset) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        create: Effect.fn(function* ({ news }) {
          return yield* create(news);
        }),
        update: Effect.fn(function* ({ news, output }) {
          return yield* update({ ...news, id: output.id });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );

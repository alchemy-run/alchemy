import * as Cloudflare from "@/Cloudflare";
import {
  WorkerEnvironment,
  WorkerTypeId,
} from "@/Cloudflare/Workers/Worker.ts";
import * as Output from "@/Output";
import { Self } from "@/Self.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

/**
 * A class-form Durable Object whose physical class keeps a name distinct from
 * its logical id, the shape a host converted from the async form declares to
 * keep its namespace in place.
 */
interface LensShape {
  readonly ping: () => Effect.Effect<string>;
}

class LensDo extends Cloudflare.DurableObject<LensDo, LensShape>()("LENS_DO", {
  className: "OddlynewLensServer",
}) {}

describe("class-form className", () => {
  it.effect(
    "a cross-script binding carries the physical class and resolves its namespace id by it",
    () =>
      Effect.gen(function* () {
        const bound: unknown[] = [];
        const worker = {
          bind:
            (strings: TemplateStringsArray, ...args: unknown[]) =>
            (data: unknown) =>
              Effect.sync(() => {
                bound.push({ sid: String.raw(strings, ...args), data });
              }),
          durableObjectNamespaces: Output.literal({
            OddlynewLensServer: "ns-lens",
          }),
        };

        // `yield* Worker` resolves the `Self` tag of the Worker type at
        // runtime; the `Worker` requirement is a type-level marker.
        const handle = yield* (
          LensDo.from("host-script") as Effect.Effect<
            Cloudflare.DurableObject<LensDo>
          >
        ).pipe(
          Effect.provideService(Self(WorkerTypeId), worker as never),
          Effect.provideService(WorkerEnvironment, undefined as never),
        );

        expect(bound).toEqual([
          {
            sid: "LENS_DO",
            data: {
              bindings: [
                {
                  type: "durable_object_namespace",
                  name: "LENS_DO",
                  className: "OddlynewLensServer",
                  scriptName: "host-script",
                  transferredFrom: undefined,
                },
              ],
            },
          },
        ]);
        expect(handle.name).toBe("LENS_DO");
        const namespaceId = handle.namespaceId;
        expect(Output.isApplyExpr(namespaceId)).toBe(true);
        if (Output.isApplyExpr(namespaceId)) {
          expect(namespaceId.f({ OddlynewLensServer: "ns-lens" })).toBe(
            "ns-lens",
          );
          expect(namespaceId.f({ LENS_DO: "wrong-key" })).toBeUndefined();
        }
      }),
  );
});

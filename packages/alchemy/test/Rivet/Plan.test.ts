/**
 * Plan-only pins for the Rivet caller binding — no cloud writes. What
 * `Rivet.bindWorker` stamps onto a caller (the engine endpoint env + the VPC
 * attachment, and NO secret) and what `Rivet.Worker` refuses at plan time.
 */
import * as AWS from "@/AWS";
import * as Rivet from "@/Rivet";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import ConformanceApi from "./fixtures/api.ts";
import { ConformanceActors, ConformanceWorker } from "./fixtures/cluster.ts";
import ConformanceWorkerLive from "./fixtures/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Rivet.providers(), Rivet.Ecs()),
};
const { test } = Test.make(testOptions);
const scratch = Core.scratchStack(testOptions, "RivetPlan", import.meta.url);

describe("rivet plan", () => {
  test(
    "bindWorker stamps the engine endpoint and VPC attachment, no secret",
    Effect.gen(function* () {
      const plan = yield* scratch.plan(
        Effect.gen(function* () {
          yield* ConformanceActors;
          yield* ConformanceWorker;
          const api = yield* ConformanceApi;
          return { apiUrl: api.functionUrl };
        }).pipe(Effect.provide(ConformanceWorkerLive)),
      );
      const api = Object.values(plan.resources).find(
        (node) => node.resource.LogicalId === "ConformanceApi",
      );
      expect(api).toBeDefined();
      const props = (api as any).props as { env?: Record<string, unknown> };
      const envKeys = Object.keys(props.env ?? {});
      console.log("ConformanceApi env keys:", envKeys);
      console.log(
        "ConformanceApi bindings:",
        (api as any).bindings.map((b: any) => ({
          sid: b.sid,
          data: Object.keys(b.data ?? {}),
        })),
      );
      expect(envKeys).toContain("ConformanceWorker_endpoint");
      expect(envKeys.some((k) => k.includes("SECRET"))).toBe(false);
      const call = (api as any).bindings.find((b: any) =>
        String(b.sid).includes("Rivet.Worker.Call(ConformanceWorker)"),
      );
      expect(call).toBeDefined();
      expect(Object.keys(call.data)).toEqual(["vpc"]);
    }),
    { timeout: 120_000 },
  );

  test(
    "expose / domain are refused at plan time",
    Effect.gen(function* () {
      const result = yield* Effect.result(
        scratch.plan(
          Effect.gen(function* () {
            yield* ConformanceActors;
            yield* Rivet.Worker(
              "Exposed",
              {
                cluster: ConformanceActors,
                main: import.meta.url,
                expose: "public",
              },
              Effect.succeed({}),
            );
            return {};
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      const failure = Result.isFailure(result) ? result.failure : undefined;
      const text = String(
        (failure as any)?.message ?? (failure as any)?.cause ?? failure,
      );
      console.log("expose refusal:", text.slice(0, 400));
      expect(text).toContain("enforces no caller token");
    }),
    { timeout: 120_000 },
  );
});

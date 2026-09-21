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
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { makeRivetRunnerEntry } from "@/Rivet/RunnerEntry.ts";
import ConformanceApi from "./fixtures/api.ts";
import { ConformanceActors, ConformanceWorker } from "./fixtures/cluster.ts";
import ConformanceWorkerLive from "./fixtures/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(
    AWS.providers(),
    Rivet.providers(),
    Rivet.EcsCluster(),
  ),
};
const { test } = Test.make(testOptions);
const scratch = Core.scratchStack(testOptions, "RivetPlan", import.meta.url);

describe("rivet plan", () => {
  test(
    "schema facade registers without evaluating its native instance",
    Effect.gen(function* () {
      class Rpcs extends RpcGroup.make(
        Rpc.make("greet", { success: Schema.String }),
      ) {}
      class Room extends Rivet.RpcDurableObject<Room>()("Room", {
        schema: Rpcs,
      }) {}
      let constructions = 0;
      const live = Room.make(
        Effect.gen(function* () {
          const self = yield* Rivet.RpcDurableObject;
          expect(self.name).toBe("Room");
          return Effect.sync(() => {
            constructions++;
            return Rpcs.toLayer({ greet: () => Effect.succeed("hello") });
          });
        }),
      );
      const plan = yield* scratch.plan(
        Effect.gen(function* () {
          yield* ConformanceActors;
          yield* Rivet.Worker(
            "RpcHost",
            { cluster: ConformanceActors, main: import.meta.url },
            Effect.gen(function* () {
              yield* Room;
              return {};
            }).pipe(Effect.provide(live)),
          );
          return {};
        }),
      );
      expect(constructions).toBe(0);
      const host = Object.values(plan.resources).find(
        (node) => node.resource.LogicalId === "RpcHost",
      );
      expect(host).toBeDefined();
      expect((host as any).props.exports.Room.kind).toBe("durableObject");
    }),
    { timeout: 30_000 },
  );

  test(
    "embeds SQL-only changes in runner code without changing actor registration",
    Effect.sync(() => {
      const object = { kind: "durableObject", provider: "Rivet" };
      const before = makeRivetRunnerEntry(
        {
          Room: object,
          sql: {
            kind: "sqlMigrations",
            snapshot: {
              _tag: "Cloudflare.SqlMigrations",
              table: "history",
              records: [],
            },
          },
        },
        { name: "app", stage: "test" },
      )("./main.ts");
      const after = makeRivetRunnerEntry(
        {
          Room: object,
          sql: {
            kind: "sqlMigrations",
            snapshot: {
              _tag: "Cloudflare.SqlMigrations",
              table: "history",
              records: [{ name: "0001", sql: "CREATE TABLE users(id TEXT)" }],
            },
          },
        },
        { name: "app", stage: "test" },
      )("./main.ts");
      expect(before).not.toBe(after);
      expect(after).toContain("withSqlMigrations");
      expect(after).toContain('classes: [{"className":"Room"}]');
      expect(before).toContain('classes: [{"className":"Room"}]');
    }),
    { timeout: 5000 },
  );
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

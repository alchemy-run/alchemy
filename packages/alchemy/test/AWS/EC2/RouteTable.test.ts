import * as AWS from "@/AWS";
import { RouteTable, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("list enumerates the deployed RouteTable", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { routeTable } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListRouteTableVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const routeTable = yield* RouteTable("ListRouteTable", {
          vpcId: vpc.vpcId,
        });
        return { vpc, routeTable };
      }),
    );

    const provider = yield* Provider.findProvider(RouteTable);
    const all = yield* provider.list();

    expect(all.some((x) => x.routeTableId === routeTable.routeTableId)).toBe(
      true,
    );

    yield* stack.destroy();
  }).pipe(logLevel),
);

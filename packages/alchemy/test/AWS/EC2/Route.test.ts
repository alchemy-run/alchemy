import * as AWS from "@/AWS";
import { InternetGateway, Route, RouteTable, Vpc } from "@/AWS/EC2";
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

test.provider("list enumerates the deployed Route", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListRouteVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const igw = yield* InternetGateway("ListRouteIgw", {
          vpcId: vpc.vpcId,
        });
        const routeTable = yield* RouteTable("ListRouteTable", {
          vpcId: vpc.vpcId,
        });
        const route = yield* Route("ListRoute", {
          routeTableId: routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          gatewayId: igw.internetGatewayId,
        });
        return { route };
      }),
    );

    const provider = yield* Provider.findProvider(Route);
    const all = yield* provider.list();

    expect(
      all.some(
        (x) =>
          x.routeTableId === deployed.route.routeTableId &&
          x.destinationCidrBlock === deployed.route.destinationCidrBlock &&
          x.gatewayId === deployed.route.gatewayId,
      ),
    ).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

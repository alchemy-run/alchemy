import * as AWS from "@/AWS";
import { RouteTable, Vpc, VpcEndpoint } from "@/AWS/EC2";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("list enumerates the deployed VpcEndpoint", (stack) =>
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;

    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListVpceVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const routeTable = yield* RouteTable("ListVpceRouteTable", {
          vpcId: vpc.vpcId,
        });
        const endpoint = yield* VpcEndpoint("ListVpceEndpoint", {
          vpcId: vpc.vpcId,
          serviceName: `com.amazonaws.${region}.s3`,
          vpcEndpointType: "Gateway",
          routeTableIds: [routeTable.routeTableId],
        });
        return { endpoint };
      }),
    );

    const provider = yield* Provider.findProvider(VpcEndpoint);
    const all = yield* provider.list();

    expect(
      all.some((x) => x.vpcEndpointId === deployed.endpoint.vpcEndpointId),
    ).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

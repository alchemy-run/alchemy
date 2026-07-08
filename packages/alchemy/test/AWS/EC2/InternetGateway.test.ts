import * as AWS from "@/AWS";
import { InternetGateway } from "@/AWS/EC2";
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

test.provider("list enumerates the deployed InternetGateway", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* InternetGateway("ListInternetGateway", {});
      }),
    );

    const provider = yield* Provider.findProvider(InternetGateway);
    const all = yield* provider.list();

    expect(
      all.some((x) => x.internetGatewayId === deployed.internetGatewayId),
    ).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

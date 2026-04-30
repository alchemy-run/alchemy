import * as AlchemyContext from "@/AlchemyContext.ts";
import * as RpcClient from "@/Sidecar/RpcClient.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as TestService from "./TestService.ts";

class TestClient extends RpcClient.RpcClientService<
  TestClient,
  TestService.TestService
>()("TestClient") {}

export const layer = RpcClient.layer(TestClient, {
  main: import.meta.resolve("./TestServer.ts", import.meta.url),
  schema: TestService.TestServiceSchema,
});

const program = Effect.gen(function* () {
  const client = yield* TestClient;
  yield* client.get().pipe(
    Effect.tap((result) => Effect.log(result)),
    Effect.andThen(() => Effect.sleep("1 second")),
    Effect.forever,
  );
});

program.pipe(
  Effect.provide(layer),
  Effect.provide(AlchemyContext.AlchemyContextLive),
  Effect.provide(PlatformServices),
  NodeRuntime.runMain,
);

import * as RpcServer from "@/Sidecar/RpcServer.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { TestService, TestServiceSchema } from "./TestService.ts";

TestService.pipe(
  Effect.flatMap((handlers) =>
    RpcServer.makeRpcServer(handlers, TestServiceSchema),
  ),
  Effect.provide(RpcServer.layerServices(import.meta.url)),
  Effect.provide(PlatformServices),
  Effect.scoped,
  NodeRuntime.runMain,
);

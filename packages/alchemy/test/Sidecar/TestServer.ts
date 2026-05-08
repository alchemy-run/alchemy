import * as RpcServer from "@/Sidecar/RpcServer.ts";
import * as RpcServices from "@/Sidecar/RpcServices.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { TestService, TestServiceSchema } from "./TestService.ts";

RpcServer.makeRpcServer(TestService, TestServiceSchema).pipe(
  Effect.provide(RpcServices.layer(import.meta.url)),
  Effect.provide(PlatformServices),
  Effect.scoped,
  NodeRuntime.runMain,
);

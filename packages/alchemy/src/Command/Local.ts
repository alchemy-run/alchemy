import * as Layer from "effect/Layer";
import * as DevIngressClient from "../Local/DevIngressClient.ts";
import * as RpcServer from "../Local/RpcServer.ts";
import { CommandExecutorLive } from "./Command.ts";
import { DevProviderLocal } from "./Dev.ts";

DevProviderLocal().pipe(
  Layer.provide(CommandExecutorLive()),
  // Dev servers register with the `alchemy dev` ingress, which lives in the
  // Cloudflare sidecar — reached over RPC through the spawner.
  Layer.provide(DevIngressClient.layer),
  RpcServer.launch,
);

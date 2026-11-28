import { NodeServices } from "@effect/platform-node";
import { serve } from "alchemy/Gateway/Serve";
import * as Layer from "effect/Layer";
// The Worker a `SandboxGateway` layer deploys. `virtual:alchemy-gateway-program`
// is the sandbox's own `main`: the gateway runs the same program's
// Construction to build its bindings, and never its handlers.
// @ts-expect-error resolved by the gateway's bundler plugin
import program from "virtual:alchemy-gateway-program";
import { WorkerEnvironment } from "./WorkerRuntime.ts";

// The program's Construction may use a Node host's services (the file
// system, child processes); the Worker has them through `nodejs_compat`.
// A Worker's program also reads its environment while it is constructed
// (a Durable Object's harness, a native binding): here that is the
// gateway's own.
const handle = serve(program, {
  services: (env) =>
    Layer.merge(NodeServices.layer, Layer.succeed(WorkerEnvironment, env as never)),
});

export default {
  fetch: (request: Request, env: Record<string, unknown>) => handle(request, env),
};

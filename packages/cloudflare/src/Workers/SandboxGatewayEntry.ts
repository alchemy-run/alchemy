import { NodeServices } from "@effect/platform-node";
import { serve } from "alchemy/Gateway/Serve";
// The Worker a `SandboxGateway` layer deploys. `virtual:alchemy-gateway-program`
// is the sandbox's own `main`: the gateway runs the same program's
// Construction to build its bindings, and never its handlers.
// @ts-expect-error resolved by the gateway's bundler plugin
import program from "virtual:alchemy-gateway-program";

// The program's Construction may use a Node host's services (the file
// system, child processes); the Worker has them through `nodejs_compat`.
const handle = serve(program, { services: NodeServices.layer });

export default {
  fetch: (request: Request, env: Record<string, unknown>) => handle(request, env),
};

import { serve } from "alchemy/Gateway/Serve";
// The Worker a `SandboxGateway` layer deploys. `virtual:alchemy-gateway-program`
// is the sandbox's own `main`: the gateway runs the same program's
// Construction to build its bindings, and never its handlers.
// @ts-expect-error resolved by the gateway's bundler plugin
import program from "virtual:alchemy-gateway-program";

const handle = serve(program);

export default {
  fetch: (request: Request, env: Record<string, unknown>) => handle(request, env),
};

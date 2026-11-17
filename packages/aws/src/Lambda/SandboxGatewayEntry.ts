import { listen } from "alchemy/Gateway/Node";
// The Web Function a `SandboxGateway` layer deploys. `virtual:alchemy-gateway-program`
// is the sandbox's own `main`: the gateway runs the same program's
// Construction to build its bindings, and never its handlers.
// @ts-expect-error resolved by the gateway's bundler plugin
import program from "virtual:alchemy-gateway-program";

const [host = "localhost", port = "3000"] = (
  process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000"
).split(":");

listen(program, { host, port: Number(port) });

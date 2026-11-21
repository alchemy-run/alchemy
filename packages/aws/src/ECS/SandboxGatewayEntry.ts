import { gateway } from "alchemy/Gateway/Process";
// The program of the Service a `SandboxGateway` layer deploys.
// `virtual:alchemy-gateway-program` is the sandbox's own `main`: the gateway
// runs the same program's Construction to build its bindings, and never its
// handlers.
// @ts-expect-error resolved by the gateway's bundler plugin
import program from "virtual:alchemy-gateway-program";

export default gateway(program);

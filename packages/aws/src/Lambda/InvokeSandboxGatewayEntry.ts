import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import { serve } from "alchemy/Gateway/Serve";
import * as Layer from "effect/Layer";
// The Function an `InvokeSandboxGateway` layer deploys.
// `virtual:alchemy-gateway-program` is the sandbox's own `main`: the gateway
// runs the same program's Construction to build its bindings, and never its
// handlers.
// @ts-expect-error resolved by the gateway's bundler plugin
import program from "virtual:alchemy-gateway-program";

/** One gateway request, as the sandbox sends it in an `Invoke` payload. */
interface Invocation {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  /** Base64. */
  readonly body?: string;
}

const ORIGIN = "https://gateway.invalid";

const handle = serve(program, {
  // AWS bindings sign as the Function's execution role.
  services: Layer.mergeAll(
    NodeServices.layer,
    Credentials.fromEnv(),
    Region.fromEnv(),
    Endpoint.fromEnv(),
  ),
  url: () => ORIGIN,
});

export const handler = async (event: Invocation) => {
  const response = await handle(
    new Request(`${ORIGIN}${event.path}`, {
      method: event.method,
      headers: event.headers,
      ...(event.body === undefined ? {} : { body: Buffer.from(event.body, "base64") }),
    }),
    process.env,
  );
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
};

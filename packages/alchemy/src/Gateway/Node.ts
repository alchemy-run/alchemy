import * as http from "node:http";
/**
 * A gateway as a Node HTTP server, for hosts that run a process: a Lambda
 * Web Function, a container, a VM. The host's entry imports this module and
 * the sandbox's program.
 */
import { NodeServices } from "@effect/platform-node";
import { serve } from "./Serve.ts";

/** Serve `entrypoint` as a gateway on `host:port`. */
export const listen = (
  entrypoint: unknown,
  address: { readonly host: string; readonly port: number },
) => {
  const handle = serve(entrypoint, { services: NodeServices.layer });
  const answer = async (incoming: http.IncomingMessage, outgoing: http.ServerResponse) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Uint8Array);
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const response = await handle(
      new Request(`http://gateway${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      }),
      process.env,
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body !== null) {
      // Written as it arrives, so a streamed result is not buffered here.
      for await (const chunk of response.body) outgoing.write(chunk);
    }
    outgoing.end();
  };
  return http
    .createServer((incoming, outgoing) => {
      answer(incoming, outgoing).catch((cause) => {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end(String(cause));
      });
    })
    .listen(address.port, address.host);
};

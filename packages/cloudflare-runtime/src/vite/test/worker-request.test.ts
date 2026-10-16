import * as NodeHttp from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { URL as NodeURL } from "node:url";
import * as vite from "vite";
import { expect, onTestFinished, test } from "vitest";
import { forwardWorkerRequest } from "../worker-request.ts";

const listen = async (server: NodeHttp.Server): Promise<NodeURL> => {
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return new NodeURL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
};

const get = async (url: NodeURL): Promise<{ status: number; text: string }> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return { status: response.status, text: await response.text() };
};

test("forwards each request on a connection of its own", async () => {
  // Stand-in for workerd having closed a connection the proxy still holds:
  // a second request on any connection finds it gone.
  const served = new WeakSet<Socket>();
  const runtime = await listen(
    NodeHttp.createServer((request, response) => {
      if (served.has(request.socket)) {
        request.socket.destroy();
        return;
      }
      served.add(request.socket);
      response.end("worker");
    }),
  );
  const logger = vite.createLogger("silent");
  const proxy = await listen(
    NodeHttp.createServer((request, response) => {
      forwardWorkerRequest(request, response, runtime, "secret", logger);
    }),
  );

  expect(await get(proxy)).toEqual({ status: 200, text: "worker" });
  expect(await get(proxy)).toEqual({ status: 200, text: "worker" });
});

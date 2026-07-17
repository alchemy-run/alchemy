/**
 * Live Lambda local runner — the child process that executes the user's
 * handler on the developer's machine.
 *
 * One child per bridge sandbox (`workerId`), spawned by the local Function
 * provider with the environment forwarded from the real sandbox (including
 * the execution role's credentials), plus:
 *
 * - `ALCHEMY_LIVE_BUNDLE`  — path to the locally-built entry module
 * - `ALCHEMY_LIVE_HANDLER` — the export name of the handler (e.g. `default`)
 *
 * The child imports the bundle eagerly (so init errors surface immediately),
 * serves `POST /invoke` on a loopback port, and prints the address inside an
 * `<ALCHEMY_CHILD_ADDRESS>` sentinel for the parent to scrape — the same
 * pattern the RPC spawner uses. Invocations arrive serially per sandbox,
 * matching Lambda semantics.
 */
import * as http from "node:http";
import { pathToFileURL } from "node:url";
import type { ErrorBody, SerializedContext } from "./Protocol.ts";

interface InvokeRequest {
  event: unknown;
  context: SerializedContext;
}

type InvokeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: ErrorBody };

const toErrorBody = (error: unknown): ErrorBody => {
  if (error instanceof Error) {
    return {
      errorType: error.name || "Error",
      errorMessage: error.message,
      trace: error.stack?.split("\n"),
    };
  }
  return {
    errorType: "Error",
    errorMessage: typeof error === "string" ? error : JSON.stringify(error),
  };
};

const main = async () => {
  const bundlePath = process.env.ALCHEMY_LIVE_BUNDLE;
  const handlerName = process.env.ALCHEMY_LIVE_HANDLER ?? "default";
  if (!bundlePath) {
    throw new Error("ALCHEMY_LIVE_BUNDLE is not set");
  }

  const mod = await import(pathToFileURL(bundlePath).href);
  const handler = mod[handlerName];
  if (typeof handler !== "function") {
    throw new Error(
      `Handler export "${handlerName}" of ${bundlePath} is not a function`,
    );
  }

  const invoke = async (request: InvokeRequest): Promise<InvokeResponse> => {
    const { deadlineMs, ...contextFields } = request.context;
    const context = {
      ...contextFields,
      callbackWaitsForEmptyEventLoop: false,
      getRemainingTimeInMillis: () => deadlineMs - Date.now(),
    };
    try {
      const result =
        handler.length >= 3
          ? await new Promise<unknown>((resolve, reject) => {
              // Legacy callback-style handler.
              const maybePromise = handler(
                request.event,
                context,
                (error: unknown, value: unknown) =>
                  error ? reject(error) : resolve(value),
              );
              if (maybePromise && typeof maybePromise.then === "function") {
                maybePromise.then(resolve, reject);
              }
            })
          : await handler(request.event, context);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: toErrorBody(error) };
    }
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/invoke") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        let response: InvokeResponse;
        try {
          const request: InvokeRequest = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          response = await invoke(request);
        } catch (error) {
          response = { ok: false, error: toErrorBody(error) };
        }
        const body = JSON.stringify(response);
        res.writeHead(200, { "content-type": "application/json" }).end(body);
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind local invoke server");
  }
  console.log(
    `<ALCHEMY_CHILD_ADDRESS>http://127.0.0.1:${address.port}</ALCHEMY_CHILD_ADDRESS>`,
  );

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

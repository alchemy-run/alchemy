import {
  abortableResponse,
  disconnectSignal,
  installDisconnectTracking,
} from "./FunctionDisconnect.ts";

type FetchHandler = (request: Request, ...rest: unknown[]) => Response | Promise<Response>;

/**
 * Wrap a plain Neon fetch handler (a function, or an object with `fetch`) so
 * a client disconnect cancels its response body. Upgrade responses and every
 * other export are passed through unchanged.
 */
export const makeNativeFunctionBridge = (entrypoint: unknown) => {
  installDisconnectTracking();
  const target = entrypoint as { fetch?: FetchHandler; upgrade?: unknown } | FetchHandler;
  const handler =
    typeof target === "function"
      ? target
      : typeof target?.fetch === "function"
        ? target.fetch.bind(target)
        : undefined;
  if (!handler) return entrypoint;
  const fetch = async (request: Request, ...rest: unknown[]) => {
    const signal = disconnectSignal(request);
    const response = await handler(request, ...rest);
    // Neon brands the exact upgrade Response; rebuilding it drops the upgrade.
    return signal === request.signal || response.status === 101
      ? response
      : abortableResponse(response, signal);
  };
  return typeof target === "function" ? fetch : Object.assign(Object.create(target), { fetch });
};

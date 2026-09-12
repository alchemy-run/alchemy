/**
 * `toRpcAsync` turns every string key into an RPC method. Without a guard
 * that includes `then`, so the runtime treats the view as a thenable:
 * `await view` and `return view` from an async function call `then` as an
 * RPC and never settle. The view must answer the runtime's protocol probes
 * with `undefined` while still forwarding real method calls.
 */
import { toRpcAsync } from "@/Cloudflare/Workers/RpcAsync.ts";
import { expect, test } from "alchemy-test";

interface Backend {
  hello(name: string): Promise<string>;
}

/**
 * Stands in for a Cloudflare RPC stub, which answers any property with a
 * remote call: `then` would be one too, so the hang can only be prevented
 * on the view's side.
 */
const stub = new Proxy(
  {},
  {
    get:
      (_target, prop) =>
      (...args: unknown[]) => {
        if (prop === "hello") return Promise.resolve(`hello ${args[0]}`);
        return new Promise(() => {}); // a remote call that never returns
      },
  },
);

test("a toRpcAsync view is not a thenable", async () => {
  const view = toRpcAsync<Backend>(stub);

  expect((view as { then?: unknown }).then).toBeUndefined();
  expect((view as { toJSON?: unknown }).toJSON).toBeUndefined();

  const awaited = await Promise.resolve(view);
  expect(awaited).toBe(view);

  const returned = await (async () => view)();
  expect(returned).toBe(view);

  // Real methods still go through as Promise-returning RPC calls.
  expect(await view.hello("world")).toBe("hello world");
});

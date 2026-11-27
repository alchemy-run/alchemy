import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../platform-proxy/PlatformProxy.worker.ts";
import {
  BINDING_PLATFORM_PROXY_TOKEN,
  decodeValue,
  HEADER_RESULT,
  HEADER_TOKEN,
  PATH_CALL,
  type EncodedValue,
} from "../../platform-proxy/PlatformProxyProtocol.shared.ts";

const call = (value: unknown) =>
  worker.fetch(
    new Request(`http://platform-proxy.test${PATH_CALL}`, {
      method: "POST",
      headers: { [HEADER_TOKEN]: "test-token", "content-type": "application/json" },
      body: JSON.stringify({ binding: "TEST", chain: [{ method: "read", args: [] }] }),
    }) as Parameters<typeof worker.fetch>[0],
    {
      [BINDING_PLATFORM_PROXY_TOKEN]: "test-token",
      TEST: { read: () => value },
    },
  );

describe("platform-proxy RPC result lifetime", () => {
  beforeEach(() => {
    // workerd exposes this extension on SubtleCrypto; Node keeps it in node:crypto.
    vi.stubGlobal("crypto", { subtle: { timingSafeEqual } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes an object before disposing it once with the result as this", async () => {
    const dispose = vi.fn(function (this: unknown) {
      expect(this).toBe(result);
      result.ok = false;
    });
    const result = { ok: true, [Symbol.dispose]: dispose };

    const response = await call(result);
    const encoded = (await response.json()) as { value: EncodedValue };

    expect(response.status).toBe(200);
    expect(decodeValue(encoded.value)).toEqual({ ok: true });
    expect(result.ok).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes the result when encoding fails", async () => {
    const dispose = vi.fn();
    const response = await call({ unsupported: () => {}, [Symbol.dispose]: dispose });
    const encoded = (await response.json()) as { error: EncodedValue };

    expect(response.status).toBe(500);
    expect(decodeValue(encoded.error)).toMatchObject({ name: "UnsupportedValueError" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "preserves the response or encoding error when disposal throws (encoding fails: %s)",
    async (encodingFails) => {
      const dispose = vi.fn(() => {
        throw new Error("disposal failed");
      });
      const result = encodingFails
        ? { unsupported: () => {}, [Symbol.dispose]: dispose }
        : { ok: true, [Symbol.dispose]: dispose };
      const response = await call(result);
      const encoded = (await response.json()) as { value?: EncodedValue; error?: EncodedValue };

      expect(dispose).toHaveBeenCalledOnce();
      if (encodingFails) {
        expect(response.status).toBe(500);
        expect(decodeValue(encoded.error!)).toMatchObject({ name: "UnsupportedValueError" });
      } else {
        expect(response.status).toBe(200);
        expect(decodeValue(encoded.value!)).toEqual({ ok: true });
      }
    },
  );

  it("keeps a stream live until its response body is read", async () => {
    const dispose = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed result"));
        controller.close();
      },
    });
    Object.assign(stream, { [Symbol.dispose]: dispose });

    const response = await call(stream);

    expect(response.headers.get(HEADER_RESULT)).toBe("stream");
    expect(await response.text()).toBe("streamed result");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("disposes every result of a chain and of a chained argument, last first", async () => {
    const order: Array<string> = [];
    const disposable = <T extends object>(name: string, value: T) =>
      Object.assign(value, { [Symbol.dispose]: () => order.push(name) });
    const arg = disposable("arg", { id: "x" });
    const repo = disposable("repo", { read: (input: unknown) => disposable("result", { input }) });
    const response = await worker.fetch(
      new Request(`http://platform-proxy.test${PATH_CALL}`, {
        method: "POST",
        headers: { [HEADER_TOKEN]: "test-token", "content-type": "application/json" },
        body: JSON.stringify({
          binding: "TEST",
          chain: [
            { method: "repo", args: [] },
            { method: "read", args: [{ $: "chain", chain: [{ method: "arg", args: [] }] }] },
          ],
        }),
      }) as Parameters<typeof worker.fetch>[0],
      {
        [BINDING_PLATFORM_PROXY_TOKEN]: "test-token",
        TEST: { repo: () => repo, arg: () => arg },
      },
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(["result", "arg", "repo"]);
  });

  it("disposes the results acquired before a later step fails", async () => {
    const dispose = vi.fn();
    const repo = { [Symbol.dispose]: dispose };
    const response = await worker.fetch(
      new Request(`http://platform-proxy.test${PATH_CALL}`, {
        method: "POST",
        headers: { [HEADER_TOKEN]: "test-token", "content-type": "application/json" },
        body: JSON.stringify({
          binding: "TEST",
          chain: [
            { method: "repo", args: [] },
            { method: "missing", args: [] },
          ],
        }),
      }) as Parameters<typeof worker.fetch>[0],
      { [BINDING_PLATFORM_PROXY_TOKEN]: "test-token", TEST: { repo: () => repo } },
    );

    expect(response.status).not.toBe(200);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes an earlier argument when a later one fails", async () => {
    const dispose = vi.fn();
    const response = await worker.fetch(
      new Request(`http://platform-proxy.test${PATH_CALL}`, {
        method: "POST",
        headers: { [HEADER_TOKEN]: "test-token", "content-type": "application/json" },
        body: JSON.stringify({
          binding: "TEST",
          chain: [
            {
              method: "consume",
              args: [
                { $: "chain", chain: [{ method: "slow", args: [] }] },
                { $: "chain", chain: [{ method: "fail", args: [] }] },
              ],
            },
          ],
        }),
      }) as Parameters<typeof worker.fetch>[0],
      {
        [BINDING_PLATFORM_PROXY_TOKEN]: "test-token",
        TEST: {
          consume: () => "unreachable",
          fail: () => Promise.reject(new Error("argument failed")),
          slow: () =>
            new Promise((resolve) => setTimeout(() => resolve({ [Symbol.dispose]: dispose }), 20)),
        },
      },
    );

    expect(response.status).not.toBe(200);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([null, undefined, false, 42, "plain result"])(
    "preserves a primitive or nullish result: %s",
    async (value) => {
      const response = await call(value);
      const encoded = (await response.json()) as { value: EncodedValue };

      expect(response.status).toBe(200);
      expect(decodeValue(encoded.value)).toBe(value);
    },
  );
});

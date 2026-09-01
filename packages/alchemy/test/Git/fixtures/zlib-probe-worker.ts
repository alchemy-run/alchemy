/**
 * Probe fixture: what does THIS workerd's `node:zlib` offer for a
 * synchronous, exact-span inflate? (See `src/Git/git/Zlib.ts`.)
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import zlib from "node:zlib";

export default class ZlibProbeWorker extends Cloudflare.Worker<ZlibProbeWorker>()(
  "ZlibProbeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.sync(() => {
        const content = new TextEncoder().encode("hello ".repeat(1000));
        const z = new Uint8Array(zlib.deflateSync(content));
        const withTrailer = new Uint8Array(z.length + 7);
        withTrailer.set(z, 0);
        withTrailer.set([1, 2, 3, 4, 5, 6, 7], z.length);
        const engine = zlib.createInflate() as unknown as {
          _processChunk?: unknown;
          close?: () => void;
        };
        const hasProcessChunk = typeof engine._processChunk === "function";
        engine.close?.();
        let info: unknown;
        let infoError: string | undefined;
        try {
          const r = zlib.inflateSync(withTrailer, {
            info: true,
          } as never) as unknown as {
            buffer: Uint8Array;
            engine: { bytesWritten?: number };
          };
          info = {
            outLen: r.buffer?.length,
            bytesWritten: r.engine?.bytesWritten,
            expectedConsumed: z.length,
          };
        } catch (e) {
          infoError = String(e);
        }
        let plain: unknown;
        try {
          plain = {
            outLen: new Uint8Array(zlib.inflateSync(withTrailer)).length,
          };
        } catch (e) {
          plain = { error: String(e) };
        }
        return HttpServerResponse.jsonUnsafe({
          hasProcessChunk,
          info,
          infoError,
          plain,
          contentLen: content.length,
        });
      }),
    };
  }),
) {}

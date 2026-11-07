import { delimiter } from "node:path";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { afterEach, vi } from "vitest";
import * as Runtime from "../../Runtime.ts";
import { localRuntimeLayer } from "../helpers/runtime.ts";
import { makePki, serveHttps, tempPath } from "../helpers/tls.ts";

/** Fetches `?target=<url>` over TLS, as a Worker calling a local emulator does. */
const CLIENT_SCRIPT = `
export default {
  async fetch(request) {
    try {
      const response = await fetch(new URL(request.url).searchParams.get("target"));
      return new Response(await response.text());
    } catch (error) {
      return new Response(String(error), { status: 502 });
    }
  },
};
`;

const pki = { one: makePki("one"), two: makePki("two") };

let started = 0;

/** A new Worker, so it builds its own workerd config, and what it gets from `target`. */
const fetchFromWorker = (target: string) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const worker = yield* runtime.start({
      name: `tls-client-${started++}`,
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      bindings: [],
      modules: [{ name: "main.js", type: "ESModule", content: CLIENT_SCRIPT }],
    });
    return yield* Effect.promise(async () => {
      const response = await fetch(new URL(`/?target=${encodeURIComponent(target)}`, worker));
      return { status: response.status, body: await response.text() };
    });
  });

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Workers calling a private CA over TLS",
  (it) => {
    afterEach(() => vi.unstubAllEnvs());

    // The caller's shell may name a CA bundle of its own.
    const trusting = (trust: { callerFile?: string; devFiles?: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        vi.stubEnv("NODE_EXTRA_CA_CERTS", trust.callerFile ?? "");
        vi.stubEnv("ALCHEMY_DEV_TRUST", (trust.devFiles ?? []).join(delimiter));
      });

    const writeCa = (name: string, ca: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* tempPath(name);
        yield* fs.writeFileString(file, ca);
        return file;
      });

    it.effect(
      "rejects a certificate no trusted CA signed",
      () =>
        Effect.gen(function* () {
          const target = yield* serveHttps(pki.one, "one");
          yield* trusting({});
          const result = yield* fetchFromWorker(target);
          // workerd keeps the reason (UnknownIssuer) to itself.
          expect(result.status).toBe(502);
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "trusts a CA contributed through ALCHEMY_DEV_TRUST",
      () =>
        Effect.gen(function* () {
          const target = yield* serveHttps(pki.one, "one");
          const file = yield* writeCa("one.pem", pki.one.ca);
          yield* trusting({ devFiles: [file] });
          expect(yield* fetchFromWorker(target)).toEqual({ status: 200, body: "one" });
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "trusts the caller's NODE_EXTRA_CA_CERTS and every contributed CA together",
      () =>
        Effect.gen(function* () {
          const one = yield* serveHttps(pki.one, "one");
          const two = yield* serveHttps(pki.two, "two");
          yield* trusting({
            callerFile: yield* writeCa("caller.pem", pki.one.ca),
            // Another provider's CA that isn't minted yet sits beside it.
            devFiles: [yield* writeCa("two.pem", pki.two.ca), yield* tempPath("not-yet.pem")],
          });
          expect(yield* fetchFromWorker(one)).toEqual({ status: 200, body: "one" });
          expect(yield* fetchFromWorker(two)).toEqual({ status: 200, body: "two" });
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "trusts a CA written after the runtime started",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const target = yield* serveHttps(pki.one, "one");
          const file = yield* tempPath("late.pem");
          yield* trusting({ devFiles: [file] });
          expect((yield* fetchFromWorker(target)).status).toBe(502);
          yield* fs.writeFileString(file, pki.one.ca);
          expect(yield* fetchFromWorker(target)).toEqual({ status: 200, body: "one" });
        }),
      { timeout: 30_000 },
    );
  },
);

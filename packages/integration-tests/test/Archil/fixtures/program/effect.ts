import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { ProgramData, ProgramMount } from "./resources.ts";

/**
 * An Effect program in its own Archil sandbox: it reads one disk as objects
 * (`ReadDisk`) and has another mounted natively (`MountDisk`).
 */
export default class EffectApi extends Archil.Sandbox<EffectApi>()(
  "EffectApi",
  { main: import.meta.url, port: 3000, idleTtlSeconds: 300 },
  Effect.gen(function* () {
    const files = yield* Archil.ReadDisk(ProgramData);
    const mounted = yield* Archil.MountDisk(ProgramMount, { path: "/data", mode: "read-only" });
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://program");
        const key = url.searchParams.get("key") ?? "";
        if (url.pathname === "/read") {
          return HttpServerResponse.text(yield* files.getText(key));
        }
        if (url.pathname === "/mounted") {
          const path = yield* Effect.scoped(mounted.mount());
          return HttpServerResponse.text(yield* fs.readFileString(`${path}/${key}`));
        }
        return HttpServerResponse.text("effect ok");
      }).pipe(
        Effect.catch((e) => Effect.succeed(HttpServerResponse.text(String(e), { status: 500 }))),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Archil.ReadDiskHttp, Archil.MountDiskLive))),
) {}

import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Coder, Uploads, UploadsKeys, Workspace } from "./resources.ts";

/**
 * An Effect program in a Modal sandbox: it reads a bound volume, mounts the
 * same volume with `Modal.MountVolume`, and mounts a Cloudflare R2 bucket
 * from its props.
 */
export default class Agent extends Modal.Sandbox<Agent>()(
  "Agent",
  {
    main: import.meta.url,
    app: Coder,
    mounts: [{ bucket: Uploads, path: "/uploads", secret: UploadsKeys }],
  },
  Effect.gen(function* () {
    const workspace = yield* Modal.ReadVolume(Workspace);
    const mounted = yield* Modal.MountVolume(Workspace, { path: "/workspace" });
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://agent");
        if (url.pathname.endsWith("/echo")) {
          // What arrived, for the getTcpPort fetch tests.
          return yield* HttpServerResponse.json(
            {
              method: request.method,
              path: url.pathname,
              query: url.search,
              probe: request.headers["x-probe"],
              body: yield* request.text,
            },
            { status: 201, headers: { "x-echo": "sandbox" } },
          );
        }
        const key = url.searchParams.get("key") ?? "k";
        if (url.pathname === "/write") {
          yield* fs.writeFileString(`${mounted.path}/${key}.txt`, `volume ${key}`);
          yield* fs.writeFileString(`/uploads/${key}.txt`, `bucket ${key}`);
          return yield* HttpServerResponse.json({ written: key });
        }
        if (url.pathname === "/read") {
          return yield* HttpServerResponse.json({
            volume: yield* fs.readFileString(`${mounted.path}/${key}.txt`),
            bucket: yield* fs.readFileString(`/uploads/${key}.txt`),
          });
        }
        const files = yield* workspace.listFiles("/");
        return yield* HttpServerResponse.json({ agent: "effect", files: files.length });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Modal.ReadVolumeHttp, Modal.MountVolumeLive))),
) {}

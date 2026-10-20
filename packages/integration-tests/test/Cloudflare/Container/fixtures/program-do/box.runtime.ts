import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ProgramBox } from "./box.ts";

/** Lives on the container's writable filesystem: lost on restart unless snapshotted. */
const FILE = "/tmp/program-box.txt";

export default Cloudflare.Containers.Sandbox(
  ProgramBox,
  { main: import.meta.url, runtime: "node", sizes: { small: "lite", large: "standard-1" } },
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://container");
        if (url.pathname === "/write") {
          yield* fs.writeFileString(FILE, url.searchParams.get("text") ?? "");
          return HttpServerResponse.text("ok");
        }
        if (url.pathname === "/read") {
          const text = yield* fs.readFileString(FILE).pipe(Effect.orElseSucceed(() => ""));
          return HttpServerResponse.text(text);
        }
        return HttpServerResponse.text("program box");
      }).pipe(Effect.orDie),
    };
  }),
);

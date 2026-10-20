import * as FS from "alchemy/FS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { MountBox } from "./container.ts";

export const Settings = FS.File('{"model":"haiku"}\n');
export const Script = FS.File("#!/bin/sh\necho hi\n", { mode: 0o755 });
export const Folder = FS.Folder(`${import.meta.dirname}/folder`);

/** What landed on disk, gathered inside the container. */
const CHECK = `
set +e
echo "file=$(cat /etc/mounts/settings.json)"
echo "script=$(/usr/local/bin/hi)"
echo "folder=$(cat /opt/folder/a.txt)|$(cat /opt/folder/nested/b.txt)"
`;

export default MountBox.make(
  { main: import.meta.url, runtime: "node", image: "node:22-bookworm-slim" },
  Effect.gen(function* () {
    yield* FS.MountFile(Settings, { path: "/etc/mounts/settings.json" });
    yield* FS.MountFile(Script, { path: "/usr/local/bin/hi" });
    yield* FS.MountFolder(Folder, { path: "/opt/folder" });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (!request.url.endsWith("/check")) return HttpServerResponse.text("ok");
        const spawner = yield* ChildProcessSpawner;
        const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", CHECK]));
        const out = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
        return HttpServerResponse.text(out);
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
);

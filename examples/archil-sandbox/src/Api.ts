import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Repo } from "./Storage.ts";

/**
 * A program in its own Archil sandbox that runs commands against the shared
 * base while it runs: `POST /run` in a fresh microVM with Repo mounted
 * read-only, and `/users/:user/...` against the user's own disk, a copy of
 * the base made on their first request.
 */
export default class Api extends Archil.Sandbox<Api>()(
  "Api",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const repo = yield* Repo;
    const repoId = yield* repo.diskId;
    const exec = yield* Archil.ExecDisks();
    const disks = yield* Archil.CreateDisk();

    /** Runs a command in the repository, in a fresh microVM with the base mounted read-only. */
    const run = Effect.fn("run")(function* (command: string) {
      return yield* exec.exec({
        disks: { base: { disk: yield* repoId, readOnly: true } },
        command: `cd /mnt/archil/base/is && ${command}`,
      });
    });

    /** The user's disk: a copy of the base, made on their first request. */
    const userDisk = Effect.fn("userDisk")(function* (user: string) {
      const existing = yield* disks.get(`user-${user}`);
      if (existing !== undefined) return existing;
      const home = yield* disks.create(`user-${user}`);
      yield* exec.exec({
        disks: { base: { disk: yield* repoId, readOnly: true }, home: home.diskId },
        command: "cp -a /mnt/archil/base/. /mnt/archil/home/",
      });
      return home;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        if (request.method === "POST" && url.pathname === "/run") {
          return yield* HttpServerResponse.json(yield* run(yield* request.text));
        }

        const user = /^\/users\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
        if (request.method === "DELETE" && user !== undefined) {
          yield* disks.delete(`user-${user}`);
          return HttpServerResponse.empty({ status: 204 });
        }

        const runFor = /^\/users\/([a-z0-9-]+)\/run$/.exec(url.pathname)?.[1];
        if (request.method === "POST" && runFor !== undefined) {
          const home = yield* userDisk(runFor);
          return yield* HttpServerResponse.json(
            yield* home.exec(`cd /mnt/archil/is && ${yield* request.text}`),
          );
        }

        const match = /^\/users\/([a-z0-9-]+)\/files\/(.+)$/.exec(url.pathname);
        if (match !== null) {
          const [, owner, file] = match as unknown as [string, string, string];
          const home = yield* userDisk(owner);
          if (request.method === "PUT") yield* home.put(`is/${file}`, yield* request.text);
          return yield* HttpServerResponse.json({ content: yield* home.getText(`is/${file}`) });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Archil.ExecDisksHttp, Archil.CreateDiskHttp))),
) {}

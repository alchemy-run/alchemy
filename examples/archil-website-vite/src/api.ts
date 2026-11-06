import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { API_PORT, NotesDisk } from "./shared.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const json = (value: unknown, status = 200) =>
  HttpServerResponse.json(value, { status, headers: cors });

interface Note {
  id: number;
  body: string;
  createdAt: string;
}

/**
 * Effect HTTP API in its own Archil sandbox. Each note is a JSON file under
 * `notes/` on an Archil disk, read and written through ReadWriteDisk.
 */
export default class Api extends Archil.Sandbox<Api>()(
  "Api",
  { main: import.meta.url, port: API_PORT },
  Effect.gen(function* () {
    const notes = yield* Archil.ReadWriteDisk(NotesDisk);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://api").pathname;
        if (request.method === "OPTIONS") return yield* json({}, 204);
        if (path === "/health") return yield* json({ ok: true });
        if (path === "/notes" && request.method === "GET") {
          // The listing includes the `notes/` directory itself; read only the files.
          const keys = yield* notes.list("notes/").pipe(
            Stream.map((o) => o.key),
            Stream.filter((key) => key.endsWith(".json")),
            Stream.runCollect,
          );
          const all = yield* Effect.forEach(
            keys,
            (key) =>
              notes
                .getText(key)
                .pipe(Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as Note))),
            { concurrency: 8 },
          );
          return yield* json({ notes: all.sort((a, b) => b.id - a.id) });
        }
        if (path === "/notes" && request.method === "POST") {
          const payload = (yield* request.json) as { body?: unknown };
          const body = typeof payload.body === "string" ? payload.body.trim() : "";
          if (body.length === 0) return yield* json({ error: "body required" }, 400);
          const id = Date.now();
          const note: Note = { id, body, createdAt: new Date(id).toISOString() };
          yield* notes.put(`notes/${id}.json`, JSON.stringify(note), {
            contentType: "application/json",
          });
          return yield* json({ note }, 201);
        }
        return yield* json({ error: "not found" }, 404);
      }).pipe(Effect.catch((cause) => json({ ok: false, error: String(cause) }, 500))),
    };
  }).pipe(Effect.provide(Archil.ReadWriteDiskHttp)),
) {}

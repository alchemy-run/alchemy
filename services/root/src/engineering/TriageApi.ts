import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Triage, type TriageMode } from "./Triage.ts";

/**
 * The TRIAGE VALVE's wire — the UI panel the humans hold while the
 * company is young:
 *
 * - `GET  /api/triage`          — the held queue + the mode
 * - `POST /api/triage/release`  — `{ seqs?: number[] }`; none = all.
 *   Each released item becomes one waking input in the manager's inbox.
 * - `PUT  /api/triage/mode`     — `{ mode: "manual" | "auto" }`
 */
export const TriageApi = Effect.gen(function* () {
  const triage = yield* Triage;

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/triage",
      Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          mode: yield* triage.mode(),
          held: yield* triage.held(),
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/api/triage/release",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const posted = (yield* request.json.pipe(
          Effect.catch(() => Effect.succeed({})),
        )) as { seqs?: unknown };
        const seqs = Array.isArray(posted.seqs)
          ? posted.seqs.filter((seq): seq is number => typeof seq === "number")
          : undefined;
        const released = yield* triage.release(seqs);
        return yield* HttpServerResponse.json({ released });
      }),
    ),
    HttpRouter.add(
      "PUT",
      "/api/triage/mode",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const posted = (yield* request.json.pipe(
          Effect.catch(() => Effect.succeed({})),
        )) as { mode?: unknown };
        if (posted.mode !== "manual" && posted.mode !== "auto") {
          return yield* HttpServerResponse.json(
            { error: 'mode must be "manual" or "auto"' },
            { status: 400 },
          );
        }
        yield* triage.setMode(posted.mode as TriageMode);
        return yield* HttpServerResponse.json({ mode: posted.mode });
      }),
    ),
  );
});

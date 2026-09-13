import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** `${term}:${key}` → the session it names (the key may contain `:`). */
const parseSessionId = (id: string): { term: string; key: string } => {
  const at = id.indexOf(":");
  return at < 0
    ? { term: id, key: id }
    : { term: id.slice(0, at), key: id.slice(at + 1) };
};

/**
 * A PHANTOM thread identity — just enough `AI.Thread` for the sandbox
 * layer to derive the session's machine (it only reads `key`). Lets
 * the WORKER-level terminal door address a session's machine without
 * being inside the session.
 */
const phantomThread = (key: string): AI.ThreadService => ({
  key,
  tokens: Effect.succeed(0),
  entries: Effect.succeed([]),
  compact: () => Effect.void,
  reply: () => Effect.void,
  remind: () => Effect.void,
  publish: () => Effect.void,
});

/** Run one command in a session's WORKSPACE — REPL-grade, not a PTY
 *  (the PTY rides the `/terminal` socket). The cwd names the
 *  workspace (`@<name>` or `@<name>/sub`); the phantom session frame
 *  carries no default workspace, so a bare cwd fails closed. */
export const ExecApi = Effect.gen(function* () {
  // OPTIONAL: the terminal door needs the session machine seam
  const sandbox = yield* Effect.serviceOption(AI.Sandbox);

  return HttpRouter.add(
    "POST",
    "/api/sessions/:id/exec",
    Effect.gen(function* () {
      if (Option.isNone(sandbox)) {
        return yield* HttpServerResponse.json(
          { error: "no session sandbox on this placement" },
          { status: 404 },
        );
      }
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const { key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed({})),
      )) as { command?: string; cwd?: string };
      const command =
        typeof body.command === "string" ? body.command.trim() : "";
      if (command.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "command required" },
          { status: 400 },
        );
      }
      const result = yield* sandbox.value
        .exec(command, undefined, {
          timeout: 120_000,
          ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
        })
        .pipe(
          Effect.provideService(AI.Thread, phantomThread(key)),
          Effect.catch((error) =>
            Effect.succeed({
              success: false,
              exitCode: -1,
              stdout: "",
              stderr: String(error),
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 0,
            }),
          ),
        );
      return yield* HttpServerResponse.json(result);
    }),
  );
});

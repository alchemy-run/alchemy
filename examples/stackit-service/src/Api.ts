import * as Stackit from "@alchemy.run/stackit";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Box, PORT } from "./server.ts";

/**
 * An Effect program on a server: a systemd unit running bun. Each deploy bundles it on
 * your machine, hands it to the server through Run Command and a bucket, and restarts
 * the unit.
 *
 * - `GET /` returns the `GREETING` variable.
 * - `GET /commands` lists the server's Run Command history.
 *
 * A server has an identity of its own. Alchemy creates one service account for it and
 * attaches it, and `Stackit.RunCommand.ListCommands` grants that account what it needs.
 * The program signs with short-lived tokens from the server's metadata API, so no key
 * sits on the server.
 */
export default class Api extends Stackit.IaaS.Service<Api>()(
  "Api",
  Effect.gen(function* () {
    const { server, address } = yield* Box;
    return {
      server,
      main: import.meta.url,
      port: PORT,
      publicIp: address.ip,
      env: { GREETING: "hello from a server" },
    };
  }),
  Effect.gen(function* () {
    const { server } = yield* Box;
    const listCommands = yield* Stackit.RunCommand.ListCommands(server);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        switch (url.pathname) {
          case "/":
            return HttpServerResponse.text(yield* Config.String("GREETING"));
          case "/commands": {
            const commands = yield* listCommands();
            return yield* HttpServerResponse.json(commands);
          }
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Stackit.RunCommand.ListCommandsHttp)),
) {}

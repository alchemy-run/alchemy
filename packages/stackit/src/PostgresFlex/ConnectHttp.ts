import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connect, PasswordMissing, type ConnectionInfo } from "./Connect.ts";
import type { Database } from "./Database.ts";
import { connectionUrl, toRedacted } from "./internal.ts";
import type { User } from "./User.ts";

/**
 * Implementation of {@link Connect}. It makes no STACKIT API call: everything it
 * resolves comes from the attributes of the bound user and database.
 *
 * @layer
 * @provides Stackit.PostgresFlex.Connect
 */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (database: Database, user: User) {
    const host = yield* user.host;
    const port = yield* user.port;
    const username = yield* user.userName;
    const password = yield* user.password;
    const databaseName = yield* database.name;
    return Effect.gen(function* () {
      const name = yield* username;
      const secret = yield* password;
      if (secret === undefined) {
        return yield* new PasswordMissing({
          userName: name,
          message:
            `STACKIT PostgreSQL Flex user ${name} has no password on record. ` +
            "Set its rotationKey to reset the password.",
        });
      }
      const resolved = toRedacted(secret);
      const endpoint = {
        host: yield* host,
        port: yield* port,
        database: yield* databaseName,
        username: name,
      };
      const info: ConnectionInfo = {
        ...endpoint,
        password: resolved,
        url: connectionUrl({ ...endpoint, password: resolved }),
        ssl: true,
      };
      return info;
    });
  }),
);

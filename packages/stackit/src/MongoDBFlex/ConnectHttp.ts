import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connect, PasswordMissing, type ConnectionInfo } from "./Connect.ts";
import { toRedacted } from "./internal.ts";
import type { User } from "./User.ts";

/**
 * Implementation of {@link Connect}. It makes no STACKIT API call: everything it resolves
 * comes from the attributes of the bound user.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.Connect
 */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (user: User) {
    const host = yield* user.host;
    const port = yield* user.port;
    const database = yield* user.database;
    const username = yield* user.userName;
    const password = yield* user.password;
    const uri = yield* user.uri;
    return Effect.gen(function* () {
      const name = yield* username;
      const rawPassword = yield* password;
      const rawUri = yield* uri;
      const secret = toRedacted(rawPassword);
      const connectionString = toRedacted(rawUri);
      if (secret === undefined || connectionString === undefined) {
        return yield* new PasswordMissing({
          userName: name,
          message:
            `STACKIT MongoDB Flex user ${name} has no password or connection string on ` +
            "record. Set its rotationKey to reset them.",
        });
      }
      const info: ConnectionInfo = {
        host: yield* host,
        port: yield* port,
        database: yield* database,
        username: name,
        password: secret,
        uri: connectionString,
      };
      return info;
    });
  }),
);

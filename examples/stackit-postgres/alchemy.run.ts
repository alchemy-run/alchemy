import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { AppDatabase, AppUser, Db } from "./src/resources.ts";

export default Alchemy.Stack(
  "StackitPostgresExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const db = yield* Db;
    const user = yield* AppUser;
    const database = yield* AppDatabase;
    const api = yield* Api;

    return {
      url: api.url,
      projectId: db.projectId,
      region: db.region,
      instanceId: db.instanceId,
      databaseId: database.databaseId,
      databaseName: database.name,
      userName: user.userName,
      migrationsHashes: database.migrationsHashes,
    };
  }),
);

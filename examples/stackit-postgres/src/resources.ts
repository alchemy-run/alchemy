import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";

/**
 * The smallest single-node flavor. A Function has no fixed egress address, and migrations
 * connect from the machine running the deploy, so this instance takes connections from
 * everywhere, behind TLS and the generated password. Narrow `acl` when your hosts have
 * known addresses.
 */
export const Db = Stackit.PostgresFlex.Instance("Db", {
  flavorId: "2.4",
  version: "17",
  storage: { class: "premium-perf2-stackit", size: 5 },
  backupSchedule: "0 2 * * *",
  retentionDays: 32,
  acl: ["0.0.0.0/0"],
});

/** The login the migrations and the Function use. STACKIT generates its password. */
export const AppUser = Db.pipe(
  Effect.flatMap((db) => Stackit.PostgresFlex.User("AppUser", { instanceId: db.instanceId })),
);

/**
 * Each deploy applies the pending files in `./migrations`, logged in as the user that owns
 * the database, so it owns the tables they create.
 */
export const AppDatabase = Effect.gen(function* () {
  const db = yield* Db;
  const user = yield* AppUser;
  return yield* Stackit.PostgresFlex.Database("AppDatabase", {
    instanceId: db.instanceId,
    owner: user.userName,
    migrations: "./migrations",
    migrationsUser: user.userName,
    migrationsPassword: user.password,
  });
});

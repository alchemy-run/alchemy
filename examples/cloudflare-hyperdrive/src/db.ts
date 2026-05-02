import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";


export const MyDb = Effect.gen(function* () {
  return yield* Cloudflare.Hyperdrive("mydb", {
    // Production origin — used on `alchemy deploy`.
    origin: {
      scheme: "postgres",
      host: process.env.PGHOST!,           // e.g. "ep-xxx.us-east-1.aws.neon.tech"
      port: 5432,
      database: process.env.PGDATABASE!,
      user: process.env.PGUSER!,
      password: Redacted.make(process.env.PGPASSWORD!),
    },
    // Local dev origin — used on `alchemy dev`.
    dev: {
      scheme: "postgres",
      host: "localhost",
      port: 5432,
      database: "app",
      user: "app",
      password: Redacted.make("app"),
    },
  });
});

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";


export const MyDb = Effect.gen(function* () {
  /* console.log("host: ", process.env.PGHOST);
  console.log("database: ", process.env.PGDATABASE);
  console.log("user: ", process.env.PGUSER);
  console.log("password: ", process.env.PGPASSWORD); */
  return yield* Cloudflare.Hyperdrive("mydb", {
    origin: {
      scheme: "postgres",
      host: process.env.PGHOST!,           // e.g. "ep-xxx.us-east-1.aws.neon.tech"
      port: 5432,
      database: process.env.PGDATABASE!,
      user: process.env.PGUSER!,
      password: Redacted.make(process.env.PGPASSWORD!),
    },
  });
});

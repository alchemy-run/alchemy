import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import pg from "pg";
import { AppDb, Registry, Uploads } from "./resources.ts";

/**
 * An Effect HTTP API on App Platform. It stores files in Spaces with a key
 * scoped to one bucket, records visits in Postgres, and writes a nightly
 * report with a scheduled job.
 */
export default class Api extends DigitalOcean.App<Api>()(
  "Api",
  { main: import.meta.url, region: "nyc", registry: Registry },
  Effect.gen(function* () {
    const bucket = yield* Uploads;
    const putObject = yield* DigitalOcean.Spaces.PutObject(bucket);
    const getObject = yield* DigitalOcean.Spaces.GetObject(bucket);
    const conn = yield* DigitalOcean.Databases.Connect(AppDb);

    const query = (sql: string, params: unknown[] = []) =>
      Effect.gen(function* () {
        const uri = yield* conn.connectionString;
        // DigitalOcean signs the cluster's certificate with its own CA.
        const ca = yield* conn.caCertificate;
        return yield* Effect.tryPromise(async () => {
          const client = new pg.Client({
            connectionString: Redacted.value(uri).replace(/[?&]sslmode=[^&]*/, ""),
            ssl: { ca },
          });
          await client.connect();
          try {
            return (await client.query(sql, params)).rows;
          } finally {
            await client.end();
          }
        });
      });

    // A scheduled job runs the same image every night at 03:00 UTC.
    yield* DigitalOcean.cron("0 3 * * *", () =>
      Effect.gen(function* () {
        const rows = yield* query("SELECT count(*)::int AS visits FROM visits");
        yield* putObject({
          Key: "reports/latest.json",
          Body: JSON.stringify(rows[0]),
          ContentType: "application/json",
        });
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        yield* query("INSERT INTO visits (path) VALUES ($1)", [url.pathname]);
        if (request.method === "PUT") {
          const body = yield* request.text;
          yield* putObject({ Key: url.pathname.slice(1), Body: body });
          return HttpServerResponse.text("stored");
        }
        if (url.pathname === "/") return HttpServerResponse.text("ok");
        const object = yield* getObject({ Key: url.pathname.slice(1) });
        const text = object.Body ? yield* Stream.mkString(Stream.decodeText(object.Body)) : "";
        return HttpServerResponse.text(text);
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DigitalOcean.Spaces.PutObjectHttp,
        DigitalOcean.Spaces.GetObjectHttp,
        DigitalOcean.Databases.ConnectHttp,
        DigitalOcean.CronLive,
      ),
    ),
  ),
) {}

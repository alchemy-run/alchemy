import * as Athena from "@/AWS/Athena";
import * as Glue from "@/AWS/Glue";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Output from "@/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Fixed lowercase Glue identifiers so the SQL below is deterministic. The
// bucket and workgroup are engine-named (unique); the database/table are
// scoped to this single Athena e2e suite.
const DATABASE = "alchemy_athena_e2e";
const TABLE = "people";
const CSV = "1,alice\n2,bob\n3,carol\n";

export class AthenaTestFunction extends Lambda.Function<Lambda.Function>()(
  "AthenaTestFunction",
) {}

export default AthenaTestFunction.make(
  {
    main,
    url: true,
    // startQueryExecution → poll getQueryExecution → getQueryResults fans out
    // several SDK calls; AWS's 3s default would intermittently time out.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // Single bucket holds both the CSV source data (under data/) and the
    // Athena query results (under results/).
    const bucket = yield* S3.Bucket("AthenaBucket", { forceDestroy: true });

    const database = yield* Glue.Database("AthenaDatabase", {
      databaseName: DATABASE,
    });
    yield* Glue.Table("AthenaTable", {
      databaseName: database.databaseName,
      tableName: TABLE,
      tableType: "EXTERNAL_TABLE",
      storageDescriptor: {
        location: Output.interpolate`s3://${bucket.bucketName}/data/`,
        columns: [
          { name: "id", type: "string" },
          { name: "name", type: "string" },
        ],
        inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
        outputFormat:
          "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
        serdeInfo: {
          serializationLibrary:
            "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
          parameters: { "field.delim": "," },
        },
      },
    });

    const workGroup = yield* Athena.WorkGroup("AthenaWorkGroup", {
      outputLocation: Output.interpolate`s3://${bucket.bucketName}/results/`,
      enforceWorkGroupConfiguration: true,
    });

    const putObject = yield* S3.PutObject(bucket);
    const runQuery = yield* Athena.Query(workGroup, bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Seed the CSV source data into s3://bucket/data/.
        if (request.method === "POST" && pathname === "/seed") {
          yield* putObject({
            Key: "data/rows.csv",
            Body: CSV,
            ContentType: "text/csv",
          });
          return yield* HttpServerResponse.json({ seeded: true });
        }

        // Flagship: run a Glue-backed query end-to-end and read the result.
        if (request.method === "GET" && pathname === "/count") {
          const result = yield* runQuery({
            QueryString: `SELECT COUNT(*) AS c FROM ${DATABASE}.${TABLE}`,
          });
          return yield* HttpServerResponse.json({
            state: result.state,
            columns: result.columns,
            rows: result.rows,
          });
        }

        // Glue-free path: proves start+poll+results without any table.
        if (request.method === "GET" && pathname === "/select-one") {
          const result = yield* runQuery({ QueryString: "SELECT 1" });
          return yield* HttpServerResponse.json({
            state: result.state,
            columns: result.columns,
            rows: result.rows,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Athena.QueryHttp, S3.PutObjectHttp))),
);

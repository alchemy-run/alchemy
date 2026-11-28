import * as Render from "@alchemy.run/render";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RenderPostgresExample",
  {
    providers: Render.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const db = yield* Render.Postgres("Db", {
      plan: "basic_256mb",
      region: "oregon",
      version: "16",
      diskSizeGB: 5,
      ipAllowList: [{ cidrBlock: "0.0.0.0/0", description: "example" }],
      migrations: "./migrations",
    });

    const api = yield* Render.WebService(
      "Api",
      {
        plan: "free",
        region: "oregon",
        skipDeployAfterUpdate: true,
        runtimeSource: {
          image: {
            imagePath: "docker.io/nginxdemos/hello",
            tag: "plain-text",
          },
        },
      },
      Effect.gen(function* () {
        yield* Render.ConnectPostgres(db);
      }).pipe(Effect.provide(Render.ConnectPostgresHttp)),
    );

    return {
      dbId: db.id,
      url: api.url,
      databaseUrl: api.envVars[Render.DATABASE_URL_ENV],
      externalDbUrl: db.connectionInfo.externalConnectionString,
    };
  }),
);

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as SpacetimeDB from "alchemy/SpacetimeDB";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const Media = Cloudflare.R2.Bucket("Media", { forceDestroy: true });

export const Todos = SpacetimeDB.Database("Todos", {
  name: "alchemy-todo",
  modulePath: "./spacetimedb",
});

export const ClientBindings = SpacetimeDB.Generate("ClientBindings", {
  lang: "typescript",
  outDir: "./src/module_bindings",
  modulePath: "./spacetimedb",
});

export const Api = Cloudflare.Worker("Api", {
  main: "./worker/api.ts",
  compatibility: { flags: ["nodejs_compat"] },
  env: {
    MEDIA: Media,
    SPACETIMEDB_URI: Todos.uri,
    SPACETIMEDB_DATABASE_NAME: Todos.databaseName,
    SPACETIMEDB_HOST: Todos.host,
    SPACETIMEDB_IDENTITY: Todos.databaseIdentity,
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Api>;

export const Website = Cloudflare.Website.Vite("Website", {
  compatibility: { flags: ["nodejs_compat"] },
  assets: { notFoundHandling: "single-page-application" },
  env: {
    ...SpacetimeDB.viteEnv(Todos),
    VITE_API_URL: Api.url,
  },
});

export default Alchemy.Stack(
  "SpacetimeDBTodo",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      SpacetimeDB.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Todos;
    yield* ClientBindings;
    const api = yield* Api;
    const site = yield* Website;

    return {
      url: site.url.as<string>(),
      apiUrl: api.url.as<string>(),
      spacetimeUri: Todos.uri.as<string>(),
      databaseName: Todos.databaseName.as<string>(),
      dashboardUrl: Todos.dashboardUrl,
    };
  }),
);

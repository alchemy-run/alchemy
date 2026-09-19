import * as Forgejo from "@/Forgejo/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

const Fixture = Schema.Struct({
  baseUrl: Schema.String,
  token: Schema.String,
  username: Schema.String,
  // External instances can deliver through a tunnel forwarding local port 31426.
  webhookUrl: Schema.optional(Schema.String),
});
export const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* Effect.sync(
    () =>
      process.env.FORGEJO_TEST_CONFIG ??
      path.resolve("../../.alchemy/forgejo/fixture.json"),
  );
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Fixture))(
    yield* fs.readFileString(file),
  );
});
export const liveProviders = Layer.unwrap(
  fixture.pipe(Effect.map(Forgejo.providers)),
).pipe(Layer.orDie);

export const liveTest = (
  transform?: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
) => {
  const providers = Layer.unwrap(
    fixture.pipe(
      Effect.map((config) => {
        const layer = Forgejo.providers(config);
        return transform === undefined
          ? layer
          : layer.pipe(
              Layer.provide(
                Layer.effect(
                  HttpClient.HttpClient,
                  HttpClient.HttpClient.pipe(Effect.map(transform)),
                ),
              ),
            );
      }),
    ),
  );
  return Test.make({ providers: providers.pipe(Layer.orDie) });
};

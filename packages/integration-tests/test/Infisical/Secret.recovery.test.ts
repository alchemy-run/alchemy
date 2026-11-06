// These ownership handoffs need a controlled replacement interleaving. Normal
// resource lifecycle coverage runs against Infisical in Secret.test.ts.
import { Providers } from "@alchemy.run/infisical/Providers";
import { Secret, SecretProvider } from "@alchemy.run/infisical/Secret";
import { assert, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/infisical/Credentials";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const Metadata = Schema.Struct({
  key: Schema.String,
  value: Schema.optionalKey(Schema.String),
  isEncrypted: Schema.optionalKey(Schema.Boolean),
});
interface RemoteSecret {
  id: string;
  project: string;
  environment: string;
  path: string;
  name: string;
  value: string;
  comment: string;
  version: number;
  metadata: ReadonlyArray<typeof Metadata.Type>;
}
const Body = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.String),
  secretPath: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  secretValue: Schema.optionalKey(Schema.String),
  secretComment: Schema.optionalKey(Schema.String),
  secretMetadata: Schema.optionalKey(Schema.Array(Metadata)),
});

type SecretName = Resource<"Test.SecretName", { name: string }, { name: string }>;
const SecretName = Resource<SecretName>("Test.SecretName");
const declaration = {
  project: "project-main",
  environment: "dev",
  name: "KEY",
  value: "Authorization=initial",
};

const harness = () => {
  const world = { secrets: new Map<string, RemoteSecret>(), nextId: 0 };
  const required = (id: string) => {
    const secret = world.secrets.get(id);
    assert(secret, `Shared secret ${id} is missing`);
    return secret;
  };
  const secretJson = (secret: RemoteSecret) => ({
    id: secret.id,
    _id: secret.id,
    workspace: secret.project,
    environment: secret.environment,
    secretPath: secret.path,
    secretKey: secret.name,
    secretValue: secret.value,
    secretValueHidden: false,
    secretComment: secret.comment,
    secretMetadata: secret.metadata,
    type: "shared",
    version: secret.version,
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
  });
  const httpClient = HttpClient.make(
    Effect.fnUntraced(function* (request) {
      const url = Option.getOrThrow(HttpClientRequest.toUrl(request));
      const answer = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      const match = /^\/api\/v4\/secrets\/([^/]+)$/.exec(url.pathname);
      assert(match?.[1], `Unexpected path ${url.pathname}`);
      const name = decodeURIComponent(match[1]);
      const body = yield* Schema.decodeEffect(Schema.fromJsonString(Body))(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      ).pipe(Effect.orDie);
      const scope =
        request.method === "GET"
          ? {
              project: url.searchParams.get("projectId"),
              environment: url.searchParams.get("environment"),
              path: url.searchParams.get("secretPath") ?? "/",
              type: url.searchParams.get("type"),
            }
          : {
              project: body.projectId,
              environment: body.environment,
              path: body.secretPath ?? "/",
              type: body.type,
            };
      assert(scope.type === "shared", "Secret touched a non-shared row");
      const secret = [...world.secrets.values()].find(
        (row) =>
          row.project === scope.project &&
          row.environment === scope.environment &&
          row.path === scope.path &&
          row.name === name,
      );
      if (request.method === "GET") {
        return secret
          ? answer({ secret: secretJson(secret) })
          : answer({ message: "Secret not found" }, 404);
      }
      if (request.method === "POST") {
        assert(body.projectId && body.environment && body.secretValue !== undefined);
        assert(!secret, "A shared row already exists at this key");
        const created = {
          id: `secret-${++world.nextId}`,
          project: body.projectId,
          environment: body.environment,
          path: body.secretPath ?? "/",
          name,
          value: body.secretValue,
          comment: body.secretComment ?? "",
          metadata: body.secretMetadata ?? [],
          version: 1,
        };
        world.secrets.set(created.id, created);
        return answer({ secret: secretJson(created) });
      }
      if (!secret) return answer({ message: "Secret not found" }, 404);
      if (request.method === "PATCH") {
        secret.value = body.secretValue ?? secret.value;
        secret.comment = body.secretComment ?? secret.comment;
        secret.metadata = body.secretMetadata ?? secret.metadata;
        secret.version++;
        return answer({ secret: secretJson(secret) });
      }
      if (request.method === "DELETE") {
        world.secrets.delete(secret.id);
        return answer({ secret: secretJson(secret) });
      }
      return yield* Effect.die(`Unexpected ${request.method} ${url.href}`);
    }),
  );
  const providers = Layer.mergeAll(
    Provider.succeed(SecretName, {
      list: () => Effect.succeed([]),
      reconcile: ({ news }) => Effect.succeed(news),
      delete: () => Effect.void,
    }),
    Layer.effect(Providers, Provider.collection([Secret])).pipe(
      Layer.provideMerge(SecretProvider()),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Credentials,
          Effect.succeed({ apiKey: Redacted.make("test"), apiBaseUrl: "https://infisical.test" }),
        ),
        Layer.succeed(HttpClient.HttpClient, httpClient),
      ),
    ),
  );
  return { world, required, api: Test.make({ providers }) };
};

const options = {
  retry: 0,
  timeout: 90_000,
  tags: ["unit", "provider:infisical", "provider:infisical:secret"],
};

const replacement = harness();
replacement.api.test.provider(
  "keeps a shared row when an unresolved replacement name resolves to the same key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(Secret("Secret", declaration));
      const firstInstance = replacement
        .required(first.id)
        .metadata.find(({ key }) => key === "alchemy::instance")?.value;
      expect(firstInstance).toEqual(expect.any(String));
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* SecretName("ReplacementName", { name: "KEY" });
          return yield* Secret("Secret", { ...declaration, name: key.name });
        }),
      );
      expect(replaced.id).toBe(first.id);
      const row = replacement.required(first.id);
      expect(row.name).toBe("KEY");
      expect(row.value).toBe(declaration.value);
      expect(row.metadata.find(({ key }) => key === "alchemy::instance")?.value).not.toBe(
        firstInstance,
      );
      expect(replacement.world.secrets.size).toBe(1);
      yield* stack.destroy();
      expect(replacement.world.secrets.size).toBe(0);
    }),
  options,
);

const handoff = harness();
handoff.api.test.provider(
  "leaves a shared row owned by a newer instance when deleting the old instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(Secret("Secret", declaration));
      const row = handoff.required(first.id);
      row.metadata = row.metadata.map((entry) =>
        entry.key === "alchemy::instance" ? { ...entry, value: "newer-instance" } : entry,
      );
      const before = { ...row };
      yield* stack.destroy();
      expect(handoff.required(first.id)).toEqual(before);
      handoff.world.secrets.delete(first.id);
      yield* stack.destroy();
      expect(handoff.world.secrets.size).toBe(0);
    }),
  options,
);

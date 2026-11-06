// Ownership handoffs and pending-approval failures need controlled API responses;
// the normal lifecycle runs against Infisical in Secret.test.ts.
import { Providers } from "@alchemy.run/infisical/Providers";
import { Secret, SecretError, SecretProvider } from "@alchemy.run/infisical/Secret";
import { assert, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import type { CreateManySecretsV4ResponseBodyCase1Approval } from "@distilled.cloud/infisical";
import { Credentials } from "@distilled.cloud/infisical/Credentials";
import { DestroyError } from "alchemy/Apply";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { State } from "alchemy/State/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  type: "shared" | "personal";
  userId?: string;
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
  const world: {
    secrets: Map<string, RemoteSecret>;
    nextId: number;
    userId: string;
    approvalFor: "POST" | "PATCH" | "DELETE" | undefined;
  } = { secrets: new Map(), nextId: 0, userId: "user-main", approvalFor: undefined };
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
    type: secret.type,
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
      const secret = [...world.secrets.values()].find(
        (row) =>
          row.project === scope.project &&
          row.environment === scope.environment &&
          row.path === scope.path &&
          row.name === name &&
          row.type === scope.type &&
          (row.type === "shared" || row.userId === world.userId),
      );
      if (request.method === "GET") {
        return secret
          ? answer({ secret: secretJson(secret) })
          : answer({ message: "Secret not found" }, 404);
      }
      if (request.method === world.approvalFor) {
        const approval: CreateManySecretsV4ResponseBodyCase1Approval = {
          id: `approval-${request.method.toLowerCase()}`,
          policyId: "policy-main",
          status: "open",
          hasMerged: false,
          slug: "pending-secret-change",
          folderId: "folder-main",
          createdAt: "2026-11-05T00:00:00Z",
          updatedAt: "2026-11-05T00:00:00Z",
        };
        return answer({ approval });
      }
      if (request.method === "POST") {
        assert(body.projectId && body.environment && body.secretValue !== undefined);
        assert(!secret, "A shared row already exists at this key");
        const created: RemoteSecret = {
          id: `secret-${++world.nextId}`,
          project: body.projectId,
          environment: body.environment,
          path: body.secretPath ?? "/",
          name,
          type: body.type === "personal" ? "personal" : "shared",
          ...(body.type === "personal" ? { userId: world.userId } : {}),
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
        for (const row of world.secrets.values()) {
          if (
            row.id === secret.id ||
            (secret.type === "shared" &&
              row.project === secret.project &&
              row.environment === secret.environment &&
              row.path === secret.path &&
              row.name === secret.name)
          ) {
            world.secrets.delete(row.id);
          }
        }
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

const expectSecretError = (exit: Exit.Exit<unknown, unknown>, detail: string) => {
  assert(Exit.isFailure(exit), "The secret operation unexpectedly succeeded");
  let failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  if (failure instanceof DestroyError) {
    const entry = failure.failures[0];
    assert(entry, "DestroyError did not include the failed secret");
    failure = Option.getOrThrow(Cause.findErrorOption(entry.cause));
  }
  if (failure instanceof Drift.DriftResourceError) failure = failure.cause;
  assert(failure instanceof SecretError, "The secret operation did not return SecretError");
  expect(failure.message).toContain(detail);
  return failure;
};

const savedSecret = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    return yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Secret" });
  }).pipe(Effect.provide(stack.state));

const personal = harness();
personal.api.test.provider(
  "creates and updates only the shared row, then deletes every personal override with its key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const overrides = ["user-one", "user-two"].map((userId): RemoteSecret => ({
        ...declaration,
        id: `personal-${userId}`,
        type: "personal",
        userId,
        path: "/",
        value: `personal-value-${userId}`,
        comment: "Personal override",
        version: 3,
        metadata: [{ key: "note", value: userId }],
      }));
      for (const row of overrides) personal.world.secrets.set(row.id, { ...row });
      const first = yield* stack.deploy(Secret("Secret", declaration));
      for (const row of overrides) expect(personal.required(row.id)).toEqual(row);
      const updated = yield* stack.deploy(
        Secret("Secret", { ...declaration, value: "rotated", comment: "Updated" }),
      );
      expect(updated.id).toBe(first.id);
      expect(personal.required(first.id)).toMatchObject({ value: "rotated", comment: "Updated" });
      for (const row of overrides) expect(personal.required(row.id)).toEqual(row);
      yield* stack.destroy();
      expect(personal.world.secrets.size).toBe(0);
    }),
  options,
);

for (const repair of [false, true]) {
  const foreign = harness();
  foreign.api.test.provider(
    `refuses a substituted foreign row during ${repair ? "drift repair" : "redeploy"} and leaves it unchanged`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const first = yield* stack.deploy(Secret("Secret", declaration));
        const substituted: RemoteSecret = {
          ...foreign.required(first.id),
          id: "foreign-secret",
          value: "Foreign value",
          comment: "Foreign comment",
          version: 7,
          metadata: [{ key: "managed-by", value: "someone-else" }],
        };
        foreign.world.secrets.delete(first.id);
        foreign.world.secrets.set(substituted.id, { ...substituted });
        const failed = yield* Effect.exit(
          repair
            ? Drift.repair({ name: stack.name, stage: stack.stage }).pipe(
                Effect.provide(stack.state),
                Effect.asVoid,
              )
            : stack.deploy(Secret("Secret", declaration)).pipe(Effect.asVoid),
        );
        const error = expectSecretError(failed, substituted.id);
        expect(error.message).toContain("delete");
        expect(error.message).toContain("alchemy state rm");
        expect(error.message).toContain("--adopt");
        expect(foreign.required(substituted.id)).toEqual(substituted);
        yield* stack.destroy();
        expect(foreign.required(substituted.id)).toEqual(substituted);
        foreign.world.secrets.delete(substituted.id);
        yield* stack.destroy();
      }),
    options,
  );
}

for (const operation of [
  { action: "create", method: "POST" },
  { action: "update", method: "PATCH" },
  { action: "delete", method: "DELETE" },
] as const) {
  const pending = harness();
  pending.api.test.provider(
    `fails a pending ${operation.action} approval without forgetting or changing the shared row`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const first =
          operation.action === "create"
            ? undefined
            : yield* stack.deploy(Secret("Secret", declaration));
        const original = first ? { ...pending.required(first.id) } : undefined;
        pending.world.approvalFor = operation.method;
        const failed = yield* Effect.exit(
          (operation.action === "delete"
            ? stack.destroy()
            : stack.deploy(Secret("Secret", { ...declaration, value: "requested" }))
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pending.world.approvalFor = undefined;
              }),
            ),
          ),
        );
        const error = expectSecretError(failed, `approval-${operation.method.toLowerCase()}`);
        expect(error.message).toContain("approve it in Infisical");
        expect(error.message).toContain("deploy again");
        if (original) {
          expect(pending.required(original.id)).toEqual(original);
        } else {
          expect(pending.world.secrets.size).toBe(0);
        }
        if (operation.action === "delete") {
          expect(yield* savedSecret(stack)).toMatchObject({ attr: { id: first?.id } });
        }
        yield* stack.destroy();
        expect(pending.world.secrets.size).toBe(0);
        expect(yield* savedSecret(stack)).toBeUndefined();
      }),
    options,
  );
}
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

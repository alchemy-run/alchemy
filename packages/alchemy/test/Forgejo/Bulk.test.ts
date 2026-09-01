import { Repository, Secrets, Variables, providers } from "@/Forgejo/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { json, mockForgejo, noContent, status } from "./support/mock.ts";

const secrets = new Map<string, string>();
const variables = new Map<string, string>();

const reset = () => {
  secrets.clear();
  variables.clear();
  server.reset();
};

const repository = {
  id: 1,
  name: "api",
  full_name: "acme/api",
  html_url: "https://forge.example/acme/api",
  clone_url: "https://forge.example/acme/api.git",
  ssh_url: "git@forge.example:acme/api.git",
  default_branch: "main",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  owner: { login: "acme" },
};

const server = mockForgejo(({ method, path, body }) => {
  const fields = body as Record<string, string> | undefined;

  if (method === "GET" && path === "/user") return json({ login: "acme" });
  if (path === "/repos/acme/api" || path === "/repositories/1") {
    if (method === "GET") return json(repository);
    if (method === "PATCH") return json(repository);
  }
  if (method === "GET" && path === "/repos/acme/api/topics") {
    return json({ topics: [] });
  }

  const secret = path.match(/^\/repos\/acme\/api\/actions\/secrets\/(.+)$/);
  if (secret !== null) {
    if (method === "PUT") {
      secrets.set(secret[1]!, fields!.data!);
      return noContent();
    }
    if (method === "DELETE") {
      secrets.delete(secret[1]!);
      return noContent();
    }
  }

  const variable = path.match(/^\/repos\/acme\/api\/actions\/variables\/(.+)$/);
  if (variable !== null) {
    if (method === "GET") {
      const value = variables.get(variable[1]!);
      return value === undefined
        ? status(404)
        : json({ name: variable[1], data: value });
    }
    if (method === "POST" || method === "PUT") {
      variables.set(variable[1]!, fields!.value!);
      return noContent();
    }
    if (method === "DELETE") {
      variables.delete(variable[1]!);
      return noContent();
    }
  }

  return undefined;
});

const { test } = Test.make({
  providers: providers({
    baseUrl: "https://forge.example",
    token: "admin-token",
  }).pipe(Layer.provide(server.layer)),
});

test.provider("writes every entry of a bulk secret map", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Effect.gen(function* () {
        yield* Secrets({
          owner: "acme",
          repository: "api",
          secrets: {
            DEPLOY_TOKEN: Redacted.make("deploy"),
            NPM_TOKEN: "npm",
          },
        });
      }),
    );

    expect(Object.fromEntries(secrets)).toEqual({
      DEPLOY_TOKEN: "deploy",
      NPM_TOKEN: "npm",
    });
  }),
);

test.provider("resolves a secret value that arrives as an Output", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Effect.gen(function* () {
        const repo = yield* Repository("Repo", {
          owner: "acme",
          name: "api",
        });
        // The value is only known after the repository reconciles, so it
        // reaches `Secrets` as an unresolved `Output`. Casting it to
        // `Redacted` instead of lifting through the input would hand the
        // provider a plain string to call `Redacted.value` on.
        yield* Secrets({
          owner: "acme",
          repository: "api",
          secrets: { REPO_FULL_NAME: repo.fullName },
        });
      }),
    );

    expect(secrets.get("REPO_FULL_NAME")).toBe("acme/api");
  }),
);

test.provider("writes every entry of a bulk variable map", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Effect.gen(function* () {
        yield* Variables({
          owner: "acme",
          repository: "api",
          variables: { DEPLOY_STAGE: "production", REGION: "us-east-1" },
        });
      }),
    );

    expect(Object.fromEntries(variables)).toEqual({
      DEPLOY_STAGE: "production",
      REGION: "us-east-1",
    });
  }),
);

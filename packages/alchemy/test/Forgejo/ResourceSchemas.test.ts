import { Repository, Secret, Variable, Webhook } from "@/Forgejo/index.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  json,
  jsonList,
  mockForgejo,
  noContent,
  status,
} from "./support/mock.ts";
import { forgejoTest } from "./support/stack.ts";

const REPO = "/repos/alice/alchemy";
const TOPICS = `${REPO}/topics`;
const VARIABLE = `${REPO}/actions/variables/DEPLOY_ENV`;
const SECRET = `${REPO}/actions/secrets/DEPLOY_TOKEN`;
const HOOKS = `${REPO}/hooks`;

let repository: Record<string, unknown> | undefined;
let topics: string[] = [];
let variable: string | undefined;
let secret: string | undefined;
let webhook: Record<string, unknown> | undefined;

const repositoryResponse = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  name: "alchemy",
  full_name: "alice/alchemy",
  html_url: "https://forge.example/alice/alchemy",
  clone_url: "https://forge.example/alice/alchemy.git",
  ssh_url: "git@forge.example:alice/alchemy.git",
  default_branch: "main",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  owner: { login: "alice" },
  ...overrides,
});

const server = mockForgejo((request) => {
  const { method, path, body } = request;

  if (method === "GET" && path === "/user") return json({ login: "alice" });

  if (method === "POST" && path === "/user/repos") {
    repository = repositoryResponse(body as Record<string, unknown>);
    return json(repository, 201);
  }

  if (path === REPO || path === "/repositories/7") {
    if (method === "GET") {
      return repository === undefined
        ? status(404, "not found")
        : json(repository);
    }
    if (method === "PATCH") {
      repository = repositoryResponse({ ...repository, ...(body as object) });
      return json(repository);
    }
    if (method === "DELETE") {
      repository = undefined;
      return noContent();
    }
  }

  if (path === TOPICS) {
    if (method === "GET") return json({ topics });
    if (method === "PUT") {
      topics = [...(body as { topics: string[] }).topics];
      return noContent();
    }
  }

  if (path === VARIABLE) {
    if (method === "GET") {
      // Forgejo returns the stored value under `data`, not `value`.
      return variable === undefined
        ? status(404, "not found")
        : json({ name: "DEPLOY_ENV", data: variable });
    }
    if (method === "POST" || method === "PUT") {
      variable = (body as { value: string }).value;
      return noContent();
    }
    if (method === "DELETE") {
      variable = undefined;
      return noContent();
    }
  }

  if (path === SECRET) {
    if (method === "PUT") {
      secret = (body as { data: string }).data;
      return noContent();
    }
    if (method === "DELETE") {
      secret = undefined;
      return noContent();
    }
  }

  if (path === HOOKS) {
    if (method === "GET") {
      return jsonList(request, webhook === undefined ? [] : [webhook]);
    }
    if (method === "POST") {
      webhook = {
        id: 11,
        url: "",
        updated_at: "2026-01-03T00:00:00Z",
        ...(body as object),
      };
      return json(webhook, 201);
    }
  }

  if (path === `${HOOKS}/11`) {
    if (method === "GET") {
      return webhook === undefined ? status(404, "not found") : json(webhook);
    }
    if (method === "PATCH") {
      webhook = { ...webhook, ...(body as object) };
      return json(webhook);
    }
    if (method === "DELETE") {
      webhook = undefined;
      return noContent();
    }
  }

  return undefined;
});

const reset = () => {
  repository = undefined;
  topics = [];
  variable = undefined;
  secret = undefined;
  webhook = undefined;
  server.reset();
};

const { test } = forgejoTest(server);

test.provider("uses the Forgejo repository create and edit schemas", (stack) =>
  Effect.gen(function* () {
    reset();

    const output = yield* stack.deploy(
      Repository("Repository", {
        owner: "alice",
        name: "alchemy",
        description: "Managed by Alchemy",
        website: "https://example.com/alchemy",
        private: true,
        hasIssues: false,
        hasProjects: true,
        hasWiki: false,
        hasPullRequests: true,
        hasReleases: true,
        hasPackages: false,
        hasActions: true,
        archived: false,
        defaultBranch: "main",
        autoInit: true,
        gitignores: "Node",
        license: "MIT",
        readme: "Default",
        template: false,
        objectFormatName: "sha256",
        topics: ["infrastructure", "forgejo"],
      }),
    );

    expect(output).toMatchObject({
      repoId: 7,
      fullName: "alice/alchemy",
      defaultBranch: "main",
    });
    expect(server.find("POST", "/user/repos")?.body).toEqual({
      name: "alchemy",
      description: "Managed by Alchemy",
      private: true,
      auto_init: true,
      default_branch: "main",
      gitignores: "Node",
      license: "MIT",
      readme: "Default",
      template: false,
      object_format_name: "sha256",
    });
    expect(server.find("PATCH", REPO)?.body).toMatchObject({
      website: "https://example.com/alchemy",
      has_issues: false,
      has_projects: true,
      has_wiki: false,
      has_pull_requests: true,
      has_releases: true,
      has_packages: false,
      has_actions: true,
      archived: false,
    });
    expect(server.find("PUT", TOPICS)?.body).toEqual({
      topics: ["infrastructure", "forgejo"],
    });
  }),
);

test.provider("uses the Actions variable create and update schemas", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Variable("DeployEnvironment", {
        owner: "alice",
        repository: "alchemy",
        name: "DEPLOY_ENV",
        value: "staging",
      }),
    );
    yield* stack.deploy(
      Variable("DeployEnvironment", {
        owner: "alice",
        repository: "alchemy",
        name: "DEPLOY_ENV",
        value: "production",
      }),
    );

    // Forgejo splits the two: `POST` creates the variable, `PUT` updates it.
    expect(server.find("POST", VARIABLE)?.body).toEqual({ value: "staging" });
    expect(server.find("PUT", VARIABLE)?.body).toEqual({ value: "production" });
    expect(variable).toBe("production");
  }),
);

test.provider("skips the write when a variable already matches", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Variable("DeployEnvironment", {
        owner: "alice",
        repository: "alchemy",
        name: "DEPLOY_ENV",
        value: "staging",
      }),
    );

    server.reset();
    yield* stack.deploy(
      Variable("DeployEnvironment", {
        owner: "alice",
        repository: "alchemy",
        name: "DEPLOY_ENV",
        value: "staging",
      }),
    );

    // The observed value already matches, so reconciliation issues no write.
    expect(
      server.requests.filter(
        ({ method }) => method === "PUT" || method === "POST",
      ),
    ).toEqual([]);
    expect(variable).toBe("staging");
  }),
);

test.provider(
  "uses the Actions secret schema without exposing redaction wrappers",
  (stack) =>
    Effect.gen(function* () {
      reset();

      yield* stack.deploy(
        Secret("DeployToken", {
          owner: "alice",
          repository: "alchemy",
          name: "DEPLOY_TOKEN",
          value: Redacted.make("line one\nline two & symbols"),
        }),
      );

      expect(server.find("PUT", SECRET)?.body).toEqual({
        data: "line one\nline two & symbols",
      });
      expect(secret).toBe("line one\nline two & symbols");
    }),
);

test.provider("uses the webhook create and edit schemas", (stack) =>
  Effect.gen(function* () {
    reset();

    const created = yield* stack.deploy(
      Webhook("DeployHook", {
        owner: "alice",
        repository: "alchemy",
        url: "https://deploy.example/hooks/forgejo",
        events: ["push", "pull_request"],
        secret: Redacted.make("signing-secret"),
        contentType: "form",
        active: false,
        branchFilter: "main",
        authorizationHeader: Redacted.make("Bearer deploy-token"),
      }),
    );
    expect(created).toMatchObject({
      webhookId: 11,
      url: "https://deploy.example/hooks/forgejo",
    });

    yield* stack.deploy(
      Webhook("DeployHook", {
        owner: "alice",
        repository: "alchemy",
        url: "https://deploy.example/hooks/forgejo-v2",
      }),
    );

    expect(server.find("POST", HOOKS)?.body).toEqual({
      type: "forgejo",
      active: false,
      events: ["push", "pull_request"],
      branch_filter: "main",
      authorization_header: "Bearer deploy-token",
      config: {
        url: "https://deploy.example/hooks/forgejo",
        content_type: "form",
        secret: "signing-secret",
      },
    });
    // `CreateHookOption` carries `type`; `EditHookOption` does not, so the
    // edit body must not send it.
    expect(server.find("PATCH", `${HOOKS}/11`)?.body).toEqual({
      active: true,
      events: ["push"],
      config: {
        url: "https://deploy.example/hooks/forgejo-v2",
        content_type: "json",
      },
    });
  }),
);

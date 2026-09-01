import {
  Repository,
  Secret,
  Variable,
  Webhook,
  providers,
} from "@/Forgejo/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

interface RecordedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

const requests: RecordedRequest[] = [];
let repository: Record<string, unknown> | undefined;
let variable: string | undefined;
let secret: string | undefined;
let webhook: Record<string, unknown> | undefined;
let topics: string[] = [];

const record = (request: HttpClientRequest.HttpClientRequest) => {
  const body =
    request.body._tag === "Uint8Array"
      ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
      : undefined;
  requests.push({
    method: request.method,
    pathname: new URL(request.url).pathname,
    body,
  });
  return body;
};

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

const route = (request: HttpClientRequest.HttpClientRequest): Response => {
  const url = new URL(request.url);
  const body = record(request);

  if (request.method === "GET" && url.pathname === "/api/v1/user") {
    return Response.json({ login: "alice" });
  }

  if (url.pathname === "/api/v1/repos/alice/alchemy") {
    if (request.method === "GET") {
      return repository === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(repository);
    }
    if (request.method === "PATCH") {
      repository = repositoryResponse({ ...repository, ...(body as object) });
      return Response.json(repository);
    }
    if (request.method === "DELETE") {
      repository = undefined;
      return new Response(null, { status: 204 });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/v1/user/repos") {
    repository = repositoryResponse(body as Record<string, unknown>);
    return Response.json(repository, { status: 201 });
  }

  if (url.pathname === "/api/v1/repos/alice/alchemy/topics") {
    if (request.method === "GET") {
      return Response.json({ topics });
    }
    if (request.method === "PUT") {
      topics = [...(body as { topics: string[] }).topics];
      return new Response(null, { status: 204 });
    }
  }

  if (url.pathname === "/api/v1/repositories/7") {
    return repository === undefined
      ? new Response("not found", { status: 404 })
      : Response.json(repository);
  }

  const variablePath =
    "/api/v1/repos/alice/alchemy/actions/variables/DEPLOY_ENV";
  if (url.pathname === variablePath) {
    if (request.method === "GET") {
      // Forgejo returns the stored value under `data`, not `value`.
      return variable === undefined
        ? new Response("not found", { status: 404 })
        : Response.json({ name: "DEPLOY_ENV", data: variable });
    }
    if (request.method === "POST" || request.method === "PUT") {
      variable = (body as { value: string }).value;
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      variable = undefined;
      return new Response(null, { status: 204 });
    }
  }

  const secretPath = "/api/v1/repos/alice/alchemy/actions/secrets/DEPLOY_TOKEN";
  if (url.pathname === secretPath) {
    if (request.method === "PUT") {
      secret = (body as { data: string }).data;
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      secret = undefined;
      return new Response(null, { status: 204 });
    }
  }

  const hooksPath = "/api/v1/repos/alice/alchemy/hooks";
  if (url.pathname === hooksPath && request.method === "GET") {
    return Response.json(webhook === undefined ? [] : [webhook]);
  }
  if (url.pathname === hooksPath && request.method === "POST") {
    webhook = {
      id: 11,
      url: "",
      updated_at: "2026-01-03T00:00:00Z",
      ...(body as object),
    };
    return Response.json(webhook, { status: 201 });
  }
  if (url.pathname === `${hooksPath}/11`) {
    if (request.method === "GET") {
      return webhook === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(webhook);
    }
    if (request.method === "PATCH") {
      webhook = { ...webhook, ...(body as object) };
      return Response.json(webhook);
    }
    if (request.method === "DELETE") {
      webhook = undefined;
      return new Response(null, { status: 204 });
    }
  }

  return new Response(`unhandled: ${request.method} ${url.pathname}`, {
    status: 500,
  });
};

const httpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, route(request))),
  ),
);

const reset = () => {
  requests.length = 0;
  repository = undefined;
  topics = [];
  variable = undefined;
  secret = undefined;
  webhook = undefined;
};

const { test } = Test.make({
  providers: providers({
    baseUrl: "https://forge.example",
    token: "admin-token",
  }).pipe(Layer.provide(httpClient)),
});

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
    expect(
      requests.find(
        ({ method, pathname }) =>
          method === "POST" && pathname.endsWith("/user/repos"),
      )?.body,
    ).toEqual({
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
    expect(
      requests.find(({ method }) => method === "PATCH")?.body,
    ).toMatchObject({
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
    expect(
      requests.find(
        ({ method, pathname }) =>
          method === "PUT" && pathname.endsWith("/topics"),
      )?.body,
    ).toEqual({
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

    expect(
      requests.filter(({ pathname }) => pathname.endsWith("/DEPLOY_ENV")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "POST", body: { value: "staging" } }),
        expect.objectContaining({
          method: "PUT",
          body: { value: "production" },
        }),
      ]),
    );
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

    requests.length = 0;
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
      requests.filter(({ method }) => method === "PUT" || method === "POST"),
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

      expect(
        requests.find(({ pathname }) => pathname.endsWith("/DEPLOY_TOKEN"))
          ?.body,
      ).toEqual({
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

    const create = requests.find(
      ({ method, pathname }) =>
        method === "POST" && pathname.endsWith("/hooks"),
    );
    expect(create?.body).toEqual({
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
    const edit = requests.find(
      ({ method, pathname }) =>
        method === "PATCH" && pathname.endsWith("/hooks/11"),
    );
    expect(edit?.body).toEqual({
      type: "forgejo",
      active: true,
      events: ["push"],
      config: {
        url: "https://deploy.example/hooks/forgejo-v2",
        content_type: "json",
      },
    });
  }),
);

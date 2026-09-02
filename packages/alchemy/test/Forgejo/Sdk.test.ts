import { fromToken, normalizeBaseUrl } from "@/Forgejo/Credentials.ts";
import { type Credentials, Retry, Services } from "@distilled.cloud/forgejo";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { json, mockForgejo, noContent, status } from "./support/mock.ts";

/**
 * The generated SDK's wire behaviour, as the provider depends on it: how a
 * credential reaches the request, how responses and failures come back. The
 * typed failures asserted here are the ones the lifecycle code branches on —
 * including the two the Swagger document does not declare and `patches/`
 * add — so a regeneration that lost them fails here rather than in a
 * destroy.
 */

const run = <A, E>(
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  body: Effect.Effect<A, E, Credentials | HttpClient.HttpClient | Retry.Retry>,
) =>
  Effect.runPromise(
    body.pipe(
      // A mocked failure must surface immediately, not after the default
      // policy's eight retries of a "transient" 5xx.
      Retry.none,
      Effect.provide(
        fromToken({ baseUrl: "https://forge.example", token: "secret" }),
      ),
      Effect.provide(httpClient),
    ),
  );

const runResult = <A, E>(
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  body: Effect.Effect<A, E, Credentials | HttpClient.HttpClient | Retry.Retry>,
) => run(httpClient, Effect.result(body));

describe("normalizeBaseUrl", () => {
  test("appends the Forgejo API path once", () => {
    expect(normalizeBaseUrl("https://forge.example/")).toBe(
      "https://forge.example/api/v1",
    );
    expect(normalizeBaseUrl("https://forge.example/api/v1")).toBe(
      "https://forge.example/api/v1",
    );
  });
});

describe("Forgejo SDK", () => {
  test("sends token authentication and a JSON body", async () => {
    const server = mockForgejo(() => json({ id: 42, name: "api" }));

    const result = await run(
      server.layer,
      Services.repository.createCurrentUserRepo({ name: "api" }),
    );

    expect(result).toMatchObject({ id: 42 });
    const request = server.find("POST", "/user/repos");
    expect(request?.body).toEqual({ name: "api" });
    // Forgejo's access tokens use the `token` scheme, not `Bearer`.
    expect(request?.headers.authorization).toBe("token secret");
  });

  test("appends query parameters, omitting undefined entries", async () => {
    const server = mockForgejo(() => json([]));

    await run(
      server.layer,
      Services.user.userCurrentListRepos({
        page: 2,
        limit: 50,
        order_by: undefined,
      }),
    );

    expect(server.requests[0]?.query).toEqual({ page: "2", limit: "50" });
  });

  test("accepts an empty successful response", async () => {
    const server = mockForgejo(() => noContent());

    const result = await runResult(
      server.layer,
      Services.repository.repoDelete({ owner: "acme", repo: "api" }),
    );

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("maps 404 to a NotFound tag carrying the response text", async () => {
    const server = mockForgejo(() => status(404, "missing"));

    const result = await runResult(
      server.layer,
      Services.repository.repoGet({ owner: "acme", repo: "missing" }),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "NotFound",
        message: "missing",
      });
    }
  });

  test("maps 403 to a Forbidden tag on a patched list endpoint", async () => {
    // The Swagger document declares no 403 on the organization secret list;
    // `patches/organization/_errors.json` adds it so enumeration can skip an
    // organization the credential is not a member of.
    const server = mockForgejo(() => status(403, "denied"));

    const result = await runResult(
      server.layer,
      Services.organization.orgListActionsSecrets({ org: "acme" }),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ _tag: "Forbidden" });
    }
  });

  test("maps a 5xx to its status tag", async () => {
    const server = mockForgejo(() => status(502, "bad gateway"));

    const result = await runResult(
      server.layer,
      Services.user.userGetCurrent({}),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "BadGateway",
        message: "bad gateway",
      });
    }
  });

  test("maps a 5xx that is really a dependency violation to its own tag", async () => {
    // Forgejo 16.0.3 refuses to delete an organization that still owns
    // repositories with this 500 — there is no conflict status to key off, so
    // `patches/organization/orgDelete.json` types it by message.
    const server = mockForgejo(() =>
      status(
        500,
        '{"message":"user still has ownership of repositories [uid: 16]"}',
      ),
    );

    const result = await runResult(
      server.layer,
      Services.organization.orgDelete({ org: "acme" }),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "OrganizationOwnsRepositories",
      });
      expect(result.failure.message).toContain(
        "still has ownership of repositories",
      );
    }
  });

  test("maps a transport failure to the HttpClientError tag", async () => {
    const failing = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("connection refused"),
              description: "connection refused",
            }),
          }),
        ),
      ),
    );

    const result = await runResult(failing, Services.user.userGetCurrent({}));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ _tag: "HttpClientError" });
    }
  });
});

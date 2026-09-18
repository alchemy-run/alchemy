import { fromToken, normalizeBaseUrl } from "@/Forgejo/Credentials.ts";
import { type Credentials, Retry, Services } from "@distilled.cloud/forgejo";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { json, mockForgejo, noContent, status } from "./support/mock.ts";

const run = <A, E>(
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  body: Effect.Effect<A, E, Credentials | HttpClient.HttpClient | Retry.Retry>,
) =>
  body.pipe(
    Retry.none,
    Effect.provide(
      Layer.mergeAll(
        fromToken({ baseUrl: "https://forge.example", token: "secret" }),
        httpClient,
      ),
    ),
  );

const runResult = <A, E>(
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  body: Effect.Effect<A, E, Credentials | HttpClient.HttpClient | Retry.Retry>,
) => run(httpClient, Effect.result(body));

describe("normalizeBaseUrl", () => {
  test.effect("appends the Forgejo API path once", () =>
    Effect.sync(() => {
      expect(normalizeBaseUrl("https://forge.example/")).toBe(
        "https://forge.example/api/v1",
      );
      expect(normalizeBaseUrl("https://forge.example/api/v1")).toBe(
        "https://forge.example/api/v1",
      );
    }),
  );
});

describe("Forgejo SDK", () => {
  test.effect("sends token authentication and a JSON body", () =>
    Effect.gen(function* () {
      const server = mockForgejo(() => json({ id: 42, name: "api" }));

      const result = yield* run(
        server.layer,
        Services.repository.createCurrentUserRepo({ name: "api" }),
      );

      expect(result).toMatchObject({ id: 42 });
      const request = server.find("POST", "/user/repos");
      expect(request?.body).toEqual({ name: "api" });
      // Forgejo's access tokens use the `token` scheme, not `Bearer`.
      expect(request?.headers.authorization).toBe("token secret");
    }),
  );

  test.effect("appends query parameters, omitting undefined entries", () =>
    Effect.gen(function* () {
      const server = mockForgejo(() => json([]));

      yield* run(
        server.layer,
        Services.user.userCurrentListRepos({
          page: 2,
          limit: 50,
          order_by: undefined,
        }),
      );

      expect(server.requests[0]?.query).toEqual({ page: "2", limit: "50" });
    }),
  );

  test.effect("accepts an empty successful response", () =>
    Effect.gen(function* () {
      const server = mockForgejo(() => noContent());

      const result = yield* runResult(
        server.layer,
        Services.repository.deleteRepo({ owner: "acme", repo: "api" }),
      );

      expect(Result.isSuccess(result)).toBe(true);
    }),
  );

  test.effect("maps 404 to a NotFound tag carrying the response text", () =>
    Effect.gen(function* () {
      const server = mockForgejo(() => status(404, "missing"));

      const result = yield* runResult(
        server.layer,
        Services.repository.getRepo({ owner: "acme", repo: "missing" }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "NotFound",
          message: "missing",
        });
      }
    }),
  );

  test.effect("maps 403 to a Forbidden tag on a patched list endpoint", () =>
    Effect.gen(function* () {
      // The Swagger document declares no 403 on the organization secret list;
      // `patches/organization/_errors.json` adds it so enumeration can skip an
      // organization the credential is not a member of.
      const server = mockForgejo(() => status(403, "denied"));

      const result = yield* runResult(
        server.layer,
        Services.organization.orgListActionsSecrets({ org: "acme" }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ _tag: "Forbidden" });
      }
    }),
  );

  test.effect("maps a 5xx to its status tag", () =>
    Effect.gen(function* () {
      const server = mockForgejo(() => status(502, "bad gateway"));

      const result = yield* runResult(
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
    }),
  );

  test.effect(
    "maps a 5xx that is really a dependency violation to its own tag",
    () =>
      Effect.gen(function* () {
        // Forgejo 16.0.3 refuses to delete an organization that still owns
        // repositories with this 500 — there is no conflict status to key off, so
        // `patches/organization/orgDelete.json` types it by message.
        const server = mockForgejo(() =>
          status(
            500,
            '{"message":"user still has ownership of repositories [uid: 16]"}',
          ),
        );

        const result = yield* runResult(
          server.layer,
          Services.organization.deleteOrg({ org: "acme" }),
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
      }),
  );

  test.effect("maps a transport failure to the HttpClientError tag", () =>
    Effect.gen(function* () {
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

      const result = yield* runResult(
        failing,
        Services.user.userGetCurrent({}),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ _tag: "HttpClientError" });
      }
    }),
  );
});

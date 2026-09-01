import {
  ForgejoCredentials,
  ForgejoForbidden,
  ForgejoNotFound,
  ForgejoServerError,
  ForgejoTransportError,
  fromToken,
  ignoreInaccessible,
  normalizeBaseUrl,
  optional,
  paginate,
  type ForgejoClient,
} from "@/Forgejo/Client.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { json, mockForgejo, noContent, status } from "./support/mock.ts";

const run = <A, E>(
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  body: (client: ForgejoClient) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* ForgejoCredentials;
      return yield* body(client);
    }).pipe(
      Effect.provide(
        fromToken({
          baseUrl: "https://forge.example",
          token: "secret",
        }).pipe(Layer.provide(httpClient)),
      ),
    ),
  );

const runResult = <A, E>(
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  body: (client: ForgejoClient) => Effect.Effect<A, E>,
) => run(httpClient, (client) => Effect.result(body(client)));

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

describe("Forgejo client", () => {
  test("sends token authentication and a JSON body", async () => {
    const server = mockForgejo(() => json({ id: 42 }));

    const result = await run(server.layer, (client) =>
      client.request<{ id: number }>("POST", "/user/repos", {
        body: { name: "api" },
      }),
    );

    expect(result).toEqual({ id: 42 });
    expect(server.find("POST", "/user/repos")?.body).toEqual({ name: "api" });
  });

  test("appends query parameters, omitting undefined entries", async () => {
    const server = mockForgejo(() => json([]));

    await run(server.layer, (client) =>
      client.request("GET", "/user/repos", {
        query: { page: 2, limit: 50, sort: undefined },
      }),
    );

    expect(server.requests[0]?.query).toEqual({ page: "2", limit: "50" });
  });

  test("resolves empty successful responses to undefined", async () => {
    const server = mockForgejo(() => noContent());

    await expect(
      run(server.layer, (client) => client.request("DELETE", "/resource")),
    ).resolves.toBeUndefined();
  });

  test("maps 404 to a ForgejoNotFound tag", async () => {
    const server = mockForgejo(() => status(404, "missing"));

    const result = await runResult(server.layer, (client) =>
      client.request("GET", "/missing"),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ForgejoNotFound);
      expect(result.failure).toMatchObject({
        _tag: "ForgejoNotFound",
        method: "GET",
        path: "/missing",
        body: "missing",
      });
    }
  });

  test("maps 403 to a ForgejoForbidden tag", async () => {
    const server = mockForgejo(() => status(403, "denied"));

    const result = await runResult(server.layer, (client) =>
      client.request("GET", "/orgs/acme/actions/secrets"),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ForgejoForbidden);
    }
  });

  test("maps 5xx to a ForgejoServerError tag carrying the status", async () => {
    const server = mockForgejo(() => status(502, "bad gateway"));

    const result = await runResult(server.layer, (client) =>
      client.request("GET", "/user"),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ForgejoServerError);
      expect(result.failure).toMatchObject({ status: 502 });
    }
  });

  test("maps a transport failure to a ForgejoTransportError tag", async () => {
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

    const result = await runResult(failing, (client) =>
      client.request("GET", "/user"),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ForgejoTransportError);
    }
  });

  test("maps an undecodable body to a ForgejoTransportError tag", async () => {
    const server = mockForgejo(
      () => new Response("not json{", { status: 200 }),
    );

    const result = await runResult(server.layer, (client) =>
      client.request("GET", "/user"),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ForgejoTransportError);
    }
  });
});

describe("optional", () => {
  test("resolves a missing resource to undefined", async () => {
    const server = mockForgejo(() => status(404));

    await expect(
      run(server.layer, (client) =>
        optional(client.request("GET", "/repos/acme/api")),
      ),
    ).resolves.toBeUndefined();
  });

  test("leaves other failures intact", async () => {
    const server = mockForgejo(() => status(403));

    const result = await runResult(server.layer, (client) =>
      optional(client.request("GET", "/repos/acme/api")),
    );

    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("ignoreInaccessible", () => {
  test("substitutes the fallback for missing and forbidden resources", async () => {
    for (const code of [403, 404]) {
      const server = mockForgejo(() => status(code));
      await expect(
        run(server.layer, (client) =>
          ignoreInaccessible(
            client.request<readonly string[]>("GET", "/repos/acme/api/labels"),
            [],
          ),
        ),
      ).resolves.toEqual([]);
    }
  });

  test("leaves server failures intact", async () => {
    const server = mockForgejo(() => status(500));

    const result = await runResult(server.layer, (client) =>
      ignoreInaccessible(
        client.request<readonly string[]>("GET", "/repos/acme/api/labels"),
        [],
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("paginate", () => {
  test("walks every page until an empty page is returned", async () => {
    const page1 = Array.from({ length: 50 }, (_, index) => ({ id: index }));
    const page2 = [{ id: 50 }, { id: 51 }];
    const server = mockForgejo((request) =>
      json(
        request.query.page === "1"
          ? page1
          : request.query.page === "2"
            ? page2
            : [],
      ),
    );

    const items = await run(server.layer, (client) =>
      paginate<{ id: number }>(client, "/user/repos"),
    );

    expect(items).toHaveLength(52);
    expect(server.requests.map((request) => request.query.page)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  test("keeps paging when the instance clamps the page size", async () => {
    // Forgejo clamps `limit` to `[api] MAX_RESPONSE_ITEMS`. On an instance
    // where that is below PAGE_LIMIT every full page looks short, so stopping
    // at the first short page would report page one as the whole list.
    const clamped = 20;
    const server = mockForgejo((request) => {
      const page = Number(request.query.page);
      return json(
        page > 2
          ? []
          : Array.from({ length: clamped }, (_, index) => ({
              id: (page - 1) * clamped + index,
            })),
      );
    });

    const items = await run(server.layer, (client) =>
      paginate<{ id: number }>(client, "/user/orgs"),
    );

    expect(items).toHaveLength(40);
    expect(server.requests).toHaveLength(3);
  });

  test("stops after a single empty page", async () => {
    const server = mockForgejo(() => json([]));

    const items = await run(server.layer, (client) =>
      paginate<{ id: number }>(client, "/user/orgs"),
    );

    expect(items).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  test("forwards additional query parameters on every page", async () => {
    const server = mockForgejo(() => json([]));

    await run(server.layer, (client) =>
      paginate(client, "/user/repos", { query: { sort: "created" } }),
    );

    expect(server.requests[0]?.query).toMatchObject({
      sort: "created",
      page: "1",
      limit: "50",
    });
  });
});

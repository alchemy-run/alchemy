import { fromToken } from "@/Forgejo/Credentials.ts";
import { paginate } from "@/Forgejo/Pagination.ts";
import { type Credentials, Retry, Services } from "@distilled.cloud/forgejo";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { json, mockForgejo } from "./support/mock.ts";

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

describe("paginate", () => {
  test.effect("walks every page until an empty page is returned", () =>
    Effect.gen(function* () {
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

      const items = yield* run(
        server.layer,
        paginate(Services.user.userCurrentListRepos, {}),
      );

      expect(items).toHaveLength(52);
      expect(server.requests.map((request) => request.query.page)).toEqual([
        "1",
        "2",
        "3",
      ]);
    }),
  );

  test.effect("keeps paging when the instance clamps the page size", () =>
    Effect.gen(function* () {
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

      const items = yield* run(
        server.layer,
        paginate(Services.organization.orgListCurrentUserOrgs, {}),
      );

      expect(items).toHaveLength(40);
      expect(server.requests).toHaveLength(3);
    }),
  );

  test.effect("stops after a single empty page", () =>
    Effect.gen(function* () {
      const server = mockForgejo(() => json([]));

      const items = yield* run(
        server.layer,
        paginate(Services.organization.orgListCurrentUserOrgs, {}),
      );

      expect(items).toEqual([]);
      expect(server.requests).toHaveLength(1);
    }),
  );

  test.effect("forwards the operation's other inputs on every page", () =>
    Effect.gen(function* () {
      const server = mockForgejo(() => json([]));

      yield* run(
        server.layer,
        paginate(Services.issue.issueListLabels, {
          owner: "acme",
          repo: "api",
          sort: "oldest",
        }),
      );

      expect(server.requests[0]?.path).toBe("/repos/acme/api/labels");
      expect(server.requests[0]?.query).toMatchObject({
        sort: "oldest",
        page: "1",
        limit: "50",
      });
    }),
  );
});

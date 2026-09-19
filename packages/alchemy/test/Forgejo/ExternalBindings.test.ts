import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Services } from "@distilled.cloud/forgejo";
import { expect } from "alchemy-test";
import ExternalWorker, { ExternalToken } from "./fixtures/external-worker.ts";
import { Repository } from "./fixtures/repository.ts";
import { runtimeProviders } from "./support/runtime-providers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), runtimeProviders),
});

test.provider.skipIf(process.env.FORGEJO_RUNTIME_TEST !== "1")(
  "live: external credential is not revoked when its binding is removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* Services.admin.adminListUserAccessTokens({
        username: "alchemy-admin",
      });
      const retained = Effect.gen(function* () {
        const repo = yield* Repository;
        const token = yield* ExternalToken;
        return { repo, token };
      });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const host = yield* ExternalWorker;
          return { url: host.url, ...(yield* retained) };
        }),
      );
      yield* HttpClient.get(deployed.url!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(
                new Error(`External Worker status ${response.status}`),
              ),
        ),
        Effect.tap((body) =>
          Effect.sync(() =>
            expect(body).toMatchObject({ id: deployed.repo.repoId }),
          ),
        ),
        Effect.retry({ times: 8, schedule: Schedule.spaced("2 seconds") }),
      );
      const external = yield* HttpClient.get(
        `${deployed.url!.replace(/\/$/, "")}/external`,
      );
      expect(external.status).toBe(200);
      expect(yield* external.json).toMatchObject({ id: deployed.repo.repoId });
      const invalid = yield* HttpClient.get(
        `${deployed.url!.replace(/\/$/, "")}/invalid`,
      );
      expect(yield* invalid.text).toBe("Unauthorized");
      const topics = yield* HttpClient.post(
        `${deployed.url!.replace(/\/$/, "")}/topics`,
      );
      expect(topics.status).toBe(200);
      expect(yield* topics.json).toMatchObject({
        topics: ["external-runtime"],
      });
      expect(
        yield* Services.repository.repoListTopics({
          owner: deployed.repo.owner,
          repo: deployed.repo.name,
        }),
      ).toMatchObject({ topics: ["external-runtime"] });
      const tokens = yield* Services.admin.adminListUserAccessTokens({
        username: "alchemy-admin",
      });
      const created = tokens.filter(
        (token) => !before.some((previous) => previous.id === token.id),
      );
      expect(created).toHaveLength(2);
      expect(
        tokens.filter((token) => token.id === deployed.token.tokenId),
      ).toHaveLength(1);
      yield* stack.deploy(retained);
      const remaining = yield* Services.admin.adminListUserAccessTokens({
        username: "alchemy-admin",
      });
      expect(
        remaining.some((token) => token.id === deployed.token.tokenId),
      ).toBe(true);
      expect(
        remaining.filter((token) =>
          created.some((managed) => managed.id === token.id),
        ),
      ).toHaveLength(1);
      yield* stack.destroy();
      expect(
        (yield* Services.admin.adminListUserAccessTokens({
          username: "alchemy-admin",
        })).some((token) => token.id === deployed.token.tokenId),
      ).toBe(false);
    }),
  { timeout: 120_000 },
);

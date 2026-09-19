import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Services } from "@distilled.cloud/forgejo";
import { expect } from "alchemy-test";
import ReplacementWorker from "./fixtures/replacement-worker.ts";
import { Repository } from "./fixtures/repository.ts";
import { runtimeProviders } from "./support/runtime-providers.ts";
import { logDeliveryStatus } from "./support/runtime.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), runtimeProviders),
});
const program = Effect.gen(function* () {
  const host = yield* ReplacementWorker;
  const repo = yield* Repository;
  return { url: host.url, name: host.workerName, repo };
});
const ready = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(
            new Error(`Replacement Worker status ${response.status}`),
          ),
    ),
    Effect.retry({ times: 8, schedule: Schedule.spaced("5 seconds") }),
  );

test.provider.skipIf(process.env.FORGEJO_RUNTIME_TEST !== "1")(
  "live: host replacement preserves auth and moves signed deliveries",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(program);
      expect(yield* ready(first.url!)).toMatchObject({ id: first.repo.repoId });
      const target = { owner: first.repo.owner, repo: first.repo.name };
      const tokens = yield* Services.admin.adminListUserAccessTokens({
        username: "alchemy-admin",
      });
      const hooks = yield* Services.repository.repoListHooks(target);
      const config = yield* ConfigProvider.ConfigProvider;
      const second = yield* stack.deploy(program).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({
              FORGEJO_HOST_NAME: `fj-replaced-${first.name.slice(-30)}`,
            }),
            config,
          ),
        ),
      );
      expect(second.url).not.toBe(first.url);
      expect(yield* ready(second.url!)).toMatchObject({
        id: first.repo.repoId,
      });
      expect(
        (yield* Services.admin.adminListUserAccessTokens({
          username: "alchemy-admin",
        })).map((token) => token.id),
      ).toEqual(tokens.map((token) => token.id));
      const current = yield* Services.repository.repoListHooks(target);
      expect(current).toHaveLength(1);
      expect(current[0]!.id).not.toBe(hooks[0]!.id);
      expect(
        yield* Services.repository
          .repoGetHook({ ...target, id: hooks[0]!.id })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        (current[0]!.config?.url ?? current[0]!.url).startsWith(second.url!),
      ).toBe(true);
      const issue = yield* Services.issue.createIssue({
        ...target,
        title: "host replacement delivery",
      });
      const comments = yield* Services.issue
        .issueGetComments({ ...target, index: issue.number! })
        .pipe(
          Effect.repeat({
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
            until: (comments) =>
              comments.some(
                (comment) => comment.body === "replacement delivered",
              ),
          }),
        );
      const delivered = comments.some(
        (comment) => comment.body === "replacement delivered",
      );
      if (!delivered) yield* logDeliveryStatus;
      expect(delivered).toBe(true);
      yield* stack.destroy();
      expect(
        yield* Services.repository.getRepo(target).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  { timeout: 120_000 },
);

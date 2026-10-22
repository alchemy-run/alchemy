import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import { Octokit } from "@alchemy.run/github/Octokit";
import { webhookPath } from "@alchemy.run/github/RepositoryEventSource";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import GitHubEventSourceWorker, { owner, repository } from "./fixtures/event-source-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
});
const { executeWhenReady, getWhenReady } = Test;

// Public and retained across runs: the gh token lacks delete_repo.
const Repository = GitHub.Repository("Repo", {
  owner,
  name: repository,
  visibility: "public",
  autoInit: true,
});

const listHooks = Effect.gen(function* () {
  const octokit = yield* Octokit;
  return yield* Effect.tryPromise(() =>
    octokit.paginate(octokit.rest.repos.listWebhooks, { owner, repo: repository, per_page: 100 }),
  );
});

test.provider(
  "consumeRepositoryEvents without a secret verifies every delivery",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // The webhook only depends on the Worker's URL, so the repository has
      // to exist before the Worker deploys.
      yield* stack.deploy(Repository);
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repository;
          const worker = yield* GitHubEventSourceWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      const base = url.replace(/\/+$/, "");
      const deliveryUrl = `${base}${webhookPath({ owner, repository })}`;
      yield* getWhenReady(base);

      // GitHub masks a configured secret as "********" and omits it otherwise.
      const hook = (yield* listHooks).find((hook) => hook.config.url === deliveryUrl);
      expect(hook?.config.secret).toBe("********");

      // An unsigned delivery is rejected.
      const forged = yield* executeWhenReady(
        HttpClientRequest.post(deliveryUrl).pipe(
          HttpClientRequest.setHeader("x-github-event", "push"),
          HttpClientRequest.bodyJsonUnsafe({ ref: "refs/heads/main" }),
        ),
      );
      expect(forged.status).toBe(401);

      // A delivery GitHub signs with the generated secret is accepted.
      const octokit = yield* Octokit;
      yield* Effect.tryPromise(() =>
        octokit.rest.repos.pingWebhook({ owner, repo: repository, hook_id: hook!.id }),
      );
      const ping = yield* Effect.tryPromise(() =>
        octokit.rest.repos.listWebhookDeliveries({ owner, repo: repository, hook_id: hook!.id }),
      ).pipe(
        Effect.map(({ data }) => data.find((delivery) => delivery.event === "ping")),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (delivery) => delivery !== undefined,
          times: 20,
        }),
      );
      expect(ping?.status_code).toBe(202);

      yield* stack.destroy();
      expect((yield* listHooks).filter((hook) => hook.config.url === deliveryUrl)).toEqual([]);
    }),
  {
    timeout: 180_000,
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:github",
      "provider:github:webhook",
      "live",
    ],
  },
);

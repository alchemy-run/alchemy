import { describe, expect } from "bun:test";
import * as Entire from "@alchemy.run/entire";
import * as Test from "@alchemy.run/test/Bun";
import * as EntireSdk from "@distilled.cloud/entire";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Entire.providers(),
  state: Alchemy.localState(),
});

// Out-of-band reads resolve the same stored credentials the deploy uses.
const EntireHttp = Layer.mergeAll(
  Entire.EntireAuth,
  Entire.Credentials.fromAuthProvider(),
  FetchHttpClient.layer,
);

describe("entire-review-agent", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 300_000 });

  test(
    "the repository is protected and the reviewer runs on its Changes",
    Effect.gen(function* () {
      const out = yield* stack;

      const protection = yield* EntireSdk.repos.getBranchProtection({ repoId: out.repoId });
      expect(protection.rules).toEqual([{ ref: "HEAD", serverSideMergeOnly: true }]);

      const meta = yield* EntireSdk.repoDetails.getRepoMeta({ repo_id: out.repoId });
      expect(meta).toMatchObject({ trails_enabled: true, runners_enabled: true });

      const reviewer = yield* EntireSdk.agents.getProjectAgent({
        host: "et",
        project: out.projectName,
        id: out.reviewerId,
      });
      expect(reviewer.is_enabled).toEqual(true);
      expect(reviewer.repository_ids).toEqual([out.repoId]);
    }).pipe(Effect.provide(EntireHttp)),
    { timeout: 60_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });
});

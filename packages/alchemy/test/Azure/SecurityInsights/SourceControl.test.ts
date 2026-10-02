import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * The full lifecycle needs a real GitHub repository and a PAT with repo +
 * workflow scope (Sentinel commits a deployment workflow to the branch):
 * AZURE_TEST_SENTINEL_REPO=https://github.com/<owner>/<repo>
 * AZURE_TEST_SENTINEL_REPO_TOKEN=<pat>
 */
const repoUrl = process.env.AZURE_TEST_SENTINEL_REPO;
const repoToken = process.env.AZURE_TEST_SENTINEL_REPO_TOKEN;

const getSourceControl = (
  resourceGroupName: string,
  workspaceName: string,
  sourceControlId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetSourceControl({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      sourceControlId,
    });
  });

const program = (opts?: { displayName: string; branch: string }) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const repo = opts
      ? yield* Azure.SecurityInsights.SourceControl("Repo", {
          resourceGroup: sentinel.resourceGroup,
          workspace: sentinel.workspace,
          displayName: opts.displayName,
          repoType: "Github",
          contentTypes: ["AnalyticsRule"],
          repository: { url: repoUrl!, branch: opts.branch },
          repositoryAccess: {
            kind: "PAT",
            token: Redacted.make(repoToken!),
          },
        })
      : undefined;
    return { group, logs, repo };
  });

// A repository connection validates the credentials against GitHub; the
// trial account has no connected repository, so this probe pins the typed
// rejection of a bad PAT.
test.provider(
  "repository connections reject invalid credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const out = yield* stack.deploy(program());
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* securityinsights
        .CreateSourceControl({
          subscriptionId,
          resourceGroupName: out.group.resourceGroupName,
          workspaceName: out.logs.workspaceName,
          sourceControlId: "6b1d6a8e-2f43-4c1a-9d1e-0a5c3b7e9f22",
          properties: {
            displayName: "probe",
            repoType: "Github",
            contentTypes: ["AnalyticsRule"],
            repository: {
              url: "https://github.com/alchemy-run/does-not-exist",
              branch: "main",
            },
            repositoryAccess: { kind: "PAT", token: "ghp_invalid" },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SentinelRepositoryAccessDenied");
      yield* stack.destroy();
    }),
  { tags, timeout: 900_000 },
);

// ~$0; needs a GitHub repository + PAT (see above).
test.provider.skipIf(!repoUrl || !repoToken)(
  "create, update, and delete a Sentinel repository connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ displayName: "Alchemy content", branch: "main" }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.logs.workspaceName;
      const id = created.repo!.sourceControlId;
      const observed = yield* getSourceControl(rg, ws, id);
      expect(observed.properties.displayName).toEqual("Alchemy content");

      yield* stack.deploy(
        program({ displayName: "Alchemy content v2", branch: "main" }),
      );
      const after = yield* getSourceControl(rg, ws, id);
      expect(after.properties.displayName).toEqual("Alchemy content v2");

      yield* stack.destroy();
      const gone = yield* pollGone(
        getSourceControl(rg, ws, id).pipe(
          Effect.as("found" as const),
          Effect.catchTag(
            ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
            () => Effect.succeed("gone" as const),
          ),
        ),
      );
      expect(gone).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);

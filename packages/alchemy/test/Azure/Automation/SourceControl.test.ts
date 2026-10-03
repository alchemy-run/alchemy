import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  account,
  logLevel,
  sharedAccountTest,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * A GitHub personal access token (repo read) and a repository it can read,
 * e.g. `https://github.com/<owner>/<repo>.git`. Source control needs an
 * external repository and secret, so the lifecycle only runs when both are
 * set.
 */
const pat = process.env.AZURE_TEST_AUTOMATION_GITHUB_PAT;
const repoUrl = process.env.AZURE_TEST_AUTOMATION_GITHUB_REPO;

const program = (props: {
  repo: string;
  token: string;
  folderPath: string;
  description?: string;
}) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const source = yield* Azure.Automation.SourceControl("Source", {
      ...where,
      repoUrl: props.repo,
      sourceType: "GitHub",
      branch: "main",
      folderPath: props.folderPath,
      publishRunbook: false,
      securityToken: { accessToken: Redacted.make(props.token) },
      description: props.description,
    });
    return { where, source };
  });

const getSource = (
  resourceGroupName: string,
  automationAccountName: string,
  sourceControlName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetSourceControl({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      sourceControlName,
    });
  });

// Free, seconds; needs AZURE_TEST_AUTOMATION_GITHUB_PAT and
// AZURE_TEST_AUTOMATION_GITHUB_REPO.
test.provider.skipIf(!pat || !repoUrl)(
  "create, update, and delete a source control",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, source } = yield* stack.deploy(
          program({ repo: repoUrl!, token: pat!, folderPath: "/" }),
        );
        const get = (name: string) =>
          getSource(where.resourceGroup, where.automationAccount, name);
        const observed = yield* get(source.sourceControlName);
        expect(observed.properties?.repoUrl).toEqual(repoUrl);
        expect(observed.properties?.branch).toEqual("main");

        // In-place: folder and description.
        const updated = yield* stack.deploy(
          program({
            repo: repoUrl!,
            token: pat!,
            folderPath: "/runbooks",
            description: "runbooks",
          }),
        );
        expect(updated.source.sourceControlId).toEqual(source.sourceControlId);
        const reobserved = yield* get(source.sourceControlName);
        expect(reobserved.properties?.folderPath).toEqual("/runbooks");
        expect(reobserved.properties?.description).toEqual("runbooks");

        yield* stack.destroy();
        expect(yield* waitGone(get(source.sourceControlName))).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe (free, < 1 minute): an invalid token is rejected with the
// typed error before anything is created.
test.provider(
  "an invalid security token is rejected with a typed error",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();
        const { where } = yield* stack.deploy(account);
        const error = yield* automation
          .SourceControlCreateOrUpdate({
            subscriptionId: yield* subscription,
            resourceGroupName: where.resourceGroup,
            automationAccountName: where.automationAccount,
            sourceControlName: "invalid-token-probe",
            properties: {
              repoUrl: "https://github.com/alchemy-run/alchemy.git",
              sourceType: "GitHub",
              branch: "main",
              folderPath: "/",
              publishRunbook: false,
              securityToken: {
                accessToken: Redacted.make(
                  "ghp_notarealtoken000000000000000000000000",
                ),
                tokenType: "PersonalAccessToken",
              },
            },
          })
          .pipe(Effect.flip);
        expect(error._tag).toEqual("AutomationSourceControlTokenInvalid");
        yield* stack.destroy();
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);

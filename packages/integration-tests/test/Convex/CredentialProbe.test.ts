import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { fromDeployment, fromToken } from "@distilled.cloud/convex/Credentials";
import * as deployments from "@distilled.cloud/convex/deployment";
import * as management from "@distilled.cloud/convex/management";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Redacted from "effect/Redacted";
import { testName } from "./support.ts";

// What Convex lets a deploy key or a preview deploy key do on its own, with no
// team token: the input for running a stage in CI with only CONVEX_DEPLOY_KEY.

const { test } = Test.make({ providers: Convex.providers() });

/** `ok`, or the error's tag, so a probe pins the exact typed error. */
const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? "ok"
        : exit.cause.reasons
            .map((reason) =>
              reason._tag === "Fail" ? (reason.error as { _tag: string })._tag : reason._tag,
            )
            .join(","),
    ),
  );

const withKey =
  (key: Redacted.Redacted<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(fromToken(key)));

test.provider.skipIf(process.env.CONVEX_TEST_PROBE !== "1")(
  "what a preview deploy key and a prod deploy key can do alone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("credential-probe");
      const { project, preview, prod, prodKey } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
          const preview = yield* Convex.PreviewDeployKey("Previews", { project });
          const prod = yield* Convex.Deployment("Prod", {
            project,
            type: "prod",
            deletionProtection: false,
          });
          const prodKey = yield* Convex.DeployKey("ProdKey", { deployment: prod });
          return { project, preview, prod, prodKey };
        }),
      );
      const asPreview = withKey(preview.value);
      const report: Record<string, string> = {};

      report.previewListDeployments = yield* outcome(
        asPreview(management.listDeployments({ projectId: project.projectId })),
      );
      const created = yield* Effect.exit(
        asPreview(
          management.createDeployment({
            projectId: project.projectId,
            type: "preview",
            reference: "preview/credential-probe",
          }),
        ),
      );
      report.previewCreateDeployment = Exit.isSuccess(created)
        ? "ok"
        : yield* outcome(Effect.failCause(created.cause));
      if (Exit.isSuccess(created) && created.value.kind === "cloud") {
        const deploymentName = created.value.name;
        const url = created.value.deploymentUrl;
        report.previewCreateDeployKey = yield* outcome(
          asPreview(management.createDeployKey({ deploymentName, name: "probe" })),
        );
        report.previewUpdateVariables = yield* outcome(
          deployments
            .updateEnvironmentVariables({ changes: [{ name: "PROBE", value: "1" }] })
            .pipe(Effect.provide(fromDeployment({ url, token: preview.value }))),
        );
        report.previewDeleteDeployment = yield* outcome(
          asPreview(management.deleteDeployment({ deploymentName })),
        );
      }
      report.prodKeyDeploymentInfo = yield* outcome(
        deployments
          .getDeploymentInfo({})
          .pipe(Effect.provide(fromDeployment({ url: prod.url, token: prodKey.value }))),
      );
      report.prodKeyManagementGetDeployment = yield* outcome(
        withKey(prodKey.value)(management.getDeployment({ deploymentName: prod.deploymentName })),
      );

      // Observed 2026-11-13. A preview key runs a preview stage end to end,
      // variables included, but cannot mint a key; a deployment key never
      // reaches the Management API.
      expect(report).toEqual({
        previewListDeployments: "ok",
        previewCreateDeployment: "ok",
        previewCreateDeployKey: "PreviewDeployKeyNotAllowed",
        previewUpdateVariables: "ok",
        previewDeleteDeployment: "ok",
        prodKeyDeploymentInfo: "ok",
        prodKeyManagementGetDeployment: "DeployKeyNotAccepted",
      });
      yield* stack.destroy();
    }),
  { tags: ["live", "provider:convex"], timeout: 300_000 },
);

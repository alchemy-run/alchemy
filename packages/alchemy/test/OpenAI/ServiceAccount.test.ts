import * as SDK from "@distilled.cloud/openai";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as OpenAI from "@/OpenAI";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: OpenAI.providers() });

const tags = ["provider:openai", "provider:openai:serviceaccount", "live"];

describe.skipIf(!process.env.OPENAI_ADMIN_KEY)("OpenAI.ServiceAccount", { tags }, () => {
  test.provider(
    "create a service account with a key, update it in place, and delete it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deploy = (props: { name?: string; role?: OpenAI.ServiceAccountRole }) =>
          stack.deploy(
            Effect.gen(function* () {
              const project = yield* OpenAI.Project("ServiceAccountProject");
              const account = yield* OpenAI.ServiceAccount("Bot", {
                projectId: project.projectId,
                ...props,
              });
              return { project, account };
            }),
          );

        const { project, account } = yield* deploy({});
        expect(account.projectId).toBe(project.projectId);
        expect(account.role).toBe("member");
        expect(Redacted.isRedacted(account.apiKey)).toBe(true);
        expect(Redacted.value(account.apiKey)).toMatch(/^sk-/);

        // Out of band: the account and its recorded key exist.
        const observed = yield* SDK.projects.getProjectServiceAccount({
          project_id: project.projectId,
          service_account_id: account.serviceAccountId,
        });
        expect(observed.name).toBe(account.name);
        const key = yield* SDK.projects.getProjectApiKey({
          project_id: project.projectId,
          api_key_id: account.apiKeyId,
        });
        expect(key.id).toBe(account.apiKeyId);

        // A no-op redeploy keeps the identity and the reveal-once key.
        const again = yield* deploy({});
        expect(again.account.serviceAccountId).toBe(account.serviceAccountId);
        expect(again.account.apiKeyId).toBe(account.apiKeyId);
        expect(Redacted.value(again.account.apiKey)).toBe(Redacted.value(account.apiKey));

        // Rename + promote in place.
        const updated = yield* deploy({ name: `${account.name}-renamed`, role: "owner" });
        expect(updated.account.serviceAccountId).toBe(account.serviceAccountId);
        expect(updated.account.role).toBe("owner");
        const observedUpdated = yield* SDK.projects.getProjectServiceAccount({
          project_id: project.projectId,
          service_account_id: account.serviceAccountId,
        });
        expect(observedUpdated.name).toBe(`${account.name}-renamed`);
        expect(observedUpdated.role).toBe("owner");
        expect(updated.account.apiKeyId).toBe(account.apiKeyId);

        // Removing the service account deletes it while the project survives.
        yield* stack.deploy(OpenAI.Project("ServiceAccountProject"));
        const gone = yield* SDK.projects
          .getProjectServiceAccount({
            project_id: project.projectId,
            service_account_id: account.serviceAccountId,
          })
          .pipe(Effect.result);
        expect(Result.isFailure(gone)).toBe(true);
        if (Result.isFailure(gone)) expect(gone.failure._tag).toBe("ServiceAccountNotFound");

        yield* stack.destroy();
        const archived = yield* SDK.projects.getProject({ project_id: project.projectId });
        expect(archived.status).toBe("archived");
      }),
    { timeout: 120_000 },
  );
});

import * as SDK from "@distilled.cloud/openai";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as OpenAI from "@/OpenAI";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: OpenAI.providers() });

const tags = ["provider:openai", "provider:openai:project", "live"];

/** Observe the project out of band; archival is the only "deletion" OpenAI has. */
const expectArchived = (projectId: string) =>
  Effect.gen(function* () {
    const project = yield* SDK.projects.getProject({ project_id: projectId });
    expect(project.status).toBe("archived");
  });

/**
 * Admin API operations need an `sk-admin-…` key. With only a project key the
 * SDK fails before sending anything, with the typed `MissingCredentials` tag
 * — the same gate that keeps the lifecycle suite below skipped here.
 */
test(
  "admin operations without an Admin key fail with typed MissingCredentials",
  Effect.gen(function* () {
    const result = yield* SDK.projects.listProjects({ limit: 1 }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SDK.credentials({
            apiKey: Redacted.make(process.env.OPENAI_API_KEY ?? "sk-proj-unused"),
          }),
          FetchHttpClient.layer,
        ),
      ),
      Effect.result,
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("MissingCredentials");
      if (result.failure._tag === "MissingCredentials") {
        expect(result.failure.credential).toBe("OPENAI_ADMIN_KEY");
      }
    }
  }),
  { tags: ["provider:openai", "provider:openai:project", "local"] },
);

describe.skipIf(!process.env.OPENAI_ADMIN_KEY)("OpenAI.Project", { tags }, () => {
  test.provider(
    "create, rename and archive a project",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(OpenAI.Project("LifecycleProject"));
        expect(created.projectId).toMatch(/^proj_/);
        expect(created.status).toBe("active");
        const observed = yield* SDK.projects.getProject({ project_id: created.projectId });
        expect(observed.name).toBe(created.name);
        expect(observed.status).toBe("active");

        // Redeploying the same props is a no-op on the same project.
        const unchanged = yield* stack.deploy(OpenAI.Project("LifecycleProject"));
        expect(unchanged.projectId).toBe(created.projectId);

        // Renaming updates in place.
        const renamedName = `${created.name}-renamed`;
        const renamed = yield* stack.deploy(
          OpenAI.Project("LifecycleProject", { name: renamedName }),
        );
        expect(renamed.projectId).toBe(created.projectId);
        expect(renamed.name).toBe(renamedName);
        const observedRenamed = yield* SDK.projects.getProject({ project_id: created.projectId });
        expect(observedRenamed.name).toBe(renamedName);

        yield* stack.destroy();
        yield* expectArchived(created.projectId);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "a project archived out of band is recreated on the next deploy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const first = yield* stack.deploy(OpenAI.Project("RecreatedProject"));
        yield* SDK.projects.archiveProject({ project_id: first.projectId });

        const second = yield* stack.deploy(OpenAI.Project("RecreatedProject"));
        expect(second.projectId).not.toBe(first.projectId);
        expect(second.status).toBe("active");

        yield* stack.destroy();
        yield* expectArchived(second.projectId);
      }),
    { timeout: 120_000 },
  );
});

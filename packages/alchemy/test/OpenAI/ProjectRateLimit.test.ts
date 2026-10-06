import * as SDK from "@distilled.cloud/openai";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as OpenAI from "@/OpenAI";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: OpenAI.providers() });

const tags = ["provider:openai", "provider:openai:projectratelimit", "live"];

/** A model every project carries a rate limit for. */
const MODEL = process.env.OPENAI_TEST_RATE_LIMIT_MODEL ?? "gpt-4o-mini";

const observeLimit = (projectId: string) =>
  SDK.projects.listProjectRateLimits.items({ project_id: projectId, limit: 100 }).pipe(
    Stream.filter((limit) => limit.model === MODEL),
    Stream.runHead,
    Effect.flatMap((head) =>
      head._tag === "Some" ? Effect.succeed(head.value) : Effect.die(`no ${MODEL} rate limit`),
    ),
  );

describe.skipIf(!process.env.OPENAI_ADMIN_KEY)("OpenAI.ProjectRateLimit", { tags }, () => {
  test.provider(
    "lower a model's limits, update them, and restore the baseline on removal",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const project = yield* stack.deploy(OpenAI.Project("RateLimitProject"));
        const baseline = yield* observeLimit(project.projectId);
        // Project limits can only be lowered below the organization's.
        const rpm = Math.max(1, Math.floor(baseline.max_requests_per_1_minute / 2));
        const tpm = Math.max(1, Math.floor(baseline.max_tokens_per_1_minute / 2));

        const deploy = (limits: OpenAI.RateLimitValues) =>
          stack.deploy(
            Effect.gen(function* () {
              const project = yield* OpenAI.Project("RateLimitProject");
              const limit = yield* OpenAI.ProjectRateLimit("Limit", {
                projectId: project.projectId,
                model: MODEL,
                ...limits,
              });
              return { project, limit };
            }),
          );

        const first = yield* deploy({ maxRequestsPer1Minute: rpm });
        expect(first.limit.rateLimitId).toBe(baseline.id);
        expect(first.limit.limits.maxRequestsPer1Minute).toBe(rpm);
        expect(first.limit.initialLimits.maxRequestsPer1Minute).toBe(
          baseline.max_requests_per_1_minute,
        );
        const observedFirst = yield* observeLimit(project.projectId);
        expect(observedFirst.max_requests_per_1_minute).toBe(rpm);
        // An unmanaged field is left untouched.
        expect(observedFirst.max_tokens_per_1_minute).toBe(baseline.max_tokens_per_1_minute);

        // Switch the managed field: rpm is restored, tpm is lowered.
        const second = yield* deploy({ maxTokensPer1Minute: tpm });
        expect(second.limit.initialLimits.maxRequestsPer1Minute).toBe(
          baseline.max_requests_per_1_minute,
        );
        const observedSecond = yield* observeLimit(project.projectId);
        expect(observedSecond.max_tokens_per_1_minute).toBe(tpm);
        expect(observedSecond.max_requests_per_1_minute).toBe(baseline.max_requests_per_1_minute);

        // Removing the resource (project kept) restores the captured baseline.
        yield* stack.deploy(OpenAI.Project("RateLimitProject"));
        const restored = yield* observeLimit(project.projectId);
        expect(restored.max_requests_per_1_minute).toBe(baseline.max_requests_per_1_minute);
        expect(restored.max_tokens_per_1_minute).toBe(baseline.max_tokens_per_1_minute);

        yield* stack.destroy();
        const archived = yield* SDK.projects.getProject({ project_id: project.projectId });
        expect(archived.status).toBe("archived");
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "an unknown model fails with ProjectRateLimitModelNotFound",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const result = yield* stack
          .deploy(
            Effect.gen(function* () {
              const project = yield* OpenAI.Project("RateLimitUnknownModel");
              return yield* OpenAI.ProjectRateLimit("Unknown", {
                projectId: project.projectId,
                model: "alchemy-no-such-model",
                maxRequestsPer1Minute: 1,
              });
            }),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(JSON.stringify(result)).toContain("ProjectRateLimitModelNotFound");
        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
});

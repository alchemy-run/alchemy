import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy.ts";
import { Branch } from "@/Neon/Branch.ts";
import { Project } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import { Realtime } from "@/Neon/Realtime.ts";
import * as RealtimeApi from "@/Neon/RealtimeApi.ts";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: providers() });

// Realtime is in beta in aws-us-east-1, aws-us-east-2, aws-eu-central-1 and
// aws-ap-southeast-1; the default project region is one of them.
const REGION = "aws-us-east-1";

const tags = ["provider:neon", "provider:neon:realtime", "provider:neon:project", "live"];

const settled = (scope: { projectId: string; branchId: string }) =>
  RealtimeApi.getProjectBranchRealtime({
    project_id: scope.projectId,
    branch_id: scope.branchId,
  }).pipe(
    Effect.flatMap((state) =>
      state.pending ? Effect.fail(new Error("pending")) : Effect.succeed(state),
    ),
    Effect.retry({ times: 20, schedule: Schedule.spaced("2 seconds") }),
  );

test.provider(
  "Realtime recovery treats incomplete uncreated identities as absent",
  () =>
    Effect.gen(function* () {
      const provider = yield* Realtime.Provider;
      for (const olds of [
        {},
        { branch: { projectId: "", branchId: "uncreated-branch" } },
        { project: { projectId: "" } },
      ]) {
        expect(
          yield* provider.read!({
            id: "UncreatedRealtime",
            fqn: "UncreatedRealtime",
            instanceId: "uncreated-realtime",
            olds: olds as never,
            output: undefined,
          }),
        ).toBeUndefined();
      }
    }),
  { tags },
);

test.provider(
  "Realtime lifecycle enables the default branch, updates origins and disables on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (allowedOrigins?: string[]) =>
        Effect.gen(function* () {
          const project = yield* Project("RealtimeProject", { region: REGION });
          const realtime = yield* Realtime("Realtime", { project, allowedOrigins });
          return { project, realtime };
        });
      const first = yield* stack.deploy(program(["https://app.example.com"]));
      expect(first.realtime.projectId).toBe(first.project.projectId);
      expect(first.realtime.branchId).toBe(first.project.defaultBranchId);
      expect(first.realtime.url).toMatch(/^https:\/\//);
      expect(Redacted.value(first.realtime.secret)).toMatch(/^nrt_live_1/);
      expect(first.realtime.allowedOrigins).toEqual(["https://app.example.com"]);
      const request = {
        project_id: first.realtime.projectId,
        branch_id: first.realtime.branchId,
      };
      const observed = yield* RealtimeApi.getProjectBranchRealtime(request);
      expect(observed.enabled).toBe(true);
      expect(observed.invocation_url).toBe(first.realtime.url);

      // Unchanged inputs plan as a no-op and keep the same URL and secret.
      expect(
        (yield* stack.plan(program(["https://app.example.com"]))).resources.Realtime.action,
      ).toBe("noop");
      const unchanged = yield* stack.deploy(program(["https://app.example.com"]));
      expect(unchanged.realtime.url).toBe(first.realtime.url);
      expect(Redacted.value(unchanged.realtime.secret)).toBe(Redacted.value(first.realtime.secret));

      // Origins update in place; the secret survives.
      const updated = yield* stack.deploy(
        program(["https://app.example.com", "http://localhost:3000"]),
      );
      expect(updated.realtime.url).toBe(first.realtime.url);
      expect(Redacted.value(updated.realtime.secret)).toBe(Redacted.value(first.realtime.secret));
      expect([...updated.realtime.allowedOrigins].sort()).toEqual([
        "http://localhost:3000",
        "https://app.example.com",
      ]);
      expect(
        [...((yield* RealtimeApi.getProjectBranchRealtime(request)).allowed_origins ?? [])].sort(),
      ).toEqual(["http://localhost:3000", "https://app.example.com"]);

      // Omitting the list leaves Neon's origins alone.
      const unmanaged = yield* stack.deploy(program());
      expect([...unmanaged.realtime.allowedOrigins].sort()).toEqual([
        "http://localhost:3000",
        "https://app.example.com",
      ]);

      yield* stack.destroy();
      expect((yield* settled(first.realtime)).enabled).toBe(false);
      expect(
        yield* SDK.getProject({ project_id: first.project.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "Realtime refuses foreign ownership until adopted and re-enables after out-of-band disable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = Project("RealtimeAdoptionProject", { region: REGION });
      const project = yield* stack.deploy(base);
      const request = { project_id: project.projectId, branch_id: project.defaultBranchId };
      yield* RealtimeApi.enableProjectBranchRealtime({ ...request, allowed_origins: ["*"] });
      yield* settled({ projectId: project.projectId, branchId: project.defaultBranchId });
      const program = (allow: boolean) =>
        Effect.gen(function* () {
          const project = yield* base;
          return yield* Realtime("AdoptedRealtime", {
            project,
            allowedOrigins: ["https://app.example.com"],
          }).pipe(adopt(allow));
        });
      const refused = yield* stack.deploy(program(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);
      expect((yield* RealtimeApi.getProjectBranchRealtime(request)).allowed_origins).toEqual(["*"]);

      const adopted = yield* stack.deploy(program(true));
      expect(adopted.branchId).toBe(project.defaultBranchId);
      expect(adopted.allowedOrigins).toEqual(["https://app.example.com"]);
      expect((yield* RealtimeApi.getProjectBranchRealtime(request)).allowed_origins).toEqual([
        "https://app.example.com",
      ]);

      // Disabled behind Alchemy's back: the next deploy converges and a new secret is issued.
      yield* RealtimeApi.disableProjectBranchRealtime(request);
      yield* settled({ projectId: project.projectId, branchId: project.defaultBranchId });
      expect((yield* stack.plan(program(true))).resources.AdoptedRealtime.action).toBe("update");
      const recovered = yield* stack.deploy(program(true));
      expect(recovered.url).toBeDefined();
      expect(Redacted.value(recovered.secret)).toMatch(/^nrt_live_1/);
      expect((yield* RealtimeApi.getProjectBranchRealtime(request)).enabled).toBe(true);

      yield* stack.destroy();
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "Realtime moves to another branch by enabling the new branch before disabling the old",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (second: boolean) =>
        Effect.gen(function* () {
          const project = yield* Project("RealtimeScopeProject", { region: REGION });
          const a = yield* Branch("RealtimeScopeA", { project });
          const b = second ? yield* Branch("RealtimeScopeB", { project }) : undefined;
          const realtime = yield* Realtime("ScopedRealtime", { branch: b ?? a });
          return { a, b, realtime };
        });
      const first = yield* stack.deploy(program(false));
      expect(first.realtime.branchId).toBe(first.a.branchId);
      const moved = yield* stack.deploy(program(true));
      expect(moved.realtime.branchId).toBe(moved.b!.branchId);
      expect(moved.realtime.url).not.toBe(first.realtime.url);
      expect((yield* settled(first.a)).enabled).toBe(false);
      expect((yield* settled(moved.b!)).enabled).toBe(true);
      yield* stack.destroy();
      expect(
        yield* SDK.getProjectBranch({
          project_id: moved.b!.projectId,
          branch_id: moved.b!.branchId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  { tags: [...tags, "provider:neon:branch"], timeout: 120_000 },
);

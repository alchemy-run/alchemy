import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as jobs from "@distilled.cloud/gcp/jobs_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasGcpCreds, logLevel, project, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  jobs.getProjectsTenantsJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsTenantsJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        jobs.getProjectsTenantsJobs({
          name: `projects/${project}/tenants/alchemy-missing/jobs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || process.env.GCP_TEST_JOBS === "1")(
  "createProjectsTenantsJobs is Forbidden when Cloud Talent Solution is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        jobs.createProjectsTenantsJobs({
          parent: `projects/${project}/tenants/alchemy-missing`,
          body: {
            company: `projects/${project}/tenants/alchemy-missing/companies/alchemy-missing`,
            title: "Alchemy Probe",
            description: "probe",
            requisitionId: "alchemy-job-probe",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain(
        "Cloud Talent Solution API has not been used",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* GCP.Jobs.Tenant("AcmeJobs", {
            externalId: "acme-job-tenant",
          });
          const company = yield* GCP.Jobs.TenantsCompany("Hiring", {
            parent: tenant.name,
            externalId: "acme-hiring",
            displayName: "Acme Hiring",
          });
          const job = yield* GCP.Jobs.TenantsJob("Engineer", {
            parent: tenant.name,
            company: company.name,
            title: "Software Engineer",
            description: "Build Cloud Talent integrations.",
            requisitionId: "eng-001",
            addresses: ["Mountain View, CA"],
            employmentTypes: ["FULL_TIME"],
            applicationInfo: { uris: ["https://www.example.com/apply"] },
          });
          return { tenant, company, job };
        }),
      );

      expect(created.job.name).toContain("/jobs/");
      expect(created.job.parent).toEqual(created.tenant.name);
      expect(created.job.company).toEqual(created.company.name);
      expect(created.job.title).toEqual("Software Engineer");
      expect(created.job.description).toEqual(
        "Build Cloud Talent integrations.",
      );
      expect(created.job.requisitionId).toEqual("eng-001");

      const fetched = yield* jobs.getProjectsTenantsJobs({
        name: created.job.name,
      });
      expect(fetched.name).toEqual(created.job.name);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.requisitionId).toContain("[alchemy ");
      expect(fetched.title).toEqual("Software Engineer");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* GCP.Jobs.Tenant("AcmeJobs", {
            tenantId: created.tenant.tenantId,
            externalId: "acme-job-tenant",
          });
          const company = yield* GCP.Jobs.TenantsCompany("Hiring", {
            parent: tenant.name,
            companyId: created.company.companyId,
            externalId: "acme-hiring",
            displayName: "Acme Hiring",
          });
          const job = yield* GCP.Jobs.TenantsJob("Engineer", {
            parent: tenant.name,
            company: company.name,
            jobId: created.job.jobId,
            title: "Staff Software Engineer",
            description: "Build Cloud Talent integrations.",
            requisitionId: "eng-001",
            addresses: ["Mountain View, CA"],
            employmentTypes: ["FULL_TIME"],
            promotionValue: 1,
            applicationInfo: { uris: ["https://www.example.com/apply"] },
          });
          return { tenant, company, job };
        }),
      );

      expect(updated.job.name).toEqual(created.job.name);
      expect(updated.job.title).toEqual("Staff Software Engineer");
      expect(updated.job.promotionValue).toEqual(1);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.job.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);

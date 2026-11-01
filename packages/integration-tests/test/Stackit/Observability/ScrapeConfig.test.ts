import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./observability.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("observability", "scrapeconfig"),
  timeout: 2_700_000,
} as const;

const NewInstance = () => Stackit.Observability.Instance("ScrapeConfigInstance", {});

/** The instance, plus the job when props are given. */
const app = (props?: Omit<Stackit.Observability.ScrapeConfigProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* NewInstance();
    if (props === undefined) return { instance, job: undefined };
    return {
      instance,
      job: yield* Stackit.Observability.ScrapeConfig("JobUnderTest", {
        instanceId: instance.instanceId,
        ...props,
      }),
    };
  });

const observeJob = (projectId: string, instanceId: string, jobName: string) =>
  observability.getScrapeConfig({ projectId, instanceId, jobName }).pipe(
    Effect.map(({ data }) => data),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

const unwrap = (job: observability.Job | "gone") => {
  if (job === "gone") throw new Error("The job is gone");
  return job;
};

const TARGET = "app.example.com:443";

test.provider.skipIf(slow)(
  "create, update, replace and delete a scrape job",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        staticConfigs: [{ targets: [TARGET], labels: { env: "test", keep: "yes" } }],
        sampleLimit: 1000,
      };
      const created = yield* stack.deploy(app(props));
      const instanceId = created.instance.instanceId;
      const job = created.job!;

      expect(job.instanceId).toEqual(instanceId);
      expect(job.jobName).toMatch(/^[a-z0-9-]+$/);
      expect(job.scheme).toEqual("https");
      expect(job.metricsPath).toEqual("/metrics");

      // Out of band.
      const fetched = unwrap(yield* observeJob(projectId, instanceId, job.jobName));
      expect(fetched.staticConfigs[0]!.targets).toEqual([TARGET]);
      expect(fetched.staticConfigs[0]!.labels).toEqual({ env: "test", keep: "yes" });
      expect(fetched.scrapeInterval).toEqual(job.scrapeInterval);

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.Observability.ScrapeConfig);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.jobName === job.jobName)?.instanceId).toEqual(instanceId);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.JobUnderTest).toMatchObject({ action: "noop" });

      // Update in place. Removing a label and adding a token both reach the live job.
      const updated = yield* stack.deploy(
        app({
          staticConfigs: [{ targets: [TARGET], labels: { env: "test" } }],
          scrapeInterval: "2m",
          scrapeTimeout: "1m",
          metricsPath: "/internal/metrics",
          bearerToken: Redacted.make("alchemy-test-token"),
        }),
      );
      expect(updated.job!.jobName).toEqual(job.jobName);
      expect(updated.job!.metricsPath).toEqual("/internal/metrics");
      const refetched = unwrap(yield* observeJob(projectId, instanceId, job.jobName));
      expect(refetched.staticConfigs[0]!.labels).toEqual({ env: "test" });
      expect(refetched.metricsPath).toEqual("/internal/metrics");
      expect(Redacted.isRedacted(refetched.bearerToken)).toEqual(true);
      // The token never reaches the attributes.
      expect(JSON.stringify(updated.job)).not.toContain("alchemy-test-token");

      // A member that was set and no longer is goes out in an update, whatever else changed.
      yield* stack.deploy(
        app({ ...props, sampleLimit: 1000, tlsConfig: { insecureSkipVerify: true } }),
      );
      const strict = unwrap(yield* observeJob(projectId, instanceId, job.jobName));
      expect(strict.tlsConfig?.insecureSkipVerify).toEqual(true);
      yield* stack.deploy(app(props));
      const relaxed = unwrap(yield* observeJob(projectId, instanceId, job.jobName));
      expect(relaxed.tlsConfig?.insecureSkipVerify ?? false).toEqual(false);

      // Renaming replaces, and the old job goes.
      const renamed = yield* stack.deploy(app({ ...props, jobName: "alchemy-test-job-renamed" }));
      expect(renamed.job!.jobName).toEqual("alchemy-test-job-renamed");
      yield* expectGone(observeJob(projectId, instanceId, job.jobName));

      // Removing it from the stack deletes it and leaves the instance.
      yield* stack.deploy(app());
      yield* expectGone(observeJob(projectId, instanceId, "alchemy-test-job-renamed"));

      // A job of a chosen name that Alchemy didn't record is not taken over.
      yield* observability.createScrapeConfig({
        projectId,
        instanceId,
        jobName: "alchemy-test-job-foreign",
        scheme: "https",
        scrapeInterval: "5m",
        scrapeTimeout: "2m",
        staticConfigs: [{ targets: [TARGET] }],
      });
      yield* observeJob(projectId, instanceId, "alchemy-test-job-foreign").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (found) => found !== "gone",
          times: 30,
        }),
      );
      const refused = yield* Effect.exit(
        stack.deploy(app({ ...props, jobName: "alchemy-test-job-foreign" })),
      );
      expect(Exit.isFailure(refused)).toBe(true);
      const untouched = unwrap(
        yield* observeJob(projectId, instanceId, "alchemy-test-job-foreign"),
      );
      expect(untouched.staticConfigs[0]!.labels ?? {}).toEqual({});

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, instanceId));
    }).pipe(logLevel),
  options,
);

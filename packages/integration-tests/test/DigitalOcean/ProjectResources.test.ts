import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getProject, listProjectResources } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isGone, logLevel, testDomain } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:projectresources", "live"];
const LIVE_TIMEOUT = 180_000;

const urnsIn = (projectId: string) =>
  listProjectResources.items({ project_id: projectId }).pipe(
    Stream.map((resource) => resource.urn),
    Stream.runCollect,
  );

test.provider(
  "move a volume and a domain into a project, release one, release all on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const domainName = testDomain(stack.stage, "project-resources");

      const declare = (members: "both" | "volume") =>
        Effect.gen(function* () {
          const project = yield* DigitalOcean.Project("Shop", {});
          const volume = yield* DigitalOcean.Volume("Data", { region: "sfo3", sizeGigabytes: 1 });
          const domain = yield* DigitalOcean.Domain("Zone", { name: domainName });
          const resources = members === "both" ? [volume.urn, domain.urn] : [volume.urn];
          yield* DigitalOcean.ProjectResources("Members", {
            projectId: project.projectId,
            resources,
          });
          return { project, volume, domain };
        });

      const both = yield* stack.deploy(declare("both"));
      expect([...(yield* urnsIn(both.project.projectId))].sort()).toEqual(
        [both.volume.urn, both.domain.urn].sort(),
      );

      yield* stack.deploy(declare("volume"));
      expect(yield* urnsIn(both.project.projectId)).toEqual([both.volume.urn]);

      yield* stack.destroy();

      expect(yield* isGone(getProject({ project_id: both.project.projectId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

import { Project } from "@/Neon/Project";
import { Function } from "@/Neon/Function";
import { CustomDomain } from "@/Neon/CustomDomain";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as Api from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: providers() });
test.provider(
  "custom domain registers independently and returns DNS before activation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const resources = Effect.gen(function* () {
        const project = yield* Project("DomainProject", {
          region: "aws-us-east-2",
        });
        const api = yield* Function("Api", {
          project,
          main: new URL("./fixtures/function-bare.ts", import.meta.url).href,
        });
        return { project, api };
      });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { api } = yield* resources;
          const domain = yield* CustomDomain("Domain", {
            function: api,
            hostname: api.slug.pipe(
              AlchemyOutput.map((slug) => `${slug}.alchemy-test-2.us`),
            ),
          });
          return { api, domain };
        }),
      );
      expect(deployed.domain.cnameTarget.length).toBeGreaterThan(0);
      const observed = yield* Api.listProjectBranchCustomDomains({
        project_id: deployed.api.projectId,
        branch_id: deployed.api.branchId,
      });
      expect(
        observed.custom_domains.some(
          (domain) =>
            domain.domain === deployed.domain.hostname &&
            domain.entity_id === deployed.api.slug,
        ),
      ).toBe(true);
      yield* stack.deploy(resources);
      const removed = yield* Api.listProjectBranchCustomDomains({
        project_id: deployed.api.projectId,
        branch_id: deployed.api.branchId,
      });
      expect(
        removed.custom_domains.some(
          (domain) => domain.domain === deployed.domain.hostname,
        ),
      ).toBe(false);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

import * as AlchemyOutput from "@/Output";

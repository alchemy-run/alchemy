import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, pinnedName } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const domainExists = (dataDomainId: string) =>
  galaxy.dataDomain.getDataDomain({ dataDomainId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create a data domain, change its owner and description, and replace it on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const renamed = yield* pinnedName("domain", "-");

      const app = (props: Partial<StarburstGalaxy.DataDomainProps>, owned = false) =>
        Effect.gen(function* () {
          const owner = yield* StarburstGalaxy.Role("Owner", {});
          const domain = yield* StarburstGalaxy.DataDomain("Domain", {
            ...props,
            ...(owned ? { owningRole: owner.roleId } : {}),
          });
          return { owner, domain };
        });

      const created = yield* stack.deploy(app({ description: "first" }));
      const domainId = created.domain.dataDomainId;
      const live = yield* galaxy.dataDomain.getDataDomain({ dataDomainId: domainId });
      expect(live.name).toBe(created.domain.name);
      expect(live.description).toBe("first");
      expect(live.isDefault).toBe(false);

      // Description and owner converge in place.
      const changed = yield* stack.deploy(app({ description: "second" }, true));
      expect(changed.domain.dataDomainId).toBe(domainId);
      const changedLive = yield* galaxy.dataDomain.getDataDomain({ dataDomainId: domainId });
      expect(changedLive.description).toBe("second");
      expect(changedLive.owningRole.roleId).toBe(changed.owner.roleId);

      // Galaxy cannot rename a domain: a new name is a new domain.
      const replaced = yield* stack.deploy(app({ name: renamed, description: "second" }, true));
      expect(replaced.domain.dataDomainId).not.toBe(domainId);
      expect(replaced.domain.name).toBe(renamed);
      yield* expectGone(domainExists(domainId));

      yield* stack.destroy();
      yield* expectGone(domainExists(replaced.domain.dataDomainId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:data-domain", "live"],
    timeout: 120_000,
  },
);

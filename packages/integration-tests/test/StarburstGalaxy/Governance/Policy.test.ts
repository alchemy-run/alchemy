import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Input, InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, pinnedName, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const policyExists = (policyId: string) =>
  galaxy.policy.getPolicy({ policyId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create a policy, change its predicate and scopes, rename it, and replace it on a new role",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const renamed = yield* pinnedName("policy");

      const app = (
        props: (refs: {
          catalogId: Input<string>;
          rowFilterId: Input<string>;
        }) => Partial<InputProps<StarburstGalaxy.Governance.PolicyProps>>,
        roleKey: "Analysts" | "Auditors" = "Analysts",
      ) =>
        Effect.gen(function* () {
          const analysts = yield* StarburstGalaxy.Role.Role("Analysts", {});
          const auditors = yield* StarburstGalaxy.Role.Role("Auditors", {});
          const filter = yield* StarburstGalaxy.Governance.RowFilter("EuOnly", {
            expression: "region = 'EU'",
          });
          const catalog = yield* StarburstGalaxy.Catalog.PostgresqlCatalog("Crm", {
            endpoint: UNVALIDATED_ENDPOINT,
            databaseName: "crm",
            username: "galaxy",
            password: secret("crm"),
            validate: false,
          });
          const policy = yield* StarburstGalaxy.Governance.Policy("Read", {
            role: roleKey === "Analysts" ? analysts.roleId : auditors.roleId,
            predicate: "true",
            scopes: [
              {
                entityKind: "Column",
                entityId: catalog.catalogId,
                schemaName: "*",
                tableName: "*",
                columnName: "*",
                privileges: { grantKind: "Allow", privilege: ["Select"] },
              },
            ],
            ...props({ catalogId: catalog.catalogId, rowFilterId: filter.rowFilterId }),
          });
          return { analysts, auditors, filter, catalog, policy };
        });

      const created = yield* stack.deploy(app(() => ({})));
      const policyId = created.policy.policyId;
      const live = yield* galaxy.policy.getPolicy({ policyId });
      expect(live.roleId).toBe(created.analysts.roleId);
      expect(live.predicate).toBe("true");
      expect(live.scopes).toHaveLength(1);
      expect(live.scopes[0]?.privileges?.privilege).toEqual(["Select"]);
      expect(created.policy.name).toMatch(/^[a-z0-9_]{1,30}$/);

      // Predicate, description and scopes converge in place.
      const changed = yield* stack.deploy(
        app((refs) => ({
          description: "EU rows only",
          scopes: [
            {
              entityKind: "Table",
              entityId: refs.catalogId,
              schemaName: "public",
              tableName: "customers",
              rowFilterIds: [refs.rowFilterId],
            },
          ],
        })),
      );
      expect(changed.policy.policyId).toBe(policyId);
      const changedLive = yield* galaxy.policy.getPolicy({ policyId });
      expect(changedLive.description).toBe("EU rows only");
      expect(changedLive.scopes.map((scope) => scope.rowFilterIds)).toEqual([
        [changed.filter.rowFilterId],
      ]);

      // A rename keeps the policy.
      const named = yield* stack.deploy(app(() => ({ name: renamed })));
      expect(named.policy.policyId).toBe(policyId);
      expect((yield* galaxy.policy.getPolicy({ policyId })).name).toBe(renamed);

      // Another role is another policy.
      const moved = yield* stack.deploy(app(() => ({ name: renamed }), "Auditors"));
      expect(moved.policy.policyId).not.toBe(policyId);
      expect(moved.policy.roleId).toBe(moved.auditors.roleId);
      yield* expectGone(policyExists(policyId));

      yield* stack.destroy();
      yield* expectGone(policyExists(moved.policy.policyId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:policy", "live"],
    timeout: 600_000,
  },
);

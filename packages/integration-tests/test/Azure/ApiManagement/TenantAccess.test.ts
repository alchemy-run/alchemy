import * as Azure from "@alchemy.run/azure";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { developerService, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAccess = (
  resourceGroupName: string,
  serviceName: string,
  accessName: "access" | "gitAccess",
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetTenantAccess({ subscriptionId, resourceGroupName, serviceName, accessName }),
  );

const program = (access?: { accessName: "access" | "gitAccess"; enabled: boolean }) =>
  Effect.gen(function* () {
    const { group, service } = yield* developerService;
    const created = access
      ? yield* Azure.ApiManagement.TenantAccess("Management", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          accessName: access.accessName,
          enabled: access.enabled,
        })
      : undefined;
    return { group, service, access: created };
  });

// Direct management and Git access exist only on the classic tiers (not
// Consumption or v2). A Developer service costs ~$0.07/h but takes 30-45
// min to create (plus ~15 min to delete): est. ~$0.10 and ~60 minutes per run.
test.provider.skipIf(!runExpensive)(
  "enable, update, replace, and reset tenant access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ accessName: "access", enabled: true }));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.access?.accessName).toEqual("access");
      expect(first.access?.enabled).toEqual(true);
      const key = first.access?.primaryKey;
      expect(key === undefined ? "" : Redacted.value(key)).not.toEqual("");
      expect((yield* getAccess(rg, svc, "access")).properties?.enabled).toEqual(true);

      // In-place update: disable the access.
      yield* stack.deploy(program({ accessName: "access", enabled: false }));
      expect((yield* getAccess(rg, svc, "access")).properties?.enabled).toEqual(false);

      // Replacement: managing Git access instead resets the old configuration.
      yield* stack.deploy(program({ accessName: "access", enabled: true }));
      const replaced = yield* stack.deploy(program({ accessName: "gitAccess", enabled: true }));
      expect(replaced.access?.accessName).toEqual("gitAccess");
      expect((yield* getAccess(rg, svc, "gitAccess")).properties?.enabled).toEqual(true);
      expect((yield* getAccess(rg, svc, "access")).properties?.enabled).toEqual(false);

      // Removing the resource disables the access.
      yield* stack.deploy(program());
      expect((yield* getAccess(rg, svc, "gitAccess")).properties?.enabled).toEqual(false);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);

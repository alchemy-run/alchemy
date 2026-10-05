import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as security from "@distilled.cloud/azure/security";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getScanner = (scopeId: string, scannerName: string) =>
  security.GetDataScanner({ scopeId, scannerName });

const scannerGone = (scopeId: string, scannerName: string) =>
  getScanner(scopeId, scannerName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: { name?: string; groupScoped: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const scanner = yield* Azure.Security.DataScanner("Scanner", {
      resourceGroup: props.groupScoped ? group.resourceGroupName : undefined,
      name: props.name,
    });
    return { group, scanner };
  });

// A data scanner is an identity-only control-plane resource: free, sync PUT.
// It has no mutable properties, so the test covers create, two replacements
// (rename, then move to subscription scope), and delete.
test.provider(
  "create, replace, and delete a data scanner",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, scanner } = yield* stack.deploy(
        program({ groupScoped: true }),
      );
      expect(scanner.resourceGroup).toEqual(group.resourceGroupName);
      expect(scanner.scope.toLowerCase()).toContain(
        `/resourcegroups/${group.resourceGroupName.toLowerCase()}`,
      );
      expect(scanner.dataScannerName.length).toBeLessThanOrEqual(90);
      expect(scanner.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const observed = yield* getScanner(
        scanner.scope,
        scanner.dataScannerName,
      );
      expect(observed.identity?.type?.toLowerCase()).toEqual("systemassigned");
      expect(observed.identity?.principalId).toEqual(scanner.principalId);

      // Idempotent re-deploy keeps the scanner and its identity.
      const again = yield* stack.deploy(program({ groupScoped: true }));
      expect(again.scanner.dataScannerName).toEqual(scanner.dataScannerName);
      expect(again.scanner.principalId).toEqual(scanner.principalId);

      // Replacement: a new name creates a new scanner and deletes the old.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-test-data-scanner", groupScoped: true }),
      );
      expect(renamed.scanner.dataScannerName).toEqual(
        "alchemy-test-data-scanner",
      );
      const renamedObserved = yield* getScanner(
        renamed.scanner.scope,
        renamed.scanner.dataScannerName,
      );
      expect(renamedObserved.name).toEqual("alchemy-test-data-scanner");
      expect(
        yield* scannerGone(scanner.scope, scanner.dataScannerName),
      ).toEqual("gone");

      // Replacement: move to subscription scope.
      const moved = yield* stack.deploy(
        program({ name: "alchemy-test-data-scanner", groupScoped: false }),
      );
      expect(moved.scanner.resourceGroup).toBeUndefined();
      expect(moved.scanner.scope.toLowerCase()).not.toContain(
        "/resourcegroups/",
      );
      const movedObserved = yield* getScanner(
        moved.scanner.scope,
        moved.scanner.dataScannerName,
      );
      expect(movedObserved.identity?.principalId).toEqual(
        moved.scanner.principalId,
      );
      expect(
        yield* scannerGone(
          renamed.scanner.scope,
          renamed.scanner.dataScannerName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* scannerGone(moved.scanner.scope, moved.scanner.dataScannerName),
      ).toEqual("gone");
    }),
  {
    timeout: 900_000,
    tags: ["provider:azure", "provider:azure:security", "live"],
  },
);

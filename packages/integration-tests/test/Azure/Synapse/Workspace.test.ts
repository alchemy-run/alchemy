import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  getWorkspace,
  lakeWorkspace,
  logLevel,
  ROTATED_PASSWORD,
  untilGone,
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

// A workspace is free while idle (no pools); provisioning takes ~3-8 min.
test.provider(
  "create, update, and delete a synapse workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(lakeWorkspace({ tags: { env: "test" } }));
      expect(workspace.workspaceName).toMatch(/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/);
      expect(workspace.connectivityEndpoints.sql).toContain(
        `${workspace.workspaceName}.sql.azuresynapse.net`,
      );
      expect(workspace.principalId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(workspace.tags).toEqual({ env: "test" });

      const observed = yield* getWorkspace(group.resourceGroupName, workspace.workspaceName);
      expect(observed.identity?.principalId).toEqual(workspace.principalId);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.sqlAdministratorLogin).toEqual("sqladminuser");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Ws");

      // In place: tags and a SQL administrator password rotation. (Public
      // network access can only be disabled on managed-VNet workspaces.)
      const updated = yield* stack.deploy(
        lakeWorkspace({ tags: { env: "prod" }, password: ROTATED_PASSWORD }),
      );
      expect(updated.workspace.workspaceId).toEqual(workspace.workspaceId);
      const reobserved = yield* getWorkspace(group.resourceGroupName, workspace.workspaceName);
      expect(reobserved.tags?.env).toEqual("prod");
      const fingerprint = (value: Redacted.Redacted<string> | undefined) =>
        value === undefined ? "" : Redacted.value(value);
      const before = fingerprint(workspace.passwordFingerprint);
      const after = fingerprint(updated.workspace.passwordFingerprint);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(after).toMatch(/^[0-9a-f]{64}$/);
      expect(after).not.toEqual(before);

      yield* stack.destroy();
      expect(
        yield* untilGone(getWorkspace(group.resourceGroupName, workspace.workspaceName)),
      ).toEqual("gone");
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);

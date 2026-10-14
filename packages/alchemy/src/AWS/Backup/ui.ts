import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { BackupPlan } from "./BackupPlan.ts";
import type { BackupSelection } from "./BackupSelection.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * Dashboard UI providers for AWS Backup resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Storage (Backup) brand green. */
const COLOR = "#7AA116";

export const BackupPlanUI = UIProvider.succeed<BackupPlan>(
  "AWS.Backup.BackupPlan",
  {
    displayName: "Backup Plan",
    icon: "calendar",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.backupPlanName,
    facts: (ctx) => [
      { label: "plan", value: ctx.attrs?.backupPlanName, copy: true },
      { label: "id", value: ctx.attrs?.backupPlanId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.backupPlanArn,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.versionId, mono: true },
      { label: "rules", value: ctx.props?.rules?.length },
    ],
  },
);

export const BackupSelectionUI = UIProvider.succeed<BackupSelection>(
  "AWS.Backup.BackupSelection",
  {
    displayName: "Backup Selection",
    icon: "filter",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.selectionName,
    facts: (ctx) => [
      { label: "selection", value: ctx.attrs?.selectionName, copy: true },
      { label: "id", value: ctx.attrs?.selectionId, mono: true, copy: true },
      {
        label: "backup plan",
        value: ctx.attrs?.backupPlanId,
        mono: true,
        copy: true,
      },
      { label: "role", value: ctx.props?.iamRoleArn, mono: true },
    ],
  },
);

export const BackupVaultUI = UIProvider.succeed<BackupVault>(
  "AWS.Backup.BackupVault",
  {
    displayName: "Backup Vault",
    icon: "archive",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.backupVaultName,
    facts: (ctx) => [
      { label: "vault", value: ctx.attrs?.backupVaultName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.backupVaultArn,
        mono: true,
        copy: true,
      },
      {
        label: "encryption key",
        value: ctx.props?.encryptionKeyArn,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(BackupPlanUI, BackupSelectionUI, BackupVaultUI);

import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { RotationSchedule } from "./RotationSchedule.ts";
import type { Secret } from "./Secret.ts";

/**
 * Dashboard UI providers for AWS Secrets Manager resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */
export const SecretUI = UIProvider.succeed<Secret>(
  "AWS.SecretsManager.Secret",
  {
    displayName: "Secret",
    icon: "file-lock-2",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.secretName,
    consoleUrl: (ctx) =>
      ctx.attrs?.secretName === undefined
        ? undefined
        : `https://console.aws.amazon.com/secretsmanager/secret?name=${encodeURIComponent(ctx.attrs.secretName)}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.secretName, copy: true },
      { label: "arn", value: ctx.attrs?.secretArn, mono: true, copy: true },
      { label: "version", value: ctx.attrs?.versionId, mono: true },
      { label: "kms key", value: ctx.attrs?.kmsKeyId, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const RotationScheduleUI = UIProvider.succeed<RotationSchedule>(
  "AWS.SecretsManager.RotationSchedule",
  {
    displayName: "Secret Rotation Schedule",
    icon: "rotate-ccw",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.secretName,
    consoleUrl: (ctx) =>
      ctx.attrs?.secretName === undefined
        ? undefined
        : `https://console.aws.amazon.com/secretsmanager/secret?name=${encodeURIComponent(ctx.attrs.secretName)}`,
    facts: (ctx) => [
      { label: "secret", value: ctx.attrs?.secretName, copy: true },
      {
        label: "secret arn",
        value: ctx.attrs?.secretArn,
        mono: true,
        copy: true,
      },
      { label: "enabled", value: ctx.attrs?.rotationEnabled },
      {
        label: "rotation lambda",
        value: ctx.attrs?.rotationLambdaArn,
        mono: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(SecretUI, RotationScheduleUI);

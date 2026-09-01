import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ProfilePermission } from "./ProfilePermission.ts";
import type { SigningProfile } from "./SigningProfile.ts";

/**
 * Dashboard UI providers for AWS Signer resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const SIGNER_COLOR = "#DD344C";

export const ProfilePermissionUI = UIProvider.succeed<ProfilePermission>(
  "AWS.Signer.ProfilePermission",
  {
    displayName: "Signer Profile Permission",
    icon: "key-round",
    color: SIGNER_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.statementId,
    facts: (ctx) => [
      {
        label: "statement",
        value: ctx.attrs?.statementId,
        mono: true,
        copy: true,
      },
      { label: "profile", value: ctx.attrs?.profileName, mono: true },
      { label: "action", value: ctx.props?.action, mono: true },
      { label: "principal", value: ctx.props?.principal, mono: true },
    ],
  },
);

export const SigningProfileUI = UIProvider.succeed<SigningProfile>(
  "AWS.Signer.SigningProfile",
  {
    displayName: "Signer Signing Profile",
    icon: "key",
    color: SIGNER_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.profileName,
    facts: (ctx) => [
      { label: "profile", value: ctx.attrs?.profileName, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "version", value: ctx.attrs?.profileVersion, mono: true },
      { label: "platform", value: ctx.attrs?.platformId },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () => Layer.mergeAll(ProfilePermissionUI, SigningProfileUI);

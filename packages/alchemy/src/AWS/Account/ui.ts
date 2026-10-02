import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountName } from "./AccountName.ts";
import type { AlternateContact } from "./AlternateContact.ts";
import type { ContactInformation } from "./ContactInformation.ts";
import type { Region } from "./Region.ts";

/**
 * Dashboard UI providers for AWS Account resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance brand pink. */
const COLOR = "#E7157B";

export const AccountNameUI = UIProvider.succeed<AccountName>(
  "AWS.Account.AccountName",
  {
    displayName: "Account Name",
    icon: "building-2",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.accountName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.accountName, copy: true },
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.accountState },
      { label: "created", value: ctx.attrs?.accountCreatedDate },
    ],
  },
);

export const AlternateContactUI = UIProvider.succeed<AlternateContact>(
  "AWS.Account.AlternateContact",
  {
    displayName: "Alternate Contact",
    icon: "phone",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "type", value: ctx.attrs?.alternateContactType },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "title", value: ctx.attrs?.title },
      { label: "email", value: ctx.attrs?.emailAddress, copy: true },
      { label: "phone", value: ctx.attrs?.phoneNumber, mono: true },
    ],
  },
);

export const ContactInformationUI = UIProvider.succeed<ContactInformation>(
  "AWS.Account.ContactInformation",
  {
    displayName: "Primary Contact Information",
    icon: "map-pin",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.fullName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.fullName, copy: true },
      { label: "company", value: ctx.attrs?.companyName },
      { label: "address", value: ctx.attrs?.addressLine1 },
      { label: "city", value: ctx.attrs?.city },
      { label: "country", value: ctx.attrs?.countryCode },
      { label: "phone", value: ctx.attrs?.phoneNumber, mono: true },
    ],
  },
);

export const RegionUI = UIProvider.succeed<Region>("AWS.Account.Region", {
  displayName: "Region Opt-In",
  icon: "globe",
  color: COLOR,
  category: "config",
  summary: (ctx) => ctx.attrs?.regionName,
  facts: (ctx) => [
    { label: "region", value: ctx.attrs?.regionName, mono: true, copy: true },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "opt status", value: ctx.attrs?.regionOptStatus },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    AccountNameUI,
    AlternateContactUI,
    ContactInformationUI,
    RegionUI,
  );

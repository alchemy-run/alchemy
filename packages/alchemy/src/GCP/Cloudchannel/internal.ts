import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_ORG_DISPLAY_NAME_LENGTH = 128;
export const MAX_DOMAIN_LABEL_LENGTH = 32;
export const DEFAULT_LANGUAGE = "en-US";
export const DEFAULT_REBILLING_BASIS = "COST_AT_LIST";
export const DEFAULT_ADJUSTMENT = "0.00";

export const DEFAULT_POSTAL_ADDRESS: cloudchannel.GoogleTypePostalAddress = {
  regionCode: "US",
  postalCode: "94105",
  administrativeArea: "CA",
  locality: "San Francisco",
  addressLines: ["100 Market Street"],
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeName = (value: string) => value.replace(/\/+$/, "");

export const toAccountName = (value: string) => {
  const trimmed = normalizeName(value);
  if (trimmed.startsWith("accounts/")) {
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    return `accounts/${parts[1] ?? trimmed}`;
  }
  return `accounts/${trimmed}`;
};

export const accountOf = (value: string) => {
  const trimmed = normalizeName(value);
  if (trimmed.length === 0) return "";
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts[0] === "accounts" && parts[1]) {
    return `accounts/${parts[1]}`;
  }
  return toAccountName(trimmed);
};

export const toCustomerName = (parent: string, customerId?: string) => {
  if (customerId !== undefined && customerId.includes("/")) {
    return normalizeName(customerId);
  }
  if (customerId !== undefined && customerId.length > 0) {
    return `${accountOf(parent)}/customers/${customerId}`;
  }
  return "";
};

export const toChannelPartnerLinkName = (value: string, account?: string) => {
  const trimmed = normalizeName(value);
  if (trimmed.includes("/channelPartnerLinks/")) return trimmed;
  const acct = account ? toAccountName(account) : accountOf(trimmed);
  if (acct.length === 0) return trimmed;
  return `${acct}/channelPartnerLinks/${lastSegment(trimmed)}`;
};

export const toRepricingConfigName = (
  parent: string,
  configId: string | undefined,
  collection: "customerRepricingConfigs" | "channelPartnerRepricingConfigs",
) => {
  if (configId !== undefined && configId.includes("/")) {
    return normalizeName(configId);
  }
  if (configId !== undefined && configId.length > 0 && parent.length > 0) {
    return `${normalizeName(parent)}/${collection}/${configId}`;
  }
  return "";
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_ORG_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toOrgDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
  });

export const toDomain = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const local = yield* createPhysicalName({
      id,
      maxLength: MAX_DOMAIN_LABEL_LENGTH,
      lowercase: true,
    });
    return `${local}.example.com`;
  });

export const accountFromEnv = () => {
  const raw = (
    process.env.GOOGLE_CLOUDCHANNEL_ACCOUNT ??
    process.env.CLOUDCHANNEL_ACCOUNT ??
    process.env.GCP_CLOUDCHANNEL_ACCOUNT ??
    ""
  ).trim();
  return raw.length > 0 ? toAccountName(raw) : undefined;
};

export const listAccountParents = (project: string) => {
  const fromEnv = accountFromEnv();
  if (fromEnv !== undefined) return [fromEnv];
  if (project.length > 0) return [toAccountName(project)];
  return [] as string[];
};

export const defaultInvoiceMonth = () =>
  Effect.sync(() => {
    const now = new Date();
    const utcMonthIndex = now.getUTCMonth() + 2;
    const year = now.getUTCFullYear() + Math.floor(utcMonthIndex / 12);
    const month = (utcMonthIndex % 12) + 1;
    return { year, month, day: 0 };
  });

export const normalizeDate = (
  date: cloudchannel.GoogleTypeDate | undefined,
): cloudchannel.GoogleTypeDate | undefined => {
  if (date === undefined) return undefined;
  return {
    year: date.year ?? 0,
    month: date.month ?? 0,
    day: date.day ?? 0,
  };
};

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <A, Page, E, R>(
  pages: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const getCustomer = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudchannel.getAccountsCustomers({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const getPartnerCustomer = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudchannel.getAccountsChannelPartnerLinksCustomers({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const listCustomers = (parent: string) =>
  parent.length === 0
    ? emptyList<cloudchannel.GoogleCloudChannelV1Customer>()
    : collectPages(
        cloudchannel.listAccountsCustomers.pages({
          parent,
          pageSize: 50,
        }),
        (page) => page.customers,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1Customer>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1Customer>(),
        ),
      );

export const listPartnerCustomers = (parent: string) =>
  parent.length === 0
    ? emptyList<cloudchannel.GoogleCloudChannelV1Customer>()
    : collectPages(
        cloudchannel.listAccountsChannelPartnerLinksCustomers.pages({
          parent,
          pageSize: 50,
        }),
        (page) => page.customers,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1Customer>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1Customer>(),
        ),
      );

export const listChannelPartnerLinks = (parent: string) =>
  parent.length === 0
    ? emptyList<cloudchannel.GoogleCloudChannelV1ChannelPartnerLink>()
    : collectPages(
        cloudchannel.listAccountsChannelPartnerLinks.pages({
          parent,
          pageSize: 50,
          view: "BASIC",
        }),
        (page) => page.channelPartnerLinks,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1ChannelPartnerLink>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1ChannelPartnerLink>(),
        ),
      );

export const findOwnedCustomer = (
  id: string,
  parent: string,
  list: typeof listCustomers = listCustomers,
) =>
  Effect.gen(function* () {
    const customers = yield* list(parent);
    for (const customer of customers) {
      if (yield* ownedByAlchemy(id, customer.orgDisplayName)) {
        return customer;
      }
    }
    return undefined;
  });

export const findCustomerByDomain = (
  parent: string,
  domain: string,
  list: typeof listCustomers = listCustomers,
) =>
  Effect.gen(function* () {
    if (domain.length === 0) return undefined;
    const customers = yield* list(parent);
    return customers.find((customer) => sameText(customer.domain, domain));
  });

export const toCustomerAttrs = (
  customer: cloudchannel.GoogleCloudChannelV1Customer,
  parent?: string,
) => {
  const name = customer.name ?? "";
  const account = accountOf(name || parent || "");
  const derivedParent =
    parent !== undefined && parent.includes("/channelPartnerLinks/")
      ? parent
      : customer.channelPartnerId
        ? `${account}/channelPartnerLinks/${customer.channelPartnerId}`
        : account;
  return {
    name,
    customerId: lastSegment(name),
    parent: derivedParent,
    account,
    orgDisplayName: parseOwnership(customer.orgDisplayName).text,
    domain: customer.domain,
    orgPostalAddress: customer.orgPostalAddress,
    primaryContactInfo: customer.primaryContactInfo,
    alternateEmail: customer.alternateEmail,
    languageCode: customer.languageCode,
    correlationId: customer.correlationId,
    customerAttestationState: customer.customerAttestationState,
    channelPartnerId: customer.channelPartnerId,
    cloudIdentityId: customer.cloudIdentityId,
    createTime: customer.createTime,
    updateTime: customer.updateTime,
  };
};

export const desiredCustomer = (input: {
  orgDisplayName: string;
  domain: string;
  orgPostalAddress?: cloudchannel.GoogleTypePostalAddress;
  primaryContactInfo?: cloudchannel.GoogleCloudChannelV1ContactInfo;
  alternateEmail?: string;
  languageCode?: string;
  correlationId?: string;
  customerAttestationState?:
    | cloudchannel.GoogleCloudChannelV1CustomerCustomerAttestationStateEnum
    | (string & {});
  channelPartnerId?: string;
}): cloudchannel.GoogleCloudChannelV1Customer => {
  const address = input.orgPostalAddress ?? DEFAULT_POSTAL_ADDRESS;
  const email = input.primaryContactInfo?.email ?? `admin@${input.domain}`;
  return {
    orgDisplayName: input.orgDisplayName,
    domain: input.domain,
    orgPostalAddress: address,
    primaryContactInfo: {
      firstName: input.primaryContactInfo?.firstName ?? "Alchemy",
      lastName: input.primaryContactInfo?.lastName ?? "Test",
      email,
      phone: input.primaryContactInfo?.phone,
      title: input.primaryContactInfo?.title,
    },
    alternateEmail: input.alternateEmail,
    languageCode: input.languageCode ?? DEFAULT_LANGUAGE,
    correlationId: input.correlationId,
    customerAttestationState: input.customerAttestationState,
    channelPartnerId: input.channelPartnerId,
  };
};

export const getCustomerRepricingConfig = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudchannel.getAccountsCustomersCustomerRepricingConfigs({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

export const getChannelPartnerRepricingConfig = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudchannel
        .getAccountsChannelPartnerLinksChannelPartnerRepricingConfigs({
          name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
        );

export const listCustomerRepricingConfigs = (parent: string) =>
  parent.length === 0
    ? emptyList<cloudchannel.GoogleCloudChannelV1CustomerRepricingConfig>()
    : collectPages(
        cloudchannel.listAccountsCustomersCustomerRepricingConfigs.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.customerRepricingConfigs,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1CustomerRepricingConfig>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1CustomerRepricingConfig>(),
        ),
      );

export const listChannelPartnerRepricingConfigs = (parent: string) =>
  parent.length === 0
    ? emptyList<cloudchannel.GoogleCloudChannelV1ChannelPartnerRepricingConfig>()
    : collectPages(
        cloudchannel.listAccountsChannelPartnerLinksChannelPartnerRepricingConfigs.pages(
          {
            parent,
            pageSize: 100,
          },
        ),
        (page) => page.channelPartnerRepricingConfigs,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1ChannelPartnerRepricingConfig>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<cloudchannel.GoogleCloudChannelV1ChannelPartnerRepricingConfig>(),
        ),
      );

export const desiredRepricingConfig = (input: {
  effectiveInvoiceMonth: cloudchannel.GoogleTypeDate;
  rebillingBasis?:
    | cloudchannel.GoogleCloudChannelV1RepricingConfigRebillingBasisEnum
    | (string & {});
  adjustmentPercentage?: string;
  adjustment?: cloudchannel.GoogleCloudChannelV1RepricingAdjustment;
  entitlementGranularity?: cloudchannel.GoogleCloudChannelV1RepricingConfigEntitlementGranularity;
  conditionalOverrides?: cloudchannel.GoogleCloudChannelV1ConditionalOverrideList;
}): cloudchannel.GoogleCloudChannelV1RepricingConfig => ({
  effectiveInvoiceMonth: normalizeDate(input.effectiveInvoiceMonth),
  rebillingBasis: input.rebillingBasis ?? DEFAULT_REBILLING_BASIS,
  adjustment:
    input.adjustment ??
    ({
      percentageAdjustment: {
        percentage: { value: input.adjustmentPercentage ?? DEFAULT_ADJUSTMENT },
      },
    } satisfies cloudchannel.GoogleCloudChannelV1RepricingAdjustment),
  entitlementGranularity: input.entitlementGranularity,
  conditionalOverrides: input.conditionalOverrides,
});

export const toCustomerRepricingAttrs = (
  config: cloudchannel.GoogleCloudChannelV1CustomerRepricingConfig,
) => {
  const name = config.name ?? "";
  return {
    name,
    configId: lastSegment(name),
    parent: parentOf(name),
    updateTime: config.updateTime,
    repricingConfig: config.repricingConfig,
  };
};

export const toChannelPartnerRepricingAttrs = (
  config: cloudchannel.GoogleCloudChannelV1ChannelPartnerRepricingConfig,
) => {
  const name = config.name ?? "";
  return {
    name,
    configId: lastSegment(name),
    parent: parentOf(name),
    updateTime: config.updateTime,
    repricingConfig: config.repricingConfig,
  };
};

export const findCustomerRepricing = (
  parent: string,
  name: string | undefined,
  month: cloudchannel.GoogleTypeDate | undefined,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getCustomerRepricingConfig(name);
      if (existing !== undefined) return existing;
    }
    const configs = yield* listCustomerRepricingConfigs(parent);
    if (month === undefined) return undefined;
    const wanted = normalizeDate(month);
    return configs.find((config) =>
      jsonEqual(
        normalizeDate(config.repricingConfig?.effectiveInvoiceMonth),
        wanted,
      ),
    );
  });

export const findChannelPartnerRepricing = (
  parent: string,
  name: string | undefined,
  month: cloudchannel.GoogleTypeDate | undefined,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getChannelPartnerRepricingConfig(name);
      if (existing !== undefined) return existing;
    }
    const configs = yield* listChannelPartnerRepricingConfigs(parent);
    if (month === undefined) return undefined;
    const wanted = normalizeDate(month);
    return configs.find((config) =>
      jsonEqual(
        normalizeDate(config.repricingConfig?.effectiveInvoiceMonth),
        wanted,
      ),
    );
  });

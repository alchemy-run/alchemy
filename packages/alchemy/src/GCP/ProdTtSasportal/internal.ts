import * as sas from "@distilled.cloud/gcp/prod_tt_sasportal_v1alpha1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 128;
export const PAGE_SIZE = 100;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, Math.max(0, parts.length - 2)).join("/");
};

export const expandCustomer = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.includes("/") ? trimmed : `customers/${trimmed}`;
};

export const expandNode = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.includes("/") ? trimmed : `nodes/${trimmed}`;
};

export const expandDeployment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.includes("/") ? trimmed : `deployments/${trimmed}`;
};

export const deviceReplaceExtra = (
  news: { fccId?: string; serialNumber?: string },
  olds: { fccId?: string; serialNumber?: string } | undefined,
  output: { fccId?: string; serialNumber?: string } | undefined,
) =>
  (olds?.fccId !== undefined &&
    news.fccId !== undefined &&
    news.fccId !== olds.fccId) ||
  (output?.fccId !== undefined &&
    news.fccId !== undefined &&
    news.fccId !== output.fccId) ||
  (olds?.serialNumber !== undefined &&
    news.serialNumber !== undefined &&
    news.serialNumber !== olds.serialNumber) ||
  (output?.serialNumber !== undefined &&
    news.serialNumber !== undefined &&
    news.serialNumber !== output.serialNumber);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left) ?? null) ===
  JSON.stringify(canonical(right) ?? null);

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...new Set(values ?? [])].slice().sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toDisplayName = (id: string, requested: string | undefined) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.trim().length > 0) {
      return requested.trim();
    }
    return yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
  });

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const compactMarkerOf = (stack: string, stage: string, id: string) =>
  `[alc ${stack} ${stage} ${id}]`;

const shrinkMarker = (
  labels: Record<string, string>,
  maxLength: number,
  build: (stack: string, stage: string, id: string) => string,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = build(stack, stage, id);
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
    marker = build(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const marker =
    maxLength < 54
      ? shrinkMarker(labels, maxLength, compactMarkerOf)
      : shrinkMarker(labels, maxLength, (stack, stage, id) =>
          markerOf(labels, stack, stage, id),
        );
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return marker;
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (text?.startsWith("[alc ")) {
    const end = text.indexOf("]");
    if (end < 0) return { labels: {}, text };
    const parts = text.slice("[alc ".length, end).trim().split(/\s+/);
    const labels: Record<string, string> = {};
    if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
    if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
    if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
    const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
    return { labels, text: rest.length > 0 ? rest : undefined };
  }
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

const emptyList = <A>() => Effect.succeed([] as A[]);

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" | "Forbidden" }> =>
  error._tag === "NotFound" || error._tag === "Forbidden";

export const collectPages = <
  Page,
  Item,
  E extends { readonly _tag: string },
  R,
>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.catchIf(isMissing, () => emptyList<Item>()),
  );

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchIf(isMissing, () => Effect.void),
  );

export const listCustomers = () =>
  collectPages(
    sas.listCustomers.pages({ pageSize: PAGE_SIZE }),
    (page) => page.customers,
  );

export const listCustomerDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDeployment>()
    : collectPages(
        sas.listCustomersDeployments.pages({
          parent,
          pageSize: PAGE_SIZE,
          filter: "DIRECT_CHILDREN",
        }),
        (page) => page.deployments,
      );

export const listCustomerDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDevice>()
    : collectPages(
        sas.listCustomersDevices.pages({ parent, pageSize: PAGE_SIZE }),
        (page) => page.devices,
      );

export const listCustomerNodes = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalNode>()
    : collectPages(
        sas.listCustomersNodes.pages({
          parent,
          pageSize: PAGE_SIZE,
          filter: "DIRECT_CHILDREN",
        }),
        (page) => page.nodes,
      );

export const listNodeDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDevice>()
    : collectPages(
        sas.listNodesDevices.pages({ parent, pageSize: PAGE_SIZE }),
        (page) => page.devices,
      );

export const listNodeNodes = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalNode>()
    : collectPages(
        sas.listNodesNodes.pages({
          parent,
          pageSize: PAGE_SIZE,
          filter: "DIRECT_CHILDREN",
        }),
        (page) => page.nodes,
      );

export const listCustomerDeploymentsDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDevice>()
    : collectPages(
        sas.listCustomersDeploymentsDevices.pages({
          parent,
          pageSize: PAGE_SIZE,
        }),
        (page) => page.devices,
      );

export const listCustomerNodesDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDeployment>()
    : collectPages(
        sas.listCustomersNodesDeployments.pages({
          parent,
          pageSize: PAGE_SIZE,
          filter: "DIRECT_CHILDREN",
        }),
        (page) => page.deployments,
      );

export const listCustomerNodesDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDevice>()
    : collectPages(
        sas.listCustomersNodesDevices.pages({ parent, pageSize: PAGE_SIZE }),
        (page) => page.devices,
      );

export const listCustomerNodesNodes = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalNode>()
    : collectPages(
        sas.listCustomersNodesNodes.pages({
          parent,
          pageSize: PAGE_SIZE,
          filter: "DIRECT_CHILDREN",
        }),
        (page) => page.nodes,
      );

export const listNodeDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDeployment>()
    : collectPages(
        sas.listNodesDeployments.pages({
          parent,
          pageSize: PAGE_SIZE,
          filter: "DIRECT_CHILDREN",
        }),
        (page) => page.deployments,
      );

export const listNodeDeploymentsDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDevice>()
    : collectPages(
        sas.listNodesDeploymentsDevices.pages({
          parent,
          pageSize: PAGE_SIZE,
        }),
        (page) => page.devices,
      );

export const listNodeNodesDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDeployment>()
    : collectPages(
        sas.listNodesNodesDeployments.pages({
          parent,
          pageSize: PAGE_SIZE,
          filter: "DIRECT_CHILDREN",
        }),
        (page) => page.deployments,
      );

export const listNodeNodesDevices = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalDevice>()
    : collectPages(
        sas.listNodesNodesDevices.pages({ parent, pageSize: PAGE_SIZE }),
        (page) => page.devices,
      );

export const listNodeNodesNodes = (parent: string) =>
  parent.length === 0
    ? emptyList<sas.SasPortalNode>()
    : collectPages(
        sas.listNodesNodesNodes.pages({
          parent,
          pageSize: PAGE_SIZE,
          filter: "DIRECT_CHILDREN",
        }),
        (page) => page.nodes,
      );

export const listAllCustomerDeployments = () =>
  Effect.gen(function* () {
    const customers = yield* listCustomers();
    const groups = yield* Effect.forEach(
      customers,
      (customer) =>
        customer.name
          ? listCustomerDeployments(customer.name)
          : emptyList<sas.SasPortalDeployment>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllCustomerDevices = () =>
  Effect.gen(function* () {
    const customers = yield* listCustomers();
    const groups = yield* Effect.forEach(
      customers,
      (customer) =>
        customer.name
          ? listCustomerDevices(customer.name)
          : emptyList<sas.SasPortalDevice>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllCustomerNodes = () =>
  Effect.gen(function* () {
    const customers = yield* listCustomers();
    const groups = yield* Effect.forEach(
      customers,
      (customer) =>
        customer.name
          ? listCustomerNodes(customer.name)
          : emptyList<sas.SasPortalNode>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllNodes = () =>
  Effect.gen(function* () {
    const roots = yield* listAllCustomerNodes();
    const found = new Map<string, sas.SasPortalNode>();
    const queue: sas.SasPortalNode[] = [];
    for (const node of roots) {
      if (node.name && !found.has(node.name)) {
        found.set(node.name, node);
        queue.push(node);
      }
    }
    while (queue.length > 0) {
      const batch = queue.splice(0, 8);
      const children = yield* Effect.forEach(
        batch,
        (node) => listNodeNodes(node.name ?? ""),
        { concurrency: 4 },
      );
      for (const child of children.flat()) {
        if (child.name && !found.has(child.name)) {
          found.set(child.name, child);
          queue.push(child);
        }
      }
    }
    return Array.from(found.values());
  });

export const listAllNodeDevices = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name
          ? listNodeDevices(node.name)
          : emptyList<sas.SasPortalDevice>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllNodeNodes = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name ? listNodeNodes(node.name) : emptyList<sas.SasPortalNode>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllCustomerDeploymentsDevices = () =>
  Effect.gen(function* () {
    const deployments = yield* listAllCustomerDeployments();
    const groups = yield* Effect.forEach(
      deployments,
      (deployment) =>
        deployment.name
          ? listCustomerDeploymentsDevices(deployment.name)
          : emptyList<sas.SasPortalDevice>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllCustomerNodeDeployments = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllCustomerNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name
          ? listCustomerNodesDeployments(node.name)
          : emptyList<sas.SasPortalDeployment>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllCustomerNodeDevices = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllCustomerNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name
          ? listCustomerNodesDevices(node.name)
          : emptyList<sas.SasPortalDevice>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllCustomerNodeNodes = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllCustomerNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name
          ? listCustomerNodesNodes(node.name)
          : emptyList<sas.SasPortalNode>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllNodeDeployments = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name
          ? listNodeDeployments(node.name)
          : emptyList<sas.SasPortalDeployment>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllNodeDeploymentDevices = () =>
  Effect.gen(function* () {
    const deployments = yield* listAllNodeDeployments();
    const groups = yield* Effect.forEach(
      deployments,
      (deployment) =>
        deployment.name
          ? listNodeDeploymentsDevices(deployment.name)
          : emptyList<sas.SasPortalDevice>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllNodeNodeDeployments = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllNodeNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name
          ? listNodeNodesDeployments(node.name)
          : emptyList<sas.SasPortalDeployment>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllNodeNodeDevices = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllNodeNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name
          ? listNodeNodesDevices(node.name)
          : emptyList<sas.SasPortalDevice>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listAllNodeNodeNodes = () =>
  Effect.gen(function* () {
    const nodes = yield* listAllNodeNodes();
    const groups = yield* Effect.forEach(
      nodes,
      (node) =>
        node.name
          ? listNodeNodesNodes(node.name)
          : emptyList<sas.SasPortalNode>(),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const getCustomerDeployment = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sas.getCustomersDeployments({ name }));

export const getCustomerDevice = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sas.getCustomersDevices({ name }));

export const getCustomerNode = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sas.getCustomersNodes({ name }));

export const getNodeDevice = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sas.getNodesDevices({ name }));

export const getNodeNode = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sas.getNodesNodes({ name }));

export const getDeploymentDevice = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sas.getDeploymentsDevices({ name }));

export const getNodeDeployment = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(sas.getNodesDeployments({ name }));

export const findOwned = <A extends { displayName?: string }>(
  items: readonly A[],
  id: string,
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.displayName)) {
        return item;
      }
    }
    return undefined;
  });

export const deploymentAttrs = (
  deployment: sas.SasPortalDeployment,
  parent: string,
) => {
  const name = deployment.name ?? "";
  const parsed = parseOwnership(deployment.displayName);
  return {
    name,
    parent: name.length > 0 ? parentOf(name) : parent,
    displayName: parsed.text,
    sasUserIds: deployment.sasUserIds ?? [],
    frns: deployment.frns ?? [],
  };
};

export const nodeAttrs = (node: sas.SasPortalNode, parent: string) => {
  const name = node.name ?? "";
  const parsed = parseOwnership(node.displayName);
  return {
    name,
    parent: name.length > 0 ? parentOf(name) : parent,
    displayName: parsed.text,
    sasUserIds: node.sasUserIds ?? [],
  };
};

export const deviceAttrs = (device: sas.SasPortalDevice, parent: string) => {
  const name = device.name ?? "";
  const parsed = parseOwnership(device.displayName);
  return {
    name,
    parent: name.length > 0 ? parentOf(name) : parent,
    displayName: parsed.text,
    fccId: device.fccId,
    serialNumber: device.serialNumber,
    state: device.state,
    preloadedConfig: device.preloadedConfig,
    activeConfig: device.activeConfig,
    deviceMetadata: device.deviceMetadata,
    grantRangeAllowlists: device.grantRangeAllowlists,
    grants: device.grants,
    currentChannels: device.currentChannels,
  };
};

export const deviceBody = (input: {
  displayName: string;
  fccId?: string;
  serialNumber?: string;
  preloadedConfig?: sas.SasPortalDeviceConfig;
  deviceMetadata?: sas.SasPortalDeviceMetadata;
  grantRangeAllowlists?: sas.SasPortalFrequencyRange[];
}): sas.SasPortalDevice => ({
  displayName: input.displayName,
  fccId: input.fccId,
  serialNumber: input.serialNumber,
  preloadedConfig: input.preloadedConfig,
  deviceMetadata: input.deviceMetadata,
  grantRangeAllowlists: input.grantRangeAllowlists,
});

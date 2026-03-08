import { toPath } from "../FQN.ts";
import type { BindingAction, CRUD } from "../Plan.ts";

export interface TreeBinding {
  sid: string;
  action: BindingAction;
}

/**
 * A tree node representing a namespace.
 * Resources and bindings live directly inside the namespace where they were created.
 */
export interface TreeNode {
  id: string;
  path: string[];
  children: Map<string, TreeNode>;
  resources: CRUD[];
  bindings: TreeBinding[];
}

export type DerivedAction =
  | "create"
  | "update"
  | "delete"
  | "replace"
  | "noop"
  | "mixed";

export function buildNamespaceTree(items: CRUD[]): TreeNode {
  const root: TreeNode = {
    id: "",
    path: [],
    children: new Map(),
    resources: [],
    bindings: [],
  };

  const getNode = (path: string[]) => {
    let current = root;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i];
      let child = current.children.get(segment);
      if (!child) {
        child = {
          id: segment,
          path: path.slice(0, i + 1),
          children: new Map(),
          resources: [],
          bindings: [],
        };
        current.children.set(segment, child);
      }
      current = child;
    }
    return current;
  };

  for (const item of items) {
    getNode(toPath(item.resource.Namespace)).resources.push(item);
    for (const binding of item.bindings ?? []) {
      getNode(toPath(binding.namespace)).bindings.push({
        sid: binding.sid,
        action: binding.action,
      });
    }
  }

  return root;
}

export function deriveNamespaceAction(node: TreeNode): DerivedAction {
  const actions = new Set<BindingAction | CRUD["action"] | DerivedAction>();

  for (const resource of node.resources) {
    actions.add(resource.action);
  }
  for (const binding of node.bindings) {
    actions.add(binding.action);
  }
  for (const child of node.children.values()) {
    const childAction = deriveNamespaceAction(child);
    if (childAction === "mixed") {
      return "mixed";
    }
    actions.add(childAction);
  }

  return deriveAction(actions);
}

export interface FlattenedItem {
  type: "namespace" | "resource" | "binding";
  depth: number;
  id: string;
  path: string[];
  action: CRUD["action"] | BindingAction | DerivedAction;
  resourceType?: string;
  bindingSid?: string;
  bindingCount?: number;
  hasChildren?: boolean;
}

export function flattenTree(
  node: TreeNode,
  depth = 0,
  result: FlattenedItem[] = [],
): FlattenedItem[] {
  flattenNamespace(node, depth, result);
  return result;
}

const flattenNamespace = (
  node: TreeNode,
  depth: number,
  result: FlattenedItem[],
) => {
  const sortedResources = [...node.resources].sort((a, b) =>
    a.resource.LogicalId.localeCompare(b.resource.LogicalId),
  );
  const sortedBindings = [...node.bindings].sort((a, b) =>
    a.sid.localeCompare(b.sid),
  );
  const sortedChildren = Array.from(node.children.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const resourceIds = new Set(
    sortedResources.map((resource) => resource.resource.LogicalId),
  );

  for (const [id, child] of sortedChildren) {
    if (resourceIds.has(id) || isEmpty(child)) {
      continue;
    }
    result.push({
      type: "namespace",
      depth,
      id,
      path: child.path,
      action: deriveNamespaceAction(child),
      hasChildren: true,
    });
    flattenNamespace(child, depth + 1, result);
  }

  for (const resource of sortedResources) {
    const childNamespace = node.children.get(resource.resource.LogicalId);
    result.push({
      type: "resource",
      depth,
      id: resource.resource.LogicalId,
      path: [...node.path, resource.resource.LogicalId],
      action: resource.action,
      resourceType: resource.resource.Type,
      bindingCount: childNamespace ? countVisibleChildren(childNamespace) : 0,
    });
    if (childNamespace) {
      flattenNamespace(childNamespace, depth + 1, result);
    }
  }

  for (const binding of sortedBindings) {
    result.push({
      type: "binding",
      depth,
      id: binding.sid,
      path: [...node.path, binding.sid],
      action: binding.action,
      bindingSid: binding.sid,
    });
  }
};

const isEmpty = (node: TreeNode) =>
  node.resources.length === 0 &&
  node.bindings.length === 0 &&
  Array.from(node.children.values()).every(isEmpty);

const countVisibleChildren = (node: TreeNode) => {
  const resourceIds = new Set(
    node.resources.map((resource) => resource.resource.LogicalId),
  );
  return (
    node.bindings.length +
    node.resources.length +
    Array.from(node.children.keys()).filter((id) => !resourceIds.has(id)).length
  );
};

const deriveAction = (
  actions: Set<BindingAction | CRUD["action"] | DerivedAction>,
): DerivedAction => {
  if (actions.size === 0) return "noop";
  if (actions.has("replace")) return actions.size === 1 ? "replace" : "mixed";
  if (actions.has("delete")) return actions.size === 1 ? "delete" : "mixed";
  if (actions.has("create")) return actions.size === 1 ? "create" : "mixed";
  if (actions.has("update")) return actions.size === 1 ? "update" : "mixed";
  return "noop";
};

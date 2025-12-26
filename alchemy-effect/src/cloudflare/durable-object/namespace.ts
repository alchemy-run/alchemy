export type NamespaceProps = {
  className: string;
  scriptName?: string;
  environment?: string;
  sqlite?: boolean;
  namespaceId?: string;
};

export type Namespace<T = unknown> = {
  type: "durable_object_namespace";
  id: string;
  className: string;
  scriptName?: string;
  environment?: string;
  sqlite?: boolean;
  namespaceId?: string;
  __service__: T;
};

export function Namespace<T = unknown>(
  id: string,
  props: NamespaceProps,
): Namespace<T> {
  return {
    type: "durable_object_namespace",
    id,
    className: props.className,
    scriptName: props.scriptName,
    environment: props.environment,
    sqlite: props.sqlite,
    namespaceId: props.namespaceId,
    __service__: undefined!,
  };
}

export function isNamespace(binding: unknown): binding is Namespace {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "type" in binding &&
    binding.type === "durable_object_namespace"
  );
}

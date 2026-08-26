import type { Output } from "../../Output.ts";
import {
  makeNamedHttpBinding as makeGcpNamedHttpBinding,
  type GcpHttpOp,
} from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for AI Platform named-resource bindings.
 * NOT exported from index.ts.
 */
export const makeNamedHttpBinding = <
  Resource extends { name: Output<string, never>; LogicalId: string },
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
  role?: string;
}) =>
  makeGcpNamedHttpBinding<Resource, I, A, E>({
    tag: options.tag,
    operation: options.operation,
    role: options.role ?? "roles/aiplatform.user",
    resourceName: (resource) => resource.name,
  });

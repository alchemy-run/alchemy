import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Domain } from "./Domain.ts";
import type { DomainsUser } from "./DomainsUser.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Domain bindings keyed by resource name.
 * NOT exported from index.ts.
 */
export const makeDomainHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (domain: Domain) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: domain,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* domain.name;
      return Effect.fn(`${options.tag}(${domain.LogicalId})`)(function* (
        request: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });

/**
 * Shared HTTP scaffolding for Domain bindings keyed by parent.
 * NOT exported from index.ts.
 */
export const makeDomainParentHttpBinding = <
  I extends { parent: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (domain: Domain) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: domain,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const parent = yield* domain.name;
      return Effect.fn(`${options.tag}(${domain.LogicalId})`)(function* (
        request: Omit<I, "parent">,
      ) {
        return yield* run({
          ...request,
          parent: yield* parent,
        } as I);
      });
    });
  });

/**
 * Shared HTTP scaffolding for DomainsUser bindings keyed by resource name.
 * NOT exported from index.ts.
 */
export const makeDomainsUserHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (user: DomainsUser) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: user,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* user.name;
      return Effect.fn(`${options.tag}(${user.LogicalId})`)(function* (
        request: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });

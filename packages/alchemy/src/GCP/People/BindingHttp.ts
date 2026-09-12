import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type * as people from "@distilled.cloud/gcp/people_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { ContactGroup } from "./ContactGroup.ts";
import type { ContactPeople } from "./ContactPeople.ts";
import { GROUP_FIELDS, PERSON_FIELDS } from "./internal.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for People contact-group bindings.
 * NOT exported from index.ts.
 */
export const makeContactGroupHttpBinding = <A, E>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<people.GetContactGroupsRequest, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (group: ContactGroup) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: group,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const resourceName = yield* group.resourceName;
      return Effect.fn(`${options.tag}(${group.LogicalId})`)(function* (
        request: Omit<people.GetContactGroupsRequest, "resourceName">,
      ) {
        return yield* run({
          ...request,
          resourceName: yield* resourceName,
          groupFields: request.groupFields ?? GROUP_FIELDS,
        });
      });
    });
  });

/**
 * Shared HTTP scaffolding for People contact bindings.
 * NOT exported from index.ts.
 */
export const makeContactPeopleHttpBinding = <A, E>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<people.GetPeopleRequest, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (person: ContactPeople) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: person,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const resourceName = yield* person.resourceName;
      return Effect.fn(`${options.tag}(${person.LogicalId})`)(function* (
        request: Omit<people.GetPeopleRequest, "resourceName">,
      ) {
        return yield* run({
          ...request,
          resourceName: yield* resourceName,
          personFields: request.personFields ?? PERSON_FIELDS,
        });
      });
    });
  });

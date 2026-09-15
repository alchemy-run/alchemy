import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  context,
  errorResponse,
  output,
  parametersResponse,
  props,
  withGroup,
} from "./DBParameterGroup.provider.ts";

const desired = { ...props, parameters: { work_mem: "8192" } };
const diffContext = {
  ...context,
  olds: desired,
  news: desired,
  output: { ...output, parameters: desired.parameters },
  oldBindings: [],
  newBindings: [],
};

it.effect(
  "detects a console change even when cached props and outputs match",
  () =>
    withGroup(
      () =>
        parametersResponse([
          { ParameterName: "work_mem", ParameterValue: "4096", Source: "user" },
        ]),
      (provider) =>
        Effect.gen(function* () {
          expect(yield* provider.diff!(diffContext)).toEqual({
            action: "update",
          });
        }),
    ),
);

it.effect(
  "does not update matching user overrides and explicitly managed engine defaults",
  () =>
    withGroup(
      () =>
        parametersResponse([
          { ParameterName: "work_mem", ParameterValue: "8192", Source: "user" },
          {
            ParameterName: "max_connections",
            ParameterValue: "100",
            Source: "engine-default",
          },
          {
            ParameterName: "unmanaged_default",
            ParameterValue: "1",
            Source: "engine-default",
          },
        ]),
      (provider, requests) =>
        Effect.gen(function* () {
          const matching = {
            ...props,
            parameters: { work_mem: "8192", max_connections: "100" },
          };
          expect(
            yield* provider.diff!({
              ...diffContext,
              olds: matching,
              news: matching,
              output: { ...output, parameters: matching.parameters },
            }),
          ).toBeUndefined();
          expect(requests).toHaveLength(1);
          expect(requests[0]!.action).toBe("DescribeDBParameters");
        }),
    ),
);

it.effect(
  "clears stable attributes only when the parameter group is missing",
  () =>
    withGroup(
      () => errorResponse("DBParameterGroupNotFound"),
      (provider) =>
        Effect.gen(function* () {
          expect(yield* provider.diff!(diffContext)).toEqual({
            action: "update",
            stables: [],
          });
        }),
    ),
);

it.effect("planning propagates authorization failures", () =>
  withGroup(
    () => errorResponse("AccessDenied", 403),
    (provider, requests) =>
      Effect.gen(function* () {
        const error = yield* provider.diff!(diffContext).pipe(Effect.flip);
        expect(error._tag).toBe("AccessDeniedException");
        expect(requests).toHaveLength(1);
      }),
  ),
);

it.effect(
  "unmanaged parameter groups do not add parameter reads to planning",
  () =>
    withGroup(
      () => {
        throw new Error("Unexpected parameter read");
      },
      (provider, requests) =>
        Effect.gen(function* () {
          expect(
            yield* provider.diff!({ ...diffContext, olds: props, news: props }),
          ).toBeUndefined();
          expect(requests).toHaveLength(0);
        }),
    ),
);

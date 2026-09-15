import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  context,
  groupResponse,
  output,
  parametersResponse,
  props,
  reconcile,
  response,
  withGroup,
} from "./DBParameterGroup.provider.ts";

it.effect(
  "refresh retains explicitly managed engine defaults and extra user overrides across pages",
  () =>
    withGroup(
      ({ action, parameters }) =>
        action === "DescribeDBParameterGroups"
          ? groupResponse()
          : parameters.get("Marker") === "next"
            ? parametersResponse([
                {
                  ParameterName: "work_mem",
                  ParameterValue: "8192",
                  Source: "user",
                },
              ])
            : parametersResponse(
                [
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
                ],
                "next",
              ),
      (provider, requests) =>
        Effect.gen(function* () {
          const result = yield* provider.read!({
            ...context,
            olds: { ...props, parameters: { max_connections: "100" } },
            output,
          });
          expect(result?.parameters).toEqual({
            max_connections: "100",
            work_mem: "8192",
          });
          expect(
            requests.filter(({ action }) => action === "DescribeDBParameters"),
          ).toHaveLength(2);
        }),
    ),
);

it.effect(
  "omitting parameters reports existing user overrides without parameter writes",
  () =>
    withGroup(
      ({ action }) =>
        action === "DescribeDBParameterGroups"
          ? groupResponse()
          : action === "DescribeDBParameters"
            ? parametersResponse([
                {
                  ParameterName: "work_mem",
                  ParameterValue: "8192",
                  Source: "user",
                },
                {
                  ParameterName: "max_connections",
                  ParameterValue: "100",
                  Source: "engine-default",
                },
              ])
            : response(action),
      (provider, requests) =>
        Effect.gen(function* () {
          expect((yield* reconcile(provider, props)).parameters).toEqual({
            work_mem: "8192",
          });
          expect(
            requests.some(
              ({ action }) =>
                action === "ModifyDBParameterGroup" ||
                action === "ResetDBParameterGroup",
            ),
          ).toBe(false);
        }),
    ),
);

import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  errorResponse,
  groupResponse,
  parametersResponse,
  props,
  reconcile,
  response,
  withGroup,
} from "./DBParameterGroup.provider.ts";

it.live(
  "observes an accepted static change without repeating the write or rebooting an instance",
  () => {
    let reads = 0;
    return withGroup(
      ({ action, parameters }) => {
        if (action === "DescribeDBParameterGroups") return groupResponse();
        if (action === "DescribeDBParameters") {
          if (parameters.get("Source") === "user")
            return parametersResponse([]);
          return parametersResponse([
            {
              ParameterName: "max_connections",
              ParameterValue: ++reads < 3 ? "100" : "200",
              Source: "user",
              ApplyType: "static",
            },
          ]);
        }
        return response(action);
      },
      (provider, requests) =>
        Effect.gen(function* () {
          expect(
            (yield* reconcile(provider, {
              ...props,
              parameters: { max_connections: "200" },
            })).parameters,
          ).toEqual({ max_connections: "200" });
          const writes = requests.filter(
            ({ action }) => action === "ModifyDBParameterGroup",
          );
          expect(writes).toHaveLength(1);
          expect(
            writes[0]!.parameters.get("Parameters.Parameter.1.ApplyMethod"),
          ).toBe("pending-reboot");
          expect(reads).toBe(3);
          expect(
            requests.some(({ action }) => action === "RebootDBInstance"),
          ).toBe(false);
        }),
    );
  },
  { timeout: 15000 },
);

it.effect("observes removed overrides returning to their defaults", () => {
  let reset = false;
  return withGroup(
    ({ action }) => {
      if (action === "DescribeDBParameterGroups") return groupResponse();
      if (action === "DescribeDBParameters")
        return parametersResponse([
          {
            ParameterName: "work_mem",
            ParameterValue: reset ? "4096" : "8192",
            Source: reset ? "engine-default" : "user",
            ApplyType: "dynamic",
          },
        ]);
      if (action === "ResetDBParameterGroup") reset = true;
      return response(action);
    },
    (provider, requests) =>
      Effect.gen(function* () {
        expect(
          (yield* reconcile(provider, { ...props, parameters: {} })).parameters,
        ).toEqual({});
        expect(
          requests.filter(({ action }) => action === "ResetDBParameterGroup"),
        ).toHaveLength(1);
      }),
  );
});

it.effect(
  "readback authorization failures fail without another mutation or retry",
  () => {
    let modified = false;
    return withGroup(
      ({ action, parameters }) => {
        if (action === "DescribeDBParameterGroups") return groupResponse();
        if (action === "DescribeDBParameters") {
          if (parameters.get("Source") === "user")
            return parametersResponse([]);
          return modified
            ? errorResponse("AccessDenied", 403)
            : parametersResponse([
                {
                  ParameterName: "work_mem",
                  ParameterValue: "4096",
                  Source: "engine-default",
                  ApplyType: "dynamic",
                },
              ]);
        }
        if (action === "ModifyDBParameterGroup") modified = true;
        return response(action);
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, {
            ...props,
            parameters: { work_mem: "8192" },
          }).pipe(Effect.flip);
          expect(error._tag).toBe("AccessDeniedException");
          expect(
            requests.filter(
              ({ action }) => action === "ModifyDBParameterGroup",
            ),
          ).toHaveLength(1);
          expect(
            requests.filter(({ action }) => action === "DescribeDBParameters"),
          ).toHaveLength(3);
        }),
    );
  },
  { timeout: 5000 },
);

it.live(
  "fails within the bounded observation budget when accepted values never become visible",
  () =>
    withGroup(
      ({ action }) =>
        action === "DescribeDBParameterGroups"
          ? groupResponse()
          : action === "DescribeDBParameters"
            ? parametersResponse([
                {
                  ParameterName: "work_mem",
                  ParameterValue: "4096",
                  Source: "user",
                  ApplyType: "dynamic",
                },
              ])
            : response(action),
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, {
            ...props,
            parameters: { work_mem: "8192" },
          }).pipe(Effect.flip);
          expect(error._tag).toBe("DBParameterGroupNotSettled");
          expect(
            requests.filter(
              ({ action }) => action === "ModifyDBParameterGroup",
            ),
          ).toHaveLength(1);
        }),
    ),
  { timeout: 65000 },
);

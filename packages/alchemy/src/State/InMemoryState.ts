import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ResourceState } from "./ResourceState.ts";
import { State } from "./State.ts";

type StackId = string;
type StageId = string;
type Fqn = string;

export const inMemoryState = (
  initialState: Record<
    StackId,
    Record<StageId, Record<Fqn, ResourceState>>
  > = {},
) => Layer.succeed(State, InMemoryService(initialState));

export const InMemoryService = (
  state: Record<StackId, Record<StageId, Record<Fqn, ResourceState>>> = {},
) =>
  State.of({
    listStacks: () => Effect.succeed(Array.from(Object.keys(state))),
    listStages: (stack: string) =>
      Effect.succeed(
        Array.from(stack in state ? Object.keys(state[stack]) : []),
      ),
    get: ({
      stack,
      stage,
      fqn,
    }: {
      stack: string;
      stage: string;
      fqn: string;
    }) => Effect.succeed(state[stack]?.[stage]?.[fqn]),
    getReplacedResources: ({
      stack,
      stage,
    }: {
      stack: string;
      stage: string;
    }) =>
      Effect.succeed(
        Array.from(Object.values(state[stack]?.[stage] ?? {}) ?? []).filter(
          (s) => s.status === "replaced",
        ),
      ),
    set: <V extends ResourceState>({
      stack,
      stage,
      fqn,
      value,
    }: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) => {
      const stackState = (state[stack] ??= {});
      const stageState = (stackState[stage] ??= {});
      stageState[fqn] = value;
      return Effect.succeed(value);
    },
    delete: ({
      stack,
      stage,
      fqn,
    }: {
      stack: string;
      stage: string;
      fqn: string;
    }) => Effect.succeed(delete state[stack]?.[stage]?.[fqn]),
    deleteStack: ({ stack, stage }: { stack: string; stage?: string }) =>
      Effect.sync(() => {
        if (stage === undefined) {
          delete state[stack];
        } else {
          delete state[stack]?.[stage];
        }
      }),
    list: ({ stack, stage }: { stack: string; stage: string }) =>
      Effect.succeed(
        Array.from(Object.keys(state[stack]?.[stage] ?? {}) ?? []),
      ),
  });

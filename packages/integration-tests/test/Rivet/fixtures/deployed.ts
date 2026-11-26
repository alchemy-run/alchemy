/**
 * What a scratch stack deployed, read from its state: the identities
 * (App names, ARNs, addresses) the out-of-band checks look the deployed
 * configuration up by, and the control plane's token those checks look for.
 */
import { expect } from "@alchemy.run/test";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { CLASS_SECRET } from "./class-secret.ts";

interface DeployedStack {
  readonly name: string;
  readonly stage: string;
  readonly state: Layer.Layer<State.State>;
}

export interface Deployed {
  readonly fqn: string;
  readonly props: Record<string, unknown>;
  readonly attr: Record<string, unknown>;
}

/** The stack's resources of `type`, whose FQN matches `fqn` when given. */
export const deployed = Effect.fn(function* (stack: DeployedStack, type: string, fqn?: RegExp) {
  return yield* Effect.gen(function* () {
    const state = yield* yield* State.State;
    const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
    const rows: Deployed[] = [];
    for (const name of [...fqns].sort()) {
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: name });
      if (!State.isResourceState(row) || row.resourceType !== type || row.attr === undefined)
        continue;
      if (fqn !== undefined && !fqn.test(name)) continue;
      rows.push({
        fqn: name,
        props: (row.props ?? {}) as Record<string, unknown>,
        attr: row.attr as Record<string, unknown>,
      });
    }
    return rows;
  }).pipe(Effect.provide(stack.state));
});

/** The control plane's admin token, as the stack's pools were given it. */
export const controlPlaneToken = Effect.fn(function* (stack: DeployedStack) {
  const [pool] = yield* deployed(stack, "Rivet.Pool");
  const token = pool?.props.token;
  const value = Redacted.isRedacted(token) ? Redacted.value(token) : token;
  expect(typeof value).toBe("string");
  expect((value as string).length).toBeGreaterThan(8);
  return value as string;
});

/** `config` holds neither the token nor the class's secret, nor a `RIVET_TOKEN` value. */
export const expectNoSecrets = (config: unknown, token: string) => {
  const text = JSON.stringify(config) ?? "";
  expect(text).not.toContain(token);
  expect(text).not.toContain(CLASS_SECRET);
};

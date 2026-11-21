/** Out-of-band reads of what the Rivet Fly hosts deployed, through distilled. */
import { resolveOrgSlug } from "@alchemy.run/fly/Environment";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";

/** The org's Machines on one page, and the cursor to the next. */
const page = (org: string, cursor: string | undefined) =>
  machines.listMachinesOrg({ org_slug: org, cursor, summary: false });

/**
 * Every App holding a Machine of the stack's stage, with its Machines'
 * full configs and the names of its App secrets.
 */
export const stackApps = Effect.fn(function* (stack: {
  readonly name: string;
  readonly stage: string;
}) {
  const org = yield* resolveOrgSlug();
  const apps = new Set<string>();
  let cursor: string | undefined;
  // The org listing pages at most 1000 Machines; a bounded walk.
  for (let i = 0; i < 20; i++) {
    const { machines: listed, next_cursor } = yield* page(org, cursor);
    for (const machine of listed ?? []) {
      const metadata = machine.config?.metadata ?? {};
      if (
        machine.app_name !== undefined &&
        metadata["alchemy.stack"] === stack.name &&
        metadata["alchemy.stage"] === stack.stage
      ) {
        apps.add(machine.app_name);
      }
    }
    if (!next_cursor || (listed ?? []).length === 0) break;
    cursor = next_cursor;
  }
  return yield* Effect.forEach(
    [...apps].sort(),
    (app) =>
      Effect.all({
        app: Effect.succeed(app),
        machines: machines.listMachines({ app_name: app }),
        secrets: machines
          .listSecrets({ app_name: app, show_secrets: false })
          .pipe(Effect.map(({ secrets }) => (secrets ?? []).map((secret) => secret.name ?? ""))),
      }),
    { concurrency: 4 },
  );
});

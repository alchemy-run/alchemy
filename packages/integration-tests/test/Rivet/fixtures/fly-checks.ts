/** Out-of-band reads of what the Rivet Fly hosts deployed, through distilled. */
import { resolveOrgSlug } from "@alchemy.run/fly/Environment";
import { matchesAlchemyPhysicalName } from "@alchemy.run/fly/Metadata";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";

/**
 * Every App holding a Machine of the stack's stage, with its Machines'
 * full configs and the names of its App secrets.
 */
export const stackApps = Effect.fn(function* (stack: {
  readonly name: string;
  readonly stage: string;
}) {
  // Without a limit, every App of the org comes back in one response.
  const { apps } = yield* machines.listApps({ org_slug: yield* resolveOrgSlug() });
  const listed = yield* Effect.forEach(
    (apps ?? []).flatMap((app) =>
      app.name !== undefined && matchesAlchemyPhysicalName(app.name) ? [app.name] : [],
    ),
    (app) =>
      machines.listMachines({ app_name: app }).pipe(
        // Another stack's App may be deleted between the two calls.
        Effect.catchTag("NotFound", () => Effect.succeed([])),
        Effect.map((appMachines) => ({ app, machines: appMachines })),
      ),
    { concurrency: 8 },
  );
  const ours = listed.filter(({ machines: appMachines }) =>
    appMachines.some(
      (machine) =>
        machine.config?.metadata?.["alchemy.stack"] === stack.name &&
        machine.config?.metadata?.["alchemy.stage"] === stack.stage,
    ),
  );
  return yield* Effect.forEach(
    ours.sort((a, b) => a.app.localeCompare(b.app)),
    ({ app, machines: appMachines }) =>
      machines.listSecrets({ app_name: app, show_secrets: false }).pipe(
        Effect.map(({ secrets }) => ({
          app,
          machines: appMachines,
          secrets: (secrets ?? []).map((secret) => secret.name ?? ""),
        })),
      ),
    { concurrency: 4 },
  );
});

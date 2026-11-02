import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as workflows from "@distilled.cloud/stackit/workflows";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  AIRFLOW_2,
  AIRFLOW_3,
  expectGone,
  gitBundle,
  noIdentityProvider,
  observeInstance,
  slow,
} from "./workflows.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("workflows", "instance"),
  timeout: 3_600_000,
} as const;

const props = {
  description: "Alchemy test instance",
  version: AIRFLOW_3,
  dagBundles: [gitBundle("first")],
} satisfies Stackit.Workflows.InstanceProps;

const bundleNames = (projectId: string, region: string, instanceId: string) =>
  workflows
    .listDagBundles({ projectId, regionId: region, instanceId })
    .pipe(Effect.map(({ dagBundles }) => dagBundles.map((bundle) => bundle.name).sort()));

test.provider.skipIf(slow)(
  "create, update in place, converge DAG bundles, recover and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // A generated name, within the API's 25 characters.
      const created = yield* stack.deploy(Stackit.Workflows.Instance("BasicInstance", props));
      expect(created.status).toEqual("active");
      expect(created.displayName.length).toBeLessThanOrEqual(25);
      expect(created.description).toEqual(props.description);
      expect(created.version).toEqual(AIRFLOW_3);
      expect(created.url).toMatch(/^https:\/\//);
      expect(created.redirectUrl).toMatch(/^https:\/\//);
      expect(created.dagBundles.map((bundle) => bundle.name)).toEqual(["first"]);

      // Out of band: the instance exists as declared.
      const fetched = yield* workflows.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(fetched.displayName).toEqual(created.displayName);
      expect(fetched.status).toEqual("active");
      expect(fetched.description).toEqual(props.description);
      const createdBundles = yield* bundleNames(projectId, region, created.instanceId);
      expect(createdBundles).toEqual(["first"]);

      // `list` finds it by its generated name.
      const provider = yield* Provider.findProvider(Stackit.Workflows.Instance);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.instanceId === created.instanceId)?.displayName).toEqual(
        created.displayName,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Workflows.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Name, description and bundles update in place, on the same instance. The new bundle
      // comes up before the old one goes, because the API refuses to delete the last one.
      const updated = yield* stack.deploy(
        Stackit.Workflows.Instance("BasicInstance", {
          displayName: "alchemy-renamed",
          description: "Updated",
          version: AIRFLOW_3,
          dagBundles: [{ ...gitBundle("first"), refreshInterval: 120 }, gitBundle("second")],
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.status).toEqual("active");
      expect(updated.displayName).toEqual("alchemy-renamed");
      const updatedBundles = yield* bundleNames(projectId, region, created.instanceId);
      expect(updatedBundles).toEqual(["first", "second"]);
      const first = yield* workflows.getDagBundle({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
        bundleName: "first",
      });
      expect(first.refreshInterval).toEqual(120);
      // Neighbouring settings stay.
      expect(first).toMatchObject({ branch: "3.1.8", url: gitBundle("first").url });

      // Removing a bundle deletes that one, and only that one.
      const trimmed = yield* stack.deploy(
        Stackit.Workflows.Instance("BasicInstance", {
          displayName: "alchemy-renamed",
          description: "Updated",
          version: AIRFLOW_3,
          dagBundles: [gitBundle("second")],
        }),
      );
      expect(trimmed.dagBundles.map((bundle) => bundle.name)).toEqual(["second"]);
      const trimmedBundles = yield* bundleNames(projectId, region, created.instanceId);
      expect(trimmedBundles).toEqual(["second"]);

      // A lone bundle can't change type, and the attempt touches nothing.
      const refused = yield* stack
        .deploy(
          Stackit.Workflows.Instance("BasicInstance", {
            displayName: "alchemy-renamed",
            description: "Updated",
            version: AIRFLOW_3,
            dagBundles: [
              {
                type: "s3",
                name: "second",
                bucketName: "alchemy-test-dags",
                s3Auth: { type: "none" },
              },
            ],
          }),
        )
        .pipe(Effect.flip);
      expect(refused._tag).toEqual("Stackit.Workflows.DagBundleTypeChange");
      const untouched = yield* workflows.getDagBundle({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
        bundleName: "second",
      });
      expect(untouched.type).toEqual("git");

      // Back to the generated name, then what a crash after the create call leaves: a row still
      // creating, with its generation, and no copy of the id. The next deploy finds the instance
      // by that generation's name, and doesn't create a second one.
      const unnamed = yield* stack.deploy(
        Stackit.Workflows.Instance("BasicInstance", {
          displayName: created.displayName,
          description: props.description,
          version: AIRFLOW_3,
          dagBundles: [gitBundle("first")],
        }),
      );
      expect(unnamed.instanceId).toEqual(created.instanceId);
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "BasicInstance" };
        const row = yield* state.get(key);
        if (row?.status !== "created") {
          return yield* Effect.fail(new Error("Expected a created row"));
        }
        const { attr: _attr, ...rest } = row;
        yield* state.set({
          ...key,
          value: { ...rest, status: "creating" } satisfies CreatingResourceState,
        });
      }).pipe(Effect.provide(stack.state));
      const recovered = yield* stack.deploy(Stackit.Workflows.Instance("BasicInstance", props));
      expect(recovered.instanceId).toEqual(created.instanceId);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a change of Airflow major version replaces the instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const old = yield* stack.deploy(
        Stackit.Workflows.Instance("MajorVersionInstance", {
          version: AIRFLOW_2,
          dagsRepository: {
            url: gitBundle("repository").url,
            branch: gitBundle("repository").branch,
            auth: gitBundle("repository").auth,
          },
        }),
      );
      expect(old.version).toEqual(AIRFLOW_2);
      expect(old.dagsRepository?.url).toEqual(gitBundle("repository").url);

      const airflow3 = Stackit.Workflows.Instance("MajorVersionInstance", {
        version: AIRFLOW_3,
        dagBundles: [gitBundle("first")],
      });
      const plan = yield* stack.plan(airflow3);
      expect(plan.resources.MajorVersionInstance).toMatchObject({ action: "replace" });

      const replaced = yield* stack.deploy(airflow3);
      expect(replaced.instanceId).not.toEqual(old.instanceId);
      expect(replaced.version).toEqual(AIRFLOW_3);
      yield* expectGone(observeInstance(projectId, region, old.instanceId));

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, replaced.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an explicit name found without state is unowned, and adopt takes it over",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // A foreign instance: created here, out of band, under an explicit name. Until it is
      // adopted it has no labels for `pnpm nuke` to find, so it goes whatever the assertions do.
      yield* Effect.acquireUseRelease(
        workflows.createInstance({
          projectId,
          regionId: region,
          displayName: "alchemy-foreign",
          version: AIRFLOW_3,
          dagBundles: [gitBundle("first")],
        }),
        (foreign) =>
          Effect.gen(function* () {
            const instance = Stackit.Workflows.Instance("ForeignInstance", {
              displayName: "alchemy-foreign",
              version: AIRFLOW_3,
              description: "Adopted",
              dagBundles: [gitBundle("first")],
            });
            const refused = yield* stack.deploy(instance).pipe(Effect.flip);
            expect(refused._tag).toEqual("OwnedBySomeoneElse");
            const stillThere = yield* observeInstance(projectId, region, foreign.id);
            expect(stillThere).not.toEqual("gone");

            const adopted = yield* stack.deploy(instance.pipe(adopt(true)));
            expect(adopted.instanceId).toEqual(foreign.id);
            expect(adopted.status).toEqual("active");
            expect(adopted.description).toEqual("Adopted");

            // Adopted, and nothing is left to do. The stack owns it now, so destroying it
            // deletes it.
            const plan = yield* stack.plan(instance.pipe(adopt(true)));
            expect(plan.resources.ForeignInstance).toMatchObject({ action: "noop" });

            yield* stack.destroy();
            yield* expectGone(observeInstance(projectId, region, foreign.id));
          }),
        (foreign) =>
          workflows
            .deleteInstance({ projectId, regionId: region, instanceId: foreign.id })
            .pipe(Effect.ignore),
      );
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow || noIdentityProvider)(
  "switches the identity provider, and a new client secret updates it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.Workflows.Instance("IdentityProviderInstance", {
          version: AIRFLOW_3,
          dagBundles: [gitBundle("first")],
        }),
      );

      const identityProvider = (secret: string): Stackit.Workflows.InstanceIdentityProvider => ({
        type: "oauth2",
        name: "keycloak",
        clientId: process.env.STACKIT_TEST_WORKFLOWS_IDP_CLIENT_ID!,
        clientSecret: Redacted.make(secret),
        discoveryEndpoint: process.env.STACKIT_TEST_WORKFLOWS_IDP_DISCOVERY!,
        scope: "openid email",
        apiAudience: [process.env.STACKIT_TEST_WORKFLOWS_IDP_AUDIENCE!],
      });
      const realSecret = process.env.STACKIT_TEST_WORKFLOWS_IDP_CLIENT_SECRET!;

      const switched = yield* stack.deploy(
        Stackit.Workflows.Instance("IdentityProviderInstance", {
          version: AIRFLOW_3,
          dagBundles: [gitBundle("first")],
          identityProvider: identityProvider(realSecret),
        }),
      );
      expect(switched.instanceId).toEqual(created.instanceId);
      expect(switched.identityProvider).toMatchObject({
        type: "oauth2",
        name: "keycloak",
        apiAudience: [process.env.STACKIT_TEST_WORKFLOWS_IDP_AUDIENCE!],
      });
      expect(JSON.stringify(switched)).not.toContain(realSecret);

      // Out of band: the API has it.
      const fetched = yield* workflows.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(fetched.identityProvider.type).toEqual("oauth2");

      // Unchanged is a no-op, and only the secret changing is still an update.
      const same = yield* stack.plan(
        Stackit.Workflows.Instance("IdentityProviderInstance", {
          version: AIRFLOW_3,
          dagBundles: [gitBundle("first")],
          identityProvider: identityProvider(realSecret),
        }),
      );
      expect(same.resources.IdentityProviderInstance).toMatchObject({ action: "noop" });
      const rotated = yield* stack.plan(
        Stackit.Workflows.Instance("IdentityProviderInstance", {
          version: AIRFLOW_3,
          dagBundles: [gitBundle("first")],
          identityProvider: identityProvider(`${realSecret}-rotated`),
        }),
      );
      expect(rotated.resources.IdentityProviderInstance).toMatchObject({ action: "update" });

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  options,
);

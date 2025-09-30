# Reworking Alchemy's Telemetry

## Why we left posthog

Alchemy used to use posthog for our platform analytics. While posthot was really easy to set up (see our example here) it simply didn't meet our needs. One of our most important metrics is the number of projects that use alchemy. In order to get quality analytics from posthog we would need to give each alchemy project a dedicated project id and maintain that id as a project grows; this proves to be quite a challenging issue. We can't just use a UUID and store it somewhere as alchemy doesn't have a config file, and we don't expect the `.alchemy` directory to be committed. We explored using various other solutions such as the root commit hash (unavailable for partial clone) or the git upstream url (breaks if origin changes) but none of these solutions were reliably enough. Ultimately we decided to identify projects based on multiple factors instead of having a single id.

Between not having a consistent project id, and multiple of our team members having experience with datalakes and large scale analytics solutions, we decided to switch to a more developer-oriented solutions. Just having all of our own data in-house so we can do whatever we want with it as we please.

That being said posthog is great at what it does, and we will continue to use posthog for our web analytics where its still a great fit!

## Why We Chose Clickhouse Cloud

We started with a few criteria
- we wanted an OLAP database since they are great for analytics
- we wanted something SQL based so we didn't have to learn a new query language
- we wanted something to avoid the big cloud providers as we don't support GCP or Azure yet, and we are in the middle of revamping our AWS resources as part of our [effect](https://effect.website/) based rewrite.
- we wanted something quick as the team was getting frustrated with our current analytics solution.
- preferrably a nice controlplane api

After looking at the options we decided to go with Clickhouse Cloud. It had a great controlplane api so making a resource was easy. First we generate a typescript api from Clickhouse's OpenAPI spec, then we write our alchemy resource.

This is a simplified example, but we're omitting clickhouse's plethora of customization options for brevity, but the full resource is available [here](https://github.com/alchemy-framework/alchemy/blob/main/alchemy/src/clickhouse/service.ts).

```ts
export const Service = Resource(
  "clickhouse::Service",
  async function (
    this: Context<Service>,
    id: string,
    props: ServiceProps,
  ): Promise<Service> {
    const api = createClickhouseApi();
    const minReplicaMemoryGb = props.minReplicaMemoryGb ?? 8;
    const maxReplicaMemoryGb = props.maxReplicaMemoryGb ?? 356;
    const numReplicas = props.numReplicas ?? 3;
    const name = this.scope.createPhysicalName(id);

    if (this.phase === "delete") {
      await api.deleteService({
        path: {
          organizationId: props.organization.id,
          serviceId: this.output.clickhouseId,
        },
      });
      return this.destroy();
    }
    if (this.phase === "update") {
      const resourceDiff = diff(props,this.output,);
      const updates: Partial<Service> = {};

      if (resourceDiff.some((prop) => prop === "name" && prop === "minReplicaMemoryGb" && prop === "maxReplicaMemoryGb" && prop === "numReplicas")) { return this.replace(); }

      if (resourceDiff.some((prop) => prop === "name")) {
        const response = (
          await api.updateServiceBasicDetails({
            path: {
              organizationId: props.organization.id,
              serviceId: this.output.clickhouseId,
            },
            body: { name },
          })
        ).data.result;

        updates.name = response.name;
        updates.mysqlEndpoint = response.endpoints.find(
          (endpoint) => endpoint.protocol === "mysql",
        ) as any;
        updates.httpsEndpoint = response.endpoints.find(
          (endpoint) => endpoint.protocol === "https",
        ) as any;
      }

      if (
        resourceDiff.some(
          (prop) => prop === "minReplicaMemoryGb" || prop === "maxReplicaMemoryGb" || prop === "numReplicas",
        )
      ) {
        const response = (
          await api.updateServiceAutoScalingSettings2({
            path: {
              organizationId: props.organization.id,
              serviceId: this.output.clickhouseId,
            },
            body: {
              minReplicaMemoryGb: props.minReplicaMemoryGb,
              maxReplicaMemoryGb: props.maxReplicaMemoryGb,
              numReplicas: props.numReplicas,
            },
          })
        ).data.result;

        updates.minReplicaMemoryGb = response.minReplicaMemoryGb;
        updates.maxReplicaMemoryGb = response.maxReplicaMemoryGb;
        updates.numReplicas = response.numReplicas;
      }

      return {
        ...this.output,
        ...updates,
      };
    }

    const response = (
      await api.createNewService({
        path: {
          organizationId: props.organization.id,
        },
        body: {
          name,
          provider: props.provider,
          region: props.region,
          minReplicaMemoryGb: minReplicaMemoryGb,
          maxReplicaMemoryGb: maxReplicaMemoryGb,
          numReplicas: numReplicas,
        },
      })
    ).data.result;

    return {
      organizationId: props.organization.id,
      name: response.service.name,
      clickhouseId: response.service.id,
      password: secret(response.password),
      provider: response.service.provider,
      region: response.service.region,
      minReplicaMemoryGb: response.service.minReplicaMemoryGb,
      maxReplicaMemoryGb: response.service.maxReplicaMemoryGb,
      numReplicas: response.service.numReplicas,
      mysqlEndpoint: response.service.endpoints.find(
        (endpoint) => endpoint.protocol === "mysql",
      ) as any,
      httpsEndpoint: response.service.endpoints.find(
        (endpoint) => endpoint.protocol === "https",
      ) as any,
    };
  },
);
```

Its only about 100 lines of code and now we have an alchemy resource for clickhouse.

## Using the resource

While our telemetry backend isn't open source, the `alchemy.run.ts` file is less than 25 lines.

```ts
// imports
export const app = await alchemy("alchemy-telemetry");
const organization = await getOrganizationByName(alchemy.env.CLICKHOUSE_ORG);

const clickhouse = await Service("clickhouse", {
	organization,
	provider: "aws",
	region: "us-east-1",
	minReplicaMemoryGb: 8,
	maxReplicaMemoryGb: 356,
	numReplicas: 3,
});

await Exec("migrations", {
	command: `bunx clickhouse-migrations migrate --db default --host https://${clickhouse.httpsEndpoint?.host}:${clickhouse.httpsEndpoint?.port} --user ${clickhouse.mysqlEndpoint?.username} --password ${clickhouse.password.unencrypted} --migrations-home ${join(import.meta.dirname, "migrations")}`,
});

export const ingestWorker = await Worker("ingest-worker", {
	adopt: true,
	entrypoint: "./deployments/telemetry.ts",
	bindings: {
		CLICKHOUSE_URL: `https://${clickhouse.httpsEndpoint?.host}:${clickhouse.httpsEndpoint?.port}`,
		CLICKHOUSE_PASSWORD: clickhouse.password,
	},
	domains: ["telemetry.alchemy.run"],
});

await app.finalize();
```

## Future Improvements

Just dumping data straight to clickhouse is by no means the best solution, we understand that! Our goal here was to quickly spin up some data storage and fix our analytics; We'll share more in depth technical details in the future on how to bring down costs and build a more enterprise level data solution on top of alchemy.
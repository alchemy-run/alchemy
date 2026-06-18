import * as Alchemy from "alchemy";
import * as Docker from "alchemy/Docker";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const POSTGRES_PORT = 15432;
const POSTGRES_CONTAINER = "alchemy-example-postgres";
const EMPTY_RUNTIME: Docker.ContainerRuntimeInfo = { ports: {} };

export default Alchemy.Stack(
  "DockerPostgresExample",
  { providers: Docker.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const password = yield* Config.redacted("POSTGRES_PASSWORD").pipe(
      Config.withDefault(Redacted.make("alchemy-postgres")),
    );

    const image = yield* Docker.RemoteImage("postgres-image", {
      name: "postgres",
      tag: "18-alpine",
      alwaysPull: false,
    });
    const network = yield* Docker.Network("app-network");
    const data = yield* Docker.Volume("postgres-data");

    const postgres = yield* Docker.Container("postgres", {
      name: POSTGRES_CONTAINER,
      image,
      environment: {
        POSTGRES_DB: "app",
        POSTGRES_USER: "alchemy",
        POSTGRES_PASSWORD: password,
      },
      ports: [{ external: POSTGRES_PORT, internal: 5432 }],
      volumes: [
        {
          hostPath: data.name,
          containerPath: "/var/lib/postgresql/data",
        },
      ],
      networks: [{ name: network.name, aliases: ["postgres"] }],
      healthcheck: {
        cmd: ["CMD-SHELL", "pg_isready -U alchemy -d app"],
        interval: "5s",
        timeout: "5s",
        retries: 10,
      },
      start: true,
    });

    const runtime = yield* Docker.Container.inspect(POSTGRES_CONTAINER).pipe(
      Effect.catchTag("DockerCommandError", () =>
        Effect.succeed(EMPTY_RUNTIME),
      ),
    );

    return {
      container: postgres.name,
      image: image.imageRef,
      network: network.name,
      volume: data.name,
      hostPort: runtime.ports["5432/tcp"] ?? POSTGRES_PORT,
      connectionString: `postgres://alchemy:***@localhost:${POSTGRES_PORT}/app`,
    };
  }),
);

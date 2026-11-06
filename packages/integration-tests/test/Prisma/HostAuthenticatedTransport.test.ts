import { PrismaClient, PrismaClientLive } from "@alchemy.run/prisma/Client";
import { PrismaEnvironment } from "@alchemy.run/prisma/PrismaEnvironment";
import { Project as PrismaProject, ProjectProvider } from "@alchemy.run/prisma/Project";
import { describe, expect, it } from "@alchemy.run/test";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Credentials from "../../../prisma/src/internal/Credentials.ts";
import {
  FAKE_API_BASE_URL,
  data,
  page,
  unhandled,
  wireProject,
} from "./fixtures/FakeManagementApi.ts";
import { testStackContext } from "./fixtures/StackContext.ts";

const hostTransport = () => {
  const sent: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      sent.push(request);
      const { pathname } = new URL(request.url);
      const response =
        pathname === "/v1/projects" || pathname === "/v1/projects/project-1/databases"
          ? page([])
          : pathname === "/v1/projects/project-1"
            ? data(wireProject())
            : unhandled({
                url: request.url,
                method: request.method,
                pathname,
                search: "",
                authorization: request.headers.authorization,
                bodyJson: undefined,
              });
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const environmentWithoutToken = Layer.succeed(PrismaEnvironment, {
  type: "serviceToken" as const,
  source: { type: "stored" as const },
  baseUrl: FAKE_API_BASE_URL,
});

describe(
  "Prisma host-authenticated transport",
  { tags: ["unit", "provider:prisma", "local"] },
  () => {
    it.effect("sends provider and client requests without an Authorization header", () => {
      const transport = hostTransport();

      return Effect.gen(function* () {
        const projectProvider = yield* Provider.findProvider(PrismaProject);
        const project = yield* projectProvider.read!({
          id: "Project",
          fqn: "Project",
          instanceId: "00000000000000000000000000000000",
          olds: { name: "app" },
          output: { projectId: "project-1" },
        } as never);
        const client = yield* PrismaClient;
        yield* client.listProjects();
        const buildLogs = yield* client.getBuildLogsRequest("build-1");

        expect(project).toMatchObject({ projectId: "project-1" });
        expect(
          transport.sent.map((request) => {
            const { origin, pathname } = new URL(request.url);
            return `${request.method} ${origin}${pathname}`;
          }),
        ).toEqual([
          `GET ${FAKE_API_BASE_URL}/v1/projects/project-1`,
          `GET ${FAKE_API_BASE_URL}/v1/projects/project-1/databases`,
          `GET ${FAKE_API_BASE_URL}/v1/projects`,
        ]);
        for (const request of transport.sent) {
          expect(request.headers.authorization).toBeUndefined();
        }
        expect(buildLogs.headers).toEqual({ Accept: "application/x-ndjson" });
      }).pipe(
        Effect.provide(
          ProjectProvider().pipe(
            Layer.provideMerge(PrismaClientLive),
            Layer.provideMerge(Credentials.fromEnvironment()),
            Layer.provide(environmentWithoutToken),
            Layer.provideMerge(transport.layer),
            Layer.provide(
              Layer.succeed(AlchemyContext, {
                dotAlchemy: ".alchemy-test",
                dev: false,
                adopt: false,
              }),
            ),
            Layer.provide(testStackContext),
          ),
        ),
      );
    });
  },
);

import { providers } from "@/Forgejo/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Layer from "effect/Layer";
import type { MockForgejo } from "./mock.ts";

/**
 * Instance origin every mock-backed suite points the provider collection at.
 */
export const BASE_URL = "https://forge.example";

/**
 * Build the per-file test API against a mock instance.
 *
 * The SDK resolves `HttpClient` from the environment rather than constructing
 * one, and `providers()` hands the client it is built with to every resource,
 * so providing the mock's client points the whole collection at its in-memory
 * route table.
 */
export const forgejoTest = (server: MockForgejo) =>
  Test.make({
    providers: providers({ baseUrl: BASE_URL, token: "admin-token" }).pipe(
      Layer.provide(server.layer),
    ),
  });

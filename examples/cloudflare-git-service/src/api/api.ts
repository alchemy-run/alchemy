/**
 * The API the app serves: the git routes plus ours, every one behind the
 * middleware. This is the boundary the UI talks to.
 */
import * as Git from "alchemy/Git";
import { Authenticated } from "./middleware.ts";
import { AppRoutes } from "./routes.ts";

export class AppApi extends Git.Api.add(AppRoutes).middleware(Authenticated) {}

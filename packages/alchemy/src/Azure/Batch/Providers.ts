import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import { Application, ApplicationProvider } from "./Application.ts";
import {
  ApplicationPackage,
  ApplicationPackageProvider,
} from "./ApplicationPackage.ts";
import { Pool, PoolProvider } from "./Pool.ts";

export const resources = [Account, Application, ApplicationPackage, Pool];
export const layers = () =>
  Layer.mergeAll(
    AccountProvider(),
    ApplicationProvider(),
    ApplicationPackageProvider(),
    PoolProvider(),
  );

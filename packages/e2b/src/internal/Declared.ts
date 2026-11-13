import * as Declared from "alchemy/Declared";
import type { Providers } from "../Providers.ts";

/** Let a resource's props hold declarations of other resources. */
export const declarable = Declared.declarable<Providers>();

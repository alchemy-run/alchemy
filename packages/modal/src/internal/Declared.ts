import * as Declared from "alchemy/Declared";
import type { Providers } from "../Providers.ts";

/** Props where any value may be a resource declaration. */
export type DeclaredProps<P> = Declared.DeclaredProps<P, Providers>;

export const resolveDeclarations = Declared.resolveDeclarations;

/** Let a resource's props hold declarations of other resources. */
export const declarable = Declared.declarable<Providers>();

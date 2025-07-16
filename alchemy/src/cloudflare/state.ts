import {
  D1StateStore as _D1StateStore,
  DOFSStateStore as _DOFSStateStore,
  R2RestStateStore as _R2RestStateStore,
} from "../state/index.ts";

/**
 * @deprecated Use `R2RestStateStore` from `alchemy/state` instead.
 */
export const R2RestStateStore = _R2RestStateStore;

/**
 * @deprecated Use `R2RestStateStore` from `alchemy/state` instead.
 */
export type R2RestStateStore = _R2RestStateStore;

/**
 * @deprecated This state store is no longer recommended for production use. Please use {@link https://alchemy.run/guides/cloudflare-state-store/ CloudflareStateStore} from `alchemy/state` instead.
 */
export const DOStateStore = _DOFSStateStore;

/**
 * @deprecated Use `DOStateStore` from `alchemy/state` instead.
 */
export type DOStateStore = _DOFSStateStore;

/**
 * @deprecated Use `D1StateStore` from `alchemy/state` instead.
 */
export const D1StateStore = _D1StateStore;

/**
 * @deprecated Use `D1StateStore` from `alchemy/state` instead.
 */
export type D1StateStore = _D1StateStore;

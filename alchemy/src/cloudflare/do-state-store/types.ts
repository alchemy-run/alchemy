import type { State } from "../../state.ts";

export namespace DOStateStoreAPI {
  export type API = {
    validate: {
      method: "validate";
      params: null;
      result: null;
    };
    get: {
      method: "get";
      params: { key: string };
      result: string | undefined;
    };
    getBatch: {
      method: "getBatch";
      params: { keys: string[] };
      result: Record<string, string>;
    };
    all: {
      method: "all";
      params: { prefix: string };
      result: Record<string, string>;
    };
    set: {
      method: "set";
      params: { key: string; value: State };
      result: null;
    };
    delete: {
      method: "delete";
      params: { key: string };
      result: null;
    };
    list: {
      method: "list";
      params: { prefix: string };
      result: string[];
    };
    count: {
      method: "count";
      params: { prefix: string };
      result: number;
    };
  };

  export interface Context {
    app: string;
    stage: string;
  }

  export type Request = {
    [K in keyof API]: {
      method: K;
      params: API[K]["params"];
    };
  }[keyof API];

  export interface SuccessResponse<T extends keyof API = keyof API> {
    success: true;
    status: number;
    result: API[T]["result"];
  }

  export interface ErrorResponse {
    success: false;
    status: number;
    error: string;
  }

  export type Response<T extends keyof API = keyof API> =
    | SuccessResponse<T>
    | ErrorResponse;
}

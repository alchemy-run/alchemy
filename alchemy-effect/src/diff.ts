export type Diff = NoopDiff | UpdateDiff | ReplaceDiff;

export interface NoopDiff {
  action: "noop";
  stables?: undefined;
}

export interface UpdateDiff {
  action: "update";
  /** properties that won't change as part of this update */
  stables?: string[];
}

export interface ReplaceDiff {
  action: "replace";
  deleteFirst?: boolean;
  stables?: undefined;
}

export const somePropsAreDifferent = <Props extends Record<string, any>>(
  olds: Props,
  news: Props,
  props: (keyof Props)[],
) => {
  for (const prop of props) {
    if (olds[prop] !== news[prop]) {
      return true;
    }
  }
  return false;
};

export const anyPropsAreDifferent = <Props extends Record<string, any>>(
  olds: Props,
  news: Props,
) => {
  for (const prop in olds) {
    if (olds[prop] !== news[prop]) {
      return true;
    }
  }
  for (const prop in news) {
    if (!(prop in olds)) {
      return true;
    }
  }
  return false;
};

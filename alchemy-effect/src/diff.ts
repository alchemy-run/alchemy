export type Diff =
  | {
      action: "noop";
      deleteFirst?: undefined;
      stables?: undefined;
    }
  | {
      action: "update";
      deleteFirst?: undefined;
      /** properties that won't change as part of this update */
      stables?: string[];
    }
  | {
      action: "replace";
      deleteFirst?: boolean;
      stables?: undefined;
    };

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

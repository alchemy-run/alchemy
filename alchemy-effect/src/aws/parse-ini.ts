import type { ParsedIniData } from "@smithy/types";
import { IniSectionType } from "@smithy/types";

const CONFIG_PREFIX_SEPARATOR = ".";

const prefixKeyRegex = /^([\w-]+)\s(["'])?([\w-@\+\.%:/]+)\2$/;
const profileNameBlockList = ["__proto__", "profile __proto__"];

export const parseIni = (iniData: string): ParsedIniData => {
  const map: ParsedIniData = {};

  let currentSection: string | undefined;
  let currentSubSection: string | undefined;

  for (const iniLine of iniData.split(/\r?\n/)) {
    const trimmedLine = iniLine.split(/(^|\s)[;#]/)[0].trim(); // remove comments and trim
    const isSection: boolean =
      trimmedLine[0] === "[" && trimmedLine[trimmedLine.length - 1] === "]";
    if (isSection) {
      // New section found. Reset currentSection and currentSubSection.
      currentSection = undefined;
      currentSubSection = undefined;

      const sectionName = trimmedLine.substring(1, trimmedLine.length - 1);
      const matches = prefixKeyRegex.exec(sectionName);
      if (matches) {
        const [, prefix, , name] = matches;
        // Add prefix, if the section name starts with `profile`, `sso-session` or `services`.
        if (Object.values(IniSectionType).includes(prefix as IniSectionType)) {
          currentSection = [prefix, name].join(CONFIG_PREFIX_SEPARATOR);
        }
      } else {
        // If the section name does not match the regex, use the section name as is.
        currentSection = sectionName;
      }

      if (profileNameBlockList.includes(sectionName)) {
        throw new Error(`Found invalid profile name "${sectionName}"`);
      }
    } else if (currentSection) {
      const indexOfEqualsSign = trimmedLine.indexOf("=");
      if (![0, -1].includes(indexOfEqualsSign)) {
        const [name, value]: [string, string] = [
          trimmedLine.substring(0, indexOfEqualsSign).trim(),
          trimmedLine.substring(indexOfEqualsSign + 1).trim(),
        ];
        if (value === "") {
          currentSubSection = name;
        } else {
          if (currentSubSection && iniLine.trimStart() === iniLine) {
            // Reset currentSubSection if there is no whitespace
            currentSubSection = undefined;
          }
          map[currentSection] = map[currentSection] || {};
          const key = currentSubSection
            ? [currentSubSection, name].join(CONFIG_PREFIX_SEPARATOR)
            : name;
          map[currentSection][key] = value;
        }
      }
    }
  }

  return map;
};

export const parseSSOSessionData = (data: ParsedIniData): ParsedIniData =>
  Object.entries(data)
    // filter out non sso-session keys
    .filter(([key]) =>
      key.startsWith(IniSectionType.SSO_SESSION + CONFIG_PREFIX_SEPARATOR),
    )
    // replace sso-session key with sso-session name
    .reduce(
      (acc, [key, value]) => ({
        ...acc,
        [key.substring(key.indexOf(CONFIG_PREFIX_SEPARATOR) + 1)]: value,
      }),
      {},
    );

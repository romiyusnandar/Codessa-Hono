export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "id", label: "Indonesian" },
  { code: "zh", label: "Chinese" },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export const DEFAULT_LANGUAGE_CODE: SupportedLanguageCode = "en";

export function getLanguageLabel(code: string | undefined): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.label ?? "English";
}

/**
 * services/worker/src/shared/utils/sanitizer.ts
 */

export const sanitizeRawInput = (rawText: string): string => {
  if (!rawText) return '';
  let cleanText = rawText.replace(/[<>{}[\\]]/g, '');
  return cleanText.trim();
};

export const escapeSpreadsheetFormula = (value: string | undefined): string => {
  if (!value) return '';
  const trimmed = value.trim();
  if (/^[=+\-@]/.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
};

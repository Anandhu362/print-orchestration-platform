/**
 * src/utils/sanitizer.ts
 */

/**
 * Pre-AI Sanitization: Removes dangerous script tags, brackets, and non-standard characters.
 * Keeps letters, numbers, spaces, and safe punctuation necessary for date context.
 */
export const sanitizeRawInput = (rawText: string): string => {
  if (!rawText) return '';
  
  // Strip out HTML/Script brackets completely to prevent XSS or Prompt Injection
  let cleanText = rawText.replace(/[<>{}[\\]]/g, '');
  
  // Optional: Restrict to alphanumeric and basic punctuation (uncomment if you want to be extremely strict)
  // cleanText = cleanText.replace(/[^a-zA-Z0-9\s.,:;!?@-]/g, '');

  return cleanText.trim();
};

/**
 * Pre-Sheets Sanitization: Prevents CSV / Spreadsheet Formula Injection.
 * If a string starts with an executable operator, prepend an apostrophe.
 */
export const escapeSpreadsheetFormula = (value: string | undefined): string => {
  if (!value) return '';
  
  const trimmed = value.trim();
  // Check if the first character is a formula trigger
  if (/^[=+\-@]/.test(trimmed)) {
    return `'${trimmed}`; // Forces Google Sheets to read it as plain text
  }
  
  return trimmed;
};
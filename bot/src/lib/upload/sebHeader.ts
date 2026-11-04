// SEB exports one title line per account block:
//   "SĄSKAITOS  (LT10…) IŠRAŠAS (UŽ LAIKOTARPĮ: 2026-08-01-2026-08-31)"
// Mirrors the title pattern in ingestion's SEB parser. `bot` cannot import
// `ingestion` (module boundaries), and only the IBAN is needed here.
const TITLE_PATTERN = /^\s*"?SĄSKAITOS\s+\(([A-Z0-9]+)\)\s+IŠRAŠAS/;

// IBANs named by the title lines of an SEB export, in file order. Empty for
// any other file. Only the leading lines are read.
export function sebTitleIbans(csvText: string): string[] {
  const ibans: string[] = [];
  for (const line of csvText.split(/\r?\n/)) {
    const match = TITLE_PATTERN.exec(line);
    if (match) ibans.push(match[1] as string);
  }
  return [...new Set(ibans)];
}

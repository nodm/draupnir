// A Swedbank export is one table whose first line is the header
//   "Sąskaitos Nr.","","Data",...
// and whose rows start with the account IBAN. Mirrors the format in
// ingestion's Swedbank parser; `bot` cannot import `ingestion` (module
// boundaries), and only the IBANs are needed here.
const HEADER_START = /^\uFEFF?"Sąskaitos Nr\."/;
const ROW_IBAN = /^"([A-Z]{2}[0-9A-Z]{8,32})"/;

// Distinct IBANs named by a Swedbank export's rows, in file order. Empty for
// any other file.
export function swedbankIbans(csvText: string): string[] {
  const [header, ...rows] = csvText.split(/\r?\n/);
  if (!header || !HEADER_START.test(header)) return [];
  const ibans: string[] = [];
  for (const row of rows) {
    const match = ROW_IBAN.exec(row);
    if (match) ibans.push(match[1] as string);
  }
  return [...new Set(ibans)];
}

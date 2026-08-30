// A minimal RFC4180-style line parser: quoted fields, `""` as an escaped
// literal quote, and a caller-chosen delimiter (bank exports use `;` or `,`).
export function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function parseCsv(fileContents: string, delimiter: string): string[][] {
  return fileContents
    .split(/\r\n|\n/)
    .filter((line) => line.length > 0)
    .map((line) => parseCsvLine(line, delimiter));
}

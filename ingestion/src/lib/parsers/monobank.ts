import { parseCsv } from "../csv";
import {
	computeHashDedupKeys,
	type HashDedupKeyInput,
	normalizeDescription,
	resolvePostedDate,
	toMinorUnits,
} from "../dedupKey";
import type { NormalizedRow } from "./types";

const HEADER_MARKER = "Date and time";

function parseMonobankDate(value: string): Date {
	const datePart = value.trim().split(" ")[0] as string;
	const [day, month, year] = datePart.split(".") as [string, string, string];
	return new Date(`${year}-${month}-${day}T12:00:00Z`);
}

export function parseStatement(
	fileContents: string,
	uploadAccountIban: string,
): NormalizedRow[] {
	const lines = parseCsv(fileContents, ",");
	const partialRows: (HashDedupKeyInput & { description: string })[] = [];

	for (const fields of lines) {
		if (fields[0] === HEADER_MARKER) {
			continue;
		}

		const dateAndTime = fields[0] as string;
		const description = fields[1] as string;
		const operationAmount = fields[4] as string;
		const operationCurrency = fields[5] as string;

		partialRows.push({
			iban: uploadAccountIban,
			postedDate: resolvePostedDate(parseMonobankDate(dateAndTime)),
			amountMinorUnits: toMinorUnits(parseFloat(operationAmount), operationCurrency),
			currency: operationCurrency.trim(),
			normalizedDescription: normalizeDescription(description),
			description: normalizeDescription(description),
		});
	}

	const dedupKeys = computeHashDedupKeys(partialRows);

	return partialRows.map((row, index) => ({
		iban: row.iban,
		postedDate: row.postedDate,
		amountMinorUnits: row.amountMinorUnits,
		currency: row.currency,
		description: row.description,
		dedupKey: dedupKeys[index] as string,
	}));
}

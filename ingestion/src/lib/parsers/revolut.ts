import { parseCsv } from "../csv";
import {
	computeHashDedupKeys,
	type HashDedupKeyInput,
	normalizeDescription,
	resolvePostedDate,
	toMinorUnits,
} from "../dedupKey";
import type { NormalizedRow } from "./types";

const HEADER_MARKER = "Type";

function parseRevolutDate(value: string): Date {
	const datePart = value.trim().split(" ")[0] as string;
	return new Date(`${datePart}T12:00:00Z`);
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

		const completedDate = fields[3] as string;
		const description = fields[4] as string;
		const amount = fields[5] as string;
		const currency = fields[7] as string;

		partialRows.push({
			iban: uploadAccountIban,
			postedDate: resolvePostedDate(parseRevolutDate(completedDate)),
			amountMinorUnits: toMinorUnits(parseFloat(amount), currency),
			currency: currency.trim(),
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

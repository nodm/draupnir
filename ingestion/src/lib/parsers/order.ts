// The transaction order key (`occurred_at`, `source_seq`): when the balance
// changed, then the row's place in its source file's chronological order. The
// normalizers are the only code that knows each bank's export, so import,
// rebuild and the balance-chain check all take the order from here.
//
// Exports carry no timezone; timestamps are read as UTC. Only the order within
// one account matters, and an account has one bank.

// "YYYY-MM-DD HH:MM:SS" (Revolut) -> "YYYY-MM-DDTHH:MM:SSZ".
export function isoFromSpaceSeparated(value: string): string {
  const [date, time = '00:00:00'] = value.trim().split(' ');
  return `${date}T${time}Z`;
}

// "DD.MM.YYYY HH:MM:SS" (monobank) -> "YYYY-MM-DDTHH:MM:SSZ".
export function isoFromDotted(value: string): string {
  const [datePart, time = '00:00:00'] = value.trim().split(' ');
  const [day, month, year] = (datePart as string).split('.');
  return `${year}-${month}-${day}T${time}Z`;
}

// "YYYY-MM-DD" (SEB, date only) -> midnight UTC.
export function isoFromDateOnly(value: string): string {
  return `${value.trim()}T00:00:00Z`;
}

// 0-based rank of each timestamp in ascending order; equal timestamps keep
// their file order (Array.sort is stable).
export function rankByTime(occurredAt: readonly string[]): number[] {
  const ranks = new Array<number>(occurredAt.length);
  occurredAt
    .map((at, index) => ({ at, index }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .forEach(({ index }, rank) => {
      ranks[index] = rank;
    });
  return ranks;
}

// monobank exports newest first: the last row of the file happened first.
export function reverseFileOrder(count: number): number[] {
  return Array.from({ length: count }, (_, index) => count - 1 - index);
}

// SEB lists rows in file order and states no time of day.
export function fileOrder(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

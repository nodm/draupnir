export const BANKS = ['seb', 'revolut', 'monobank'] as const;

export type Bank = (typeof BANKS)[number];

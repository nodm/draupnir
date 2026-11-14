export const BANKS = ['seb', 'revolut', 'monobank', 'swedbank'] as const;

export type Bank = (typeof BANKS)[number];

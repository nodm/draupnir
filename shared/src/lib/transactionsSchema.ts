export const BANKS = ['seb', 'revolut', 'monobank', 'swedbank', 'privatbank'] as const;

export type Bank = (typeof BANKS)[number];

import { chunkBySize, OversizedParameterSetError } from './statementWrites';

describe('chunkBySize', () => {
  it('cuts chunks by bytes and by item count', () => {
    const items = [4, 4, 4, 4, 4];

    expect(chunkBySize(items, (n) => n, 10, 100)).toEqual([
      [4, 4],
      [4, 4],
      [4],
    ]);
    expect(chunkBySize(items, (n) => n, 100, 2)).toEqual([[4, 4], [4, 4], [4]]);
  });

  it('refuses a single item larger than the byte limit instead of sending it', () => {
    expect(() => chunkBySize([5, 50, 5], (n) => n, 10)).toThrow(
      OversizedParameterSetError,
    );
  });

  it('accepts an item exactly at the limit', () => {
    expect(chunkBySize([10], (n) => n, 10)).toEqual([[10]]);
  });
});

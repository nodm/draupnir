import { parseCsv, parseCsvLine } from './csv';

describe('parseCsvLine', () => {
  it('parses a quoted, delimited line', () => {
    expect(parseCsvLine('"a";"b";"c"', ';')).toEqual(['a', 'b', 'c']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvLine('"say ""hi"""', ';')).toEqual(['say "hi"']);
  });

  it('throws on an unterminated quoted field', () => {
    expect(() => parseCsvLine('"a";"b', ';')).toThrow(/unterminated/i);
  });
});

describe('parseCsv', () => {
  it('skips blank lines and parses the rest', () => {
    expect(parseCsv('"a";"b"\n\n"c";"d"', ';')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

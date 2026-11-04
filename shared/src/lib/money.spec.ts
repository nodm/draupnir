import { formatMinorUnits, minorUnitExponent, parseMinorUnits } from './money';

describe('minorUnitExponent', () => {
  it('knows the currencies that are not 2-decimal', () => {
    expect(minorUnitExponent('EUR')).toBe(2);
    expect(minorUnitExponent('jpy')).toBe(0);
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(minorUnitExponent('CLF')).toBe(4);
  });
});

describe('formatMinorUnits', () => {
  it('is the inverse of parsing for display', () => {
    expect(formatMinorUnits(-1050, 'EUR')).toBe('-10.50');
    expect(formatMinorUnits(100, 'JPY')).toBe('100');
  });
});

describe('parseMinorUnits', () => {
  it.each([
    ['1250', 'EUR', 125000],
    ['1250.5', 'EUR', 125050],
    ['-12,40', 'EUR', -1240],
    ['+3.07', 'EUR', 307],
    ['0', 'EUR', 0],
    [' 15.00 ', 'EUR', 1500],
    ['100', 'JPY', 100],
    ['1.234', 'KWD', 1234],
    ['10.500', 'EUR', 1050], // trailing zeros beyond the exponent are harmless
  ])('parses %s %s as %d', (text, currency, expected) => {
    expect(parseMinorUnits(text, currency)).toBe(expected);
  });

  it('does not lose precision to floating point', () => {
    expect(parseMinorUnits('0.29', 'EUR')).toBe(29); // 0.29 * 100 = 28.999… in floats
    expect(parseMinorUnits('1.15', 'EUR')).toBe(115);
  });

  it.each([
    ['abc', 'EUR'],
    ['', 'EUR'],
    ['1.2.3', 'EUR'],
    ['1 000', 'EUR'],
    ['--5', 'EUR'],
    ['5.', 'EUR'],
    ['.5', 'EUR'],
    ['10.555', 'EUR'], // more decimals than the currency has, and not zeros
    ['1.5', 'JPY'],
    ['9'.repeat(30), 'EUR'], // beyond a safe integer
  ])('rejects %s %s', (text, currency) => {
    expect(parseMinorUnits(text, currency)).toBeNull();
  });
});

// How .NET (Core 3.0 and later) writes a `float` with `ToString()` under the
// en-US culture, which is what AssetStudio's OBJ export does (`AppendFormat`
// with `{0}` on the culture of its export thread) and what its ShaderConverter
// writes for property defaults and render state: the shortest decimal that
// reads back as the same float32, in fixed or scientific notation.
//
// Checked against .NET 8 on 2.2 million floats (every exponent at and around
// a power of two, random bit patterns, decimal fractions and large integers)
// when this was written, and again on 2.7 million with the fast path of
// `quick` (#252); tests/float.test.ts keeps a sample of them.

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/**
 * Write a float32 as .NET's `float.ToString()` does under en-US: the shortest
 * digits that read back as the same float32, in fixed notation unless the
 * value is 10^9 or more or below 10^-4. Scientific notation has one digit
 * before the point and an `E+XX` / `E-XX` exponent of two digits at least.
 * Negative zero is `-0`; NaN is `NaN`, the infinities `∞` and `-∞`.
 *
 * @param value a float32 (`Math.fround(value) === value`), or NaN
 * @returns the text .NET writes for it
 */
export function formatSingle(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "∞";
  if (value === -Infinity) return "-∞";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const sign = value < 0 ? "-" : "";
  const { digits, scale } = shortest(Math.abs(value));
  // .NET's FormatGeneral with max(digit count, 9) digits, and a float32 never
  // needs more than 9: scientific from a 10th digit before the point on, or
  // from the 4th zero after it.
  const scientific = scale > 9 || scale < -3;
  const point = scientific ? 1 : scale;
  let text: string;
  if (point <= 0) text = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) text = digits + "0".repeat(point - digits.length);
  else text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (scientific) {
    const exponent = scale - 1;
    text += `E${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return sign + text;
}

/** A positive float32 as `mantissa × 2^exponent`, and the decimals that read back as it. */
interface Interval {
  value: number;
  mantissa: number;
  exponent: number;
  /** The ends as doubles, exact: half an ulp each way, a quarter below a power of two. */
  low: number;
  high: number;
  /** Whether `low` sits a quarter of an ulp below rather than a half. */
  narrow: boolean;
  /** 0 when the ends read back as this float too (even mantissa, ties to even), else 1. */
  ends: number;
}

/**
 * The shortest decimal that reads back as the float32, and of those the
 * closest to it, a tie going to the even last digit.
 *
 * @param value a positive, finite float32
 * @returns the significant digits, without trailing zeros, and the scale:
 *   `value` reads back from `0.<digits> × 10^scale`
 */
function shortest(value: number): { digits: string; scale: number } {
  F32[0] = value;
  const bits = U32[0]!;
  const biased = bits >>> 23;
  const fraction = bits & 0x7fffff;
  const mantissa = biased === 0 ? fraction : fraction | 0x800000;
  const exponent = (biased === 0 ? 1 : biased) - 150;
  const ulp = 2 ** exponent;
  // The float below a power of two is half as far as the one above, except
  // below the smallest normal.
  const narrow = fraction === 0 && biased > 1;
  const range: Interval = {
    value,
    mantissa,
    exponent,
    low: value - (narrow ? ulp / 4 : ulp / 2),
    high: value + ulp / 2,
    narrow,
    ends: mantissa % 2 === 0 ? 0 : 1,
  };
  const fast = quick(range);
  if (fast) return fast;
  // Some p-digit decimal reads back as the float for every p from the
  // shortest on (append zeros), and 9 digits always do: search for the shortest.
  let lo = 1;
  let hi = 9;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pick(range, mid)) hi = mid;
    else lo = mid + 1;
  }
  const { digits: whole, power } = pick(range, lo)!;
  const digits = String(whole);
  return { digits: digits.replace(/0+$/, ""), scale: digits.length + power };
}

/** 10^0 to 10^22, the powers of ten a double holds exactly. */
const POW10 = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17,
  1e18, 1e19, 1e20, 1e21, 1e22,
];

/**
 * {@link shortest} for the common float, with doubles only: the same search
 * over the precision, each step trying only the nearest decimal, worked out
 * from one 9-digit rounding. It gives up on anything it cannot settle without
 * exact arithmetic.
 *
 * @returns the same as `shortest`, or `undefined` when the exact search has
 *   to decide: a decimal on an end of the interval, or a float on or very
 *   near the midpoint of two decimals that might both read back
 */
function quick(range: Interval): { digits: string; scale: number } | undefined {
  const { value, low, high } = range;
  // The nearest 9-digit decimal, `nine × 10^(exp - 8)`, a tie rounded up.
  const text = value.toExponential(8);
  let nine = text.charCodeAt(0) - 48;
  for (let i = 2; i < 10; i++) nine = nine * 10 + text.charCodeAt(i) - 48;
  const exp = Number(text.slice(11));
  let lo = 1;
  let hi = 9;
  // The decimal of `hi` digits once one was found inside, `digits × 10^power`.
  let found = 0;
  let power = 0;
  let decimal = 0;
  // Most floats of a mesh need 7 to 9 digits: start there, not in the middle.
  let precision = 7;
  for (;;) {
    // The nearest decimal of `precision` digits, from the 9-digit one. When
    // that one sits on a midpoint of these, the float may lie on either side
    // of it (or on it): its double says which, unless they are equal.
    const drop = 9 - precision;
    const at = exp - 8 + drop;
    let digits = nine;
    let tie = false;
    if (drop > 0) {
      const div = POW10[drop]!;
      digits = Math.floor(nine / div);
      const rest = (nine - digits * div) * 2;
      if (rest === div) {
        const middle = toDouble(nine, exp - 8);
        if (middle === value) tie = true;
        else if (middle < value) digits++;
      } else if (rest > div) digits++;
    }
    // The decimal as a double, correctly rounded, and rounding keeps order:
    // the double is strictly inside (low, high) only if the decimal is (the
    // ends are doubles).
    let read = tie ? 0 : toDouble(digits, at);
    if (tie) {
      // Both neighbours are half a unit away, give or take a few double ulps:
      // neither reads back if that is more than the whole interval.
      if (tenTo(at) / 2 <= high - low) return undefined;
    } else if (range.narrow && read < low) {
      // Below the low end of a narrow interval: the next decimal up, on the
      // wide side, may still be inside, and is the one to take then.
      read = toDouble(++digits, at);
      if (read === high) return undefined;
    } else if (read === low || read === high) {
      // On an end: it reads back only with an even mantissa.
      return undefined;
    }
    if (!tie && read > low && read < high) {
      found = digits;
      power = at;
      decimal = read;
      hi = precision;
    } else {
      // No decimal of this many digits is inside: the nearest is outside,
      // and its neighbours are no closer to the float than the far end.
      if (precision === 9) return undefined;
      lo = precision + 1;
    }
    if (lo >= hi && found !== 0) break;
    precision = lo >= hi ? hi : (lo + hi) >> 1;
  }
  // At 9 digits an odd last digit may be the upper of two decimals as close as
  // each other (rounded up above; .NET takes the even one). That needs the
  // float exactly halfway: twice its distance to the decimal is one unit.
  if (hi === 9 && found % 2 === 1) {
    if (Math.abs(2 * Math.abs(decimal - value) - tenTo(power)) <= value * 2 ** -40) {
      return undefined;
    }
  }
  const digits = String(found);
  return { digits: digits.replace(/0+$/, ""), scale: digits.length + power };
}

/** 10^power as a double, to an ulp or so. */
function tenTo(power: number): number {
  return power >= 0 ? (POW10[power] ?? 10 ** power) : 1 / (POW10[-power] ?? 10 ** -power);
}

/** `digits × 10^power` as a double, correctly rounded. */
function toDouble(digits: number, power: number): number {
  // One exact operand each and one IEEE operation: correctly rounded.
  if (power >= 0 && power <= 22) return digits * POW10[power]!;
  if (power < 0 && power >= -22) return digits / POW10[-power]!;
  return Number(`${digits}e${power}`);
}

/**
 * The `precision`-digit decimal `digits × 10^power` that reads back as the
 * float and is closest to it, if there is one.
 */
function pick(range: Interval, precision: number): { digits: number; power: number } | undefined {
  // `d.ddd` and its exponent: the nearest decimal of that many digits, a tie rounded up.
  const [lead, exp] = range.value.toExponential(precision - 1).split("e") as [string, string];
  const nearest = Number(lead.replace(".", ""));
  const power = Number(exp) - (precision - 1);
  const reads = (digits: number): boolean => {
    if (digits <= 0) return false;
    const decimal = Number(`${digits}e${power}`);
    return (
      compare(decimal, digits, power, range, "low") >= range.ends &&
      compare(decimal, digits, power, range, "high") <= -range.ends
    );
  };
  if (reads(nearest)) {
    // Halfway between two that both read back: the even one, as .NET rounds.
    if (nearest % 2 === 1 && reads(nearest - 1) && midpoint(nearest - 1, power, range) === 0) {
      return { digits: nearest - 1, power };
    }
    return { digits: nearest, power };
  }
  // Just outside, on the narrow side: the neighbour on the wide side may be in.
  for (const digits of [nearest - 1, nearest + 1]) if (reads(digits)) return { digits, power };
  return undefined;
}

/**
 * The sign of `digits × 10^power` (`decimal` as a double) minus an end of the
 * interval. The doubles decide unless they are within a few ulps of each
 * other; then it is worked out exactly.
 */
function compare(
  decimal: number,
  digits: number,
  power: number,
  range: Interval,
  end: "low" | "high",
): number {
  const at = range[end];
  if (Math.abs(decimal - at) > at * 2 ** -50) return decimal < at ? -1 : 1;
  const m = BigInt(range.mantissa);
  // low = (4m - 1 or 2) × 2^(e - 2), high = (2m + 1) × 2^(e - 1).
  return end === "low"
    ? exactSign(BigInt(digits), power, m * 4n - (range.narrow ? 1n : 2n), range.exponent - 2)
    : exactSign(BigInt(digits), power, m * 2n + 1n, range.exponent - 1);
}

/** The sign of `(digits + 1/2) × 10^power` minus the float, exactly. */
function midpoint(digits: number, power: number, range: Interval): number {
  // Doubled: (2 × digits + 1) × 10^power against mantissa × 2^(exponent + 1).
  return exactSign(BigInt(2 * digits + 1), power, BigInt(range.mantissa), range.exponent + 1);
}

/** The sign of `d × 10^p − n × 2^e`, exactly. */
function exactSign(d: bigint, p: number, n: bigint, e: number): number {
  let left = d;
  let right = n;
  if (p >= 0) left *= 10n ** BigInt(p);
  else right *= 10n ** BigInt(-p);
  if (e >= 0) right <<= BigInt(e);
  else left <<= BigInt(-e);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Write a float32 as .NET's `float.ToString(CultureInfo.InvariantCulture)`
 * does: as {@link formatSingle}, but the infinities are `Infinity` and
 * `-Infinity`.
 *
 * @param value a float32, or NaN
 * @returns the text .NET writes for it
 */
export function formatSingleInvariant(value: number): string {
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return formatSingle(value);
}

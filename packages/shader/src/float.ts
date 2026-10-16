// Copied from unity-asset-reader-mesh's src/float.ts (#239), which a feature package cannot
// import (R14).
//
// How .NET (Core 3.0 and later) writes a `float` with `ToString()` under the
// en-US culture, which is what AssetStudio's OBJ export does (`AppendFormat`
// with `{0}` on the culture of its export thread): the shortest decimal that
// reads back as the same float32, in fixed or scientific notation.
//
// Checked against .NET 8 on 2.2 million floats (every exponent at and around
// a power of two, random bit patterns, decimal fractions and large integers)
// when this was written; tests/float.test.ts keeps a sample of them.

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

// formatSingle against .NET 8's `float.ToString()` under en-US, the call
// AssetStudio's OBJ export makes. The table is .NET's own output for these bit
// patterns (written by a .NET 8 program outside the repo, as the export
// goldens are, R2/R12): a sample of the 2.2 million floats src/float.ts was
// checked on, picked for the edges of the notation and of the round trip.

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatSingle } from "../src/float.js";

/** float32 bit pattern (hex) -> .NET 8 `ToString()`, en-US. */
const DOTNET: [string, string][] = [
  ["00000000", "0"],
  ["80000000", "-0"], // .NET Core 3.0+ keeps the sign of zero
  ["3f800000", "1"],
  ["bf800000", "-1"],
  ["c2700000", "-60"], // not "-6E+01": at least 9 digits before scientific
  ["3f000000", "0.5"],
  ["3e800000", "0.25"],
  ["3dcccccd", "0.1"],
  ["3f8ccccd", "1.1"],
  ["3eaaaaab", "0.33333334"],
  ["c479ffff", "-999.99994"],
  ["42b951ec", "92.66"],
  ["be556928", "-0.20840895"],
  ["3a83126f", "0.001"],
  ["38d1b717", "0.0001"], // the smallest exponent still in fixed notation
  ["39000000", "0.00012207031"],
  ["3727c5ac", "1E-05"],
  ["2f800000", "2.3283064E-10"],
  ["4b7fffff", "16777215"],
  ["4b800000", "16777216"],
  ["4b800002", "16777220"], // 7 digits, fixed up to 9 places
  ["4b82001e", "17039420"],
  ["4b844b3a", "17340020"],
  ["498723c2", "1107064.2"],
  ["4c400000", "50331650"], // an end of the interval, even mantissa: it reads back
  ["cc9490f6", "-77891500"], // the lower end, even mantissa
  ["4cbebc20", "100000000"],
  ["4e6e6b27", "999999940"],
  ["4e6e6b28", "1E+09"],
  ["4f000000", "2.1474836E+09"],
  ["51d2dcb6", "1.1320576E+11"],
  ["5c07ae88", "1.5276408E+17"],
  ["7f7fffff", "3.4028235E+38"],
  ["00000001", "1E-45"], // the smallest subnormal
  ["007fffff", "1.1754942E-38"], // the largest subnormal
  ["00800000", "1.1754944E-38"], // the smallest normal
  ["7f800000", "∞"],
  ["ff800000", "-∞"],
  ["7fc00000", "NaN"],
];

test("formatSingle writes what .NET 8 writes for a float under en-US", () => {
  const view = new DataView(new ArrayBuffer(4));
  for (const [bits, expected] of DOTNET) {
    view.setUint32(0, parseInt(bits, 16));
    assert.equal(formatSingle(view.getFloat32(0)), expected, bits);
  }
});

test("formatSingle round-trips: its text reads back as the same float32", () => {
  const view = new DataView(new ArrayBuffer(4));
  let seed = 1;
  for (let i = 0; i < 20000; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    view.setUint32(0, seed ^ (seed << 13));
    const value = view.getFloat32(0);
    if (!Number.isFinite(value)) continue;
    assert.ok(Object.is(Math.fround(Number(formatSingle(value))), value), String(value));
  }
});

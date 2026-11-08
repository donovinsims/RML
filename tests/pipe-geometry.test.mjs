import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { computePipeGeometry } from "../pipe-geometry.js";

const widths = [390, 500, 640, 768, 900, 1024, 1100, 1180, 1440];
const fixture = JSON.parse(await readFile(join(import.meta.dirname, "pipe-geometry.json"), "utf8"));
const fixtures = new Map(fixture.fixtures.map((entry) => [entry.width, entry]));

test("pipe geometry reproduces the source path and tap coordinates at every golden width", () => {
  for (const width of widths) {
    const expected = fixtures.get(width);
    const actual = computePipeGeometry(expected);
    assert.ok(actual, `${width}: model was not computed`);
    assert.equal(actual.main, expected.expected.main, `${width}: main path`);
    assert.deepEqual(actual.taps.map((tap) => tap.d), expected.expected.taps, `${width}: taps`);
    assert.equal(actual.railX, expected.valves[0].x, `${width}: rail`);
    assert.equal(actual.row, width >= 640, `${width}: row mode`);
    assert.equal(actual.mobile, width < 768, `${width}: mobile mode`);
    assert.equal(actual.manifoldY, Math.round(expected.rack.top - (width < 768 ? 36 : 44)), `${width}: manifold offset`);
    assert.deepEqual(actual.valves, expected.valves, `${width}: valve positions`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { matchSections } from "../lib/match.mjs";

const style = { display: "block", position: "relative", width: "1200px", height: "800px" };
const section = (overrides = {}) => ({
  tag: "main",
  text: "",
  rect: { x: 0, y: 100, width: 1200, height: 800 },
  style,
  ...overrides,
});

test("empty structural sections match only when tag, geometry, and styles are exact", () => {
  const exact = matchSections([section()], [section()])[0];
  assert.equal(exact.status, "measured");
  assert.equal(exact.matchedBy, "structure");
  assert.equal(exact.confidence, "structural");

  const shifted = matchSections([section()], [section({ rect: { x: 12, y: 100, width: 1200, height: 800 } })])[0];
  assert.equal(shifted.status, "review");

  const styled = matchSections([section()], [section({ style: { ...style, height: "801px" } })])[0];
  assert.equal(styled.status, "review");
});

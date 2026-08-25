import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toLikeContainsPattern } from "./sql-like.js";

describe("toLikeContainsPattern", () => {
  it("wraps an ordinary search in wildcards", () => {
    assert.equal(toLikeContainsPattern("target"), "%target%");
  });

  it("escapes a percent so it matches literally rather than matching everything", () => {
    assert.equal(toLikeContainsPattern("100%"), "%100\\%%");
  });

  it("escapes an underscore so it does not match an arbitrary character", () => {
    assert.equal(toLikeContainsPattern("snake_case"), "%snake\\_case%");
  });

  it("escapes the escape character itself", () => {
    assert.equal(toLikeContainsPattern("a\\b"), "%a\\\\b%");
  });

  it("leaves regex metacharacters alone -- they are not LIKE metacharacters", () => {
    assert.equal(toLikeContainsPattern("a.*b"), "%a.*b%");
  });
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { registerPoolErrorHandler } from "./db.js";

class FakePool extends EventEmitter {
  override on(event: "error", listener: (error: Error) => void): this {
    return super.on(event, listener);
  }
}

test("pool errors are logged without throwing when a handler is registered", () => {
  const pool = new FakePool();
  const warnings: Array<{ err: Error; message: string }> = [];

  registerPoolErrorHandler(
    {
      warn(bindings, message) {
        warnings.push({ err: bindings.err, message });
      },
    },
    pool,
  );

  const error = new Error("socket closed");
  assert.doesNotThrow(() => {
    pool.emit("error", error);
  });

  assert.deepEqual(warnings, [{ err: error, message: "Postgres pool client error" }]);
});

test("pool error handler registration is idempotent per pool", () => {
  const pool = new FakePool();
  const warnings: Array<{ err: Error; message: string }> = [];

  const logger = {
    warn(bindings: { err: Error }, message: string) {
      warnings.push({ err: bindings.err, message });
    },
  };

  registerPoolErrorHandler(logger, pool);
  registerPoolErrorHandler(logger, pool);

  assert.equal(pool.listenerCount("error"), 1);

  const error = new Error("read EADDRNOTAVAIL");
  pool.emit("error", error);

  assert.deepEqual(warnings, [{ err: error, message: "Postgres pool client error" }]);
});

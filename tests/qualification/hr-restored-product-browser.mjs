import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const environmentKeys = [
  "DATABASE_MIGRATION_URL",
  "DATABASE_NOTIFICATION_PROJECTOR_URL",
  "DATABASE_URL",
  "ESBLA_BROWSER_ARTIFACT_DIR",
  "ESBLA_T10_BROWSER_MATRIX",
  "ESBLA_T10_RESTORED_RECEIPT",
  "ESBLA_T10_RESTORED_REPLAY",
];

export async function proveRestoredProductBrowser({
  applicationUrl,
  migrationUrl,
  notificationProjectorUrl,
  receiptPath,
}) {
  for (const value of [applicationUrl, migrationUrl, notificationProjectorUrl, receiptPath]) {
    assert.equal(typeof value, "string", "Restored Product browser input is missing");
    assert.ok(value.length > 0, "Restored Product browser input is empty");
  }
  const originalEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, {
      DATABASE_MIGRATION_URL: migrationUrl,
      DATABASE_NOTIFICATION_PROJECTOR_URL: notificationProjectorUrl,
      DATABASE_URL: applicationUrl,
      ESBLA_T10_RESTORED_RECEIPT: receiptPath,
      ESBLA_T10_RESTORED_REPLAY: "1",
    });
    if (originalEnvironment.ESBLA_BROWSER_ARTIFACT_DIR) {
      process.env.ESBLA_BROWSER_ARTIFACT_DIR = join(
        originalEnvironment.ESBLA_BROWSER_ARTIFACT_DIR,
        "restored",
      );
    }
    delete process.env.ESBLA_T10_BROWSER_MATRIX;
    await import(`../browser/hr-leave-stack.mjs?restored=${randomUUID()}`);
    assert.notEqual(process.exitCode, 1, "Restored Product browser stack failed");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.deepEqual(Object.keys(receipt).sort(), [
      "densityAfter",
      "densityBefore",
      "notificationTitle",
      "status",
    ]);
    assert.ok(["comfortable", "compact"].includes(receipt.densityBefore));
    assert.ok(["comfortable", "compact"].includes(receipt.densityAfter));
    assert.notEqual(receipt.densityAfter, receipt.densityBefore);
    assert.equal(receipt.notificationTitle, "Your workforce profile is available");
    assert.equal(receipt.status, "RESTORED_PRODUCT_BROWSER_RESTART_GREEN");
    return receipt;
  } finally {
    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

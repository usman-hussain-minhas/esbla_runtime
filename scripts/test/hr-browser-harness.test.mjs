// biome-ignore assist/source/organizeImports: Import evaluation order is intentionally proof-sensitive.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isPromise, isProxy } from "node:util/types";
import ts from "typescript";
import {
  assertLoopbackBrowserEndpoint,
  assertSafeTrackedPaths,
  assertSourceQualification,
  createArtifactDirectory,
  createProcessPlan,
  createStreamingRedactor,
  isExactActorRequest,
  lifecycleStages,
  runCleanupSteps,
  sanitizeEvidence,
  scrubAndAssertArtifactSecrets,
  stopChild,
  teardownStages,
  withTemporaryEnvironment,
  withTimeout,
} from "./hr-browser-harness.mjs";
import {
  captureOwnedDirectory,
  classifyProcessGroupProbeError,
  classifyRetainedLeader,
  cleanupExactOwnedDirectories,
  commandUsesExactExecutable,
  isExactHarnessExitReceipt,
  isSecureControlFileMetadata,
  parseBrowserRegistration,
  renderBrowserLauncherShimForTest,
} from "./with-postgres.mjs";
import { chromium as browserToolingChromium } from "./browser-tooling/node_modules/@playwright/test/index.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const browserHarness = join(repositoryRoot, "scripts/test/hr-browser-harness.mjs");
const withPostgres = join(repositoryRoot, "scripts/test/with-postgres.mjs");
const secret = "browser-harness-secret-that-must-never-escape";
const wrapperTemporaryRoot = await mkdtemp(join("/tmp", "ebw-"));
const activeWrapperControllers = new Set();
const completedWrapperControllers = [];
const openWrapperOwnershipDescriptors = new Set();
const recordedWrapperIdentities = [];
const redExpectedControllerFailures = new WeakSet();
const suiteFinalizerFinishTimeoutMs = 75_000;
const maliciousRegistrationVariantContract = Object.freeze([
  "malformed",
  "multiply-linked",
  "wrong-nonce",
  "wrong-nonce-resistant-harness",
  "wrong-parent",
  "wrong-start",
  "wrong-record-uid",
  "wrong-pgid",
  "unrelated-process",
  "leader-gone",
  "changed-parent",
  "executable-substring",
  "wrong-mode",
  "symlink",
]);

after(async () => {
  const controllerResults = await Promise.allSettled(
    [...activeWrapperControllers].map(async (controller) => {
      const finishResults = await Promise.allSettled([
        controller.finish(suiteFinalizerFinishTimeoutMs),
      ]);
      const verificationResults = await Promise.allSettled([
        (async () =>
          assert.equal(controller.phase, "finalized", "suite controller did not finalize"))(),
        (async () => assert.equal(controller.settled, true, "suite controller did not settle"))(),
        (async () =>
          assert.equal(
            activeWrapperControllers.has(controller),
            false,
            "suite controller remained active",
          ))(),
      ]);
      return { finishResults, verificationResults };
    }),
  );
  const controllerFinishResults = controllerResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value.finishResults : [],
  );
  const controllerVerificationResults = controllerResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value.verificationResults : [],
  );
  const descriptorResults = await Promise.allSettled(
    [...openWrapperOwnershipDescriptors].map(async (descriptor) => {
      closeSync(descriptor);
      openWrapperOwnershipDescriptors.delete(descriptor);
    }),
  );
  const processResults = await Promise.allSettled(
    recordedWrapperIdentities.map(async (identity) =>
      assert.equal(
        sameProcessIdentity(identity, readProcessIdentity(identity.pid, 1_000)),
        false,
        "wrapper identity remained live",
      ),
    ),
  );
  const completedResults = await Promise.allSettled(
    completedWrapperControllers.map(async (controller) => {
      assert.equal(controller.rescueUsed, false);
      assert.equal(controller.hardKillUsed, false);
      assert.deepEqual(controller.controllerErrors, []);
    }),
  );
  const ownedRootResults = await Promise.allSettled([
    (async () => assert.deepEqual(await postgresTemporaryDirectories(), new Set()))(),
    (async () => assert.deepEqual(await browserTemporaryDirectories(), new Set()))(),
  ]);
  const preSuiteCleanupResults = [
    ...controllerResults,
    ...controllerFinishResults,
    ...controllerVerificationResults,
    ...descriptorResults,
    ...processResults,
    ...completedResults,
    ...ownedRootResults,
  ];
  const suiteRootResults = await Promise.allSettled(
    preSuiteCleanupResults.every((result) => result.status === "fulfilled")
      ? [
          (async () => {
            assert.deepEqual(await readdir(wrapperTemporaryRoot), []);
            await rmdir(wrapperTemporaryRoot);
          })(),
        ]
      : [],
  );
  const allResults = [
    ...controllerResults,
    ...controllerFinishResults,
    ...controllerVerificationResults,
    ...descriptorResults,
    ...processResults,
    ...completedResults,
    ...ownedRootResults,
    ...suiteRootResults,
  ];
  const failures = allResults.filter((result) => result.status === "rejected");
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "suite finalization failed",
    );
});

function authoritativeWithPostgresSourceSha256() {
  return Object.freeze([
    "dfbc54ada22a9422e3ab0263096162257ed702edd359ae78baefd1e7d3bb74d3",
    "0fead193912e35874cd9590c6e483307b7b3344a1f931dc9810e33ce34dc90fd",
  ]);
}

function sourceSha256(sourceText) {
  return ts.sys.createHash(sourceText);
}

async function ordinaryChildOutcome(child, timeoutMs = 45_000) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return await new Promise((resolveOutcome, rejectOutcome) => {
    let settled = false;
    let timer;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    timer = setTimeout(
      () =>
        settle(() =>
          rejectOutcome(new Error(`Child ${child.pid ?? "unknown"} exceeded ${timeoutMs}ms`)),
        ),
      timeoutMs,
    );
    child.once("error", (error) => settle(() => rejectOutcome(error)));
    child.once("exit", (code, signal) =>
      settle(() => resolveOutcome({ code, signal, stderr, stdout })),
    );
  });
}

async function childOutcome(child, timeoutMs = 45_000) {
  if (child?.ownedWrapperController) return await child.finish(timeoutMs);
  return await ordinaryChildOutcome(child, timeoutMs);
}

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error(`${path} was not created within ${timeoutMs}ms`);
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`PID ${pid} remained alive after ${timeoutMs}ms`);
}

async function waitForExactProcessExit(identity, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readProcessIdentity(identity.pid);
    if (!current || !sameProcessIdentity(identity, current)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("owned cooperative fixture retained its exact identity");
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function createCooperativeCloseState() {
  let resolveClose;
  const outcome = new Promise((resolveOutcome) => {
    resolveClose = resolveOutcome;
  });
  return { observed: false, outcome, resolveClose };
}

function createCooperativeFixtureSlot(label) {
  return {
    acquisition: "not-attempted",
    child: undefined,
    closeBound: false,
    closeState: createCooperativeCloseState(),
    handlerReadyPath: undefined,
    identity: undefined,
    identityRetained: false,
    joined: false,
    label,
    rawClosed: false,
    receipt: undefined,
    sessionObservation: undefined,
    setupError: undefined,
    signalAbsent: false,
    signalMarkerPath: undefined,
    stopPath: undefined,
    stopPublished: false,
  };
}

function publishCooperativeClose(subject, outcome) {
  const state = subject.closeState;
  if (state.observed) return;
  state.observed = true;
  state.resolveClose(outcome);
}

function refreshCooperativeClose(subject) {
  if (!subject.child || subject.closeState.observed) return;
  if (subject.child.exitCode !== null || subject.child.signalCode !== null)
    publishCooperativeClose(subject, {
      code: subject.child.exitCode,
      signal: subject.child.signalCode,
    });
}

function observeChildClose(subject) {
  refreshCooperativeClose(subject);
  if (subject.closeState.observed || subject.closeBound) return;
  try {
    subject.child.once("error", (error) => {
      subject.setupError ??= error;
    });
    subject.child.once("close", (code, signal) =>
      publishCooperativeClose(subject, { code, signal }),
    );
    subject.closeBound = true;
  } catch (error) {
    subject.setupError ??= error;
  }
}

async function settleCooperativeClose(subject, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    refreshCooperativeClose(subject);
    if (subject.closeState.observed) return await subject.closeState.outcome;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("cooperative fixture close exceeded its bound");
    const observed = await Promise.race([
      subject.closeState.outcome.then((value) => ({ kind: "closed", value })),
      new Promise((resolveWait) =>
        setTimeout(() => resolveWait({ kind: "waiting" }), Math.min(25, remaining)),
      ),
    ]);
    if (observed.kind === "closed") return observed.value;
  }
}

function observeChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveOutcome, rejectOutcome) => {
    child.once("error", rejectOutcome);
    child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  });
}

async function writePrivateStop(path) {
  try {
    await writeFile(path, "stop\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function spawnCooperativeFixture(
  slot,
  caseRoot,
  label,
  signalEvidenceRoot = caseRoot,
  fixturePrivateStopRoot = caseRoot,
  childArguments = [],
  onFixtureAcquired,
) {
  assert.equal(slot.acquisition, "not-attempted", `${label} fixture slot was reused`);
  slot.acquisition = "attempting";
  let acquisitionHookError;
  try {
    const handlerReadyPath = join(caseRoot, `${label}.handler-ready.json`);
    const signalMarkerPath = join(signalEvidenceRoot, `${label}.signal-marker.txt`);
    const stopPath = join(fixturePrivateStopRoot, `${label}.stop`);
    const source = [
      'const {existsSync,linkSync,unlinkSync,writeFileSync}=require("node:fs")',
      `const handlerReadyPath=${JSON.stringify(handlerReadyPath)}`,
      `const signalMarkerPath=${JSON.stringify(signalMarkerPath)}`,
      `const stopPath=${JSON.stringify(stopPath)}`,
      'const publish=(path,value)=>{const temporary=path+".tmp."+process.pid;writeFileSync(temporary,JSON.stringify(value),{flag:"wx",mode:0o600});linkSync(temporary,path);unlinkSync(temporary)}',
      'for(const signal of ["SIGHUP","SIGINT","SIGTERM"])process.on(signal,()=>{try{writeFileSync(signalMarkerPath,signal+"\\n",{flag:"a",mode:0o600})}catch{}})',
      "publish(handlerReadyPath,{pid:process.pid,ppid:process.ppid})",
      "setInterval(()=>{if(existsSync(stopPath))process.exit(0)},25)",
    ].join(";");
    slot.handlerReadyPath = handlerReadyPath;
    slot.signalMarkerPath = signalMarkerPath;
    slot.stopPath = stopPath;
    slot.child = spawn(process.execPath, ["-e", source, ...childArguments], {
      detached: true,
      stdio: "ignore",
    });
    slot.acquisition = "acquired";
    slot.receipt = Object.freeze({
      child: slot.child,
      closeState: slot.closeState,
      handlerReadyPath,
      label,
      signalMarkerPath,
      stopPath,
    });
    try {
      onFixtureAcquired?.(slot.receipt, slot);
    } catch (error) {
      acquisitionHookError = error;
    }
    observeChildClose(slot);
    if (acquisitionHookError) throw acquisitionHookError;
    return slot;
  } catch (error) {
    if (!acquisitionHookError) slot.setupError = error;
    if (!slot.child) slot.acquisition = "no-subject";
    throw error;
  }
}

async function retainCooperativeFixtureReceipt(receipt) {
  const ready = await waitForFile(receipt.handlerReadyPath, 10_000);
  assert.equal(ready.pid, receipt.child.pid, "cooperative fixture PID changed before retention");
  const identity = captureStableProcessIdentity(ready.pid);
  assert.equal(identity.ppid, process.pid, "cooperative fixture is not a direct child");
  assert.equal(identity.pid, identity.pgid, "cooperative fixture does not lead its group");
  const sessionObservation = readSemanticSessionObservation(identity);
  assert.equal(
    isSemanticSessionLeader(sessionObservation),
    true,
    "cooperative fixture is not a semantic session leader",
  );
  return Object.freeze({
    ...receipt,
    identity: Object.freeze({ ...identity }),
    sessionObservation: Object.freeze({
      ...sessionObservation,
      identity: Object.freeze({ ...sessionObservation.identity }),
    }),
  });
}

async function retainCooperativeFixture(slot) {
  assert.equal(slot.acquisition, "acquired", `${slot.label} fixture has no acquired subject`);
  observeChildClose(slot);
  if (slot.identityRetained) return slot;
  const owner = await retainCooperativeFixtureReceipt(slot.receipt);
  slot.identity = owner.identity;
  slot.sessionObservation = owner.sessionObservation;
  slot.identityRetained = true;
  return slot;
}

async function publishCooperativeFixtureStop(slot) {
  if (["not-attempted", "no-subject"].includes(slot.acquisition)) return { kind: "absent" };
  assert.equal(slot.acquisition, "acquired", `${slot.label} fixture acquisition is ambiguous`);
  assert.ok(slot.stopPath, `${slot.label} fixture stop path missing`);
  await writePrivateStop(slot.stopPath);
  slot.stopPublished = true;
  return { kind: "published" };
}

async function joinCooperativeFixture(slot) {
  if (["not-attempted", "no-subject"].includes(slot.acquisition)) return { kind: "absent" };
  assert.equal(slot.acquisition, "acquired", `${slot.label} fixture acquisition is ambiguous`);
  observeChildClose(slot);
  assert.equal(slot.stopPublished, true, `${slot.label} fixture private stop was not published`);
  const outcome = await settleCooperativeClose(slot, 10_000);
  assert.deepEqual(outcome, { code: 0, signal: null });
  slot.rawClosed = true;
  assert.equal(await pathExists(slot.signalMarkerPath), false, "cooperative fixture was signaled");
  slot.signalAbsent = true;
  if (slot.identityRetained) {
    await waitForExactProcessExit(slot.identity, 10_000);
    assert.equal(
      sameProcessIdentity(slot.identity, readProcessIdentity(slot.identity.pid, 1_000)),
      false,
      "cooperative fixture retained its exact identity",
    );
  }
  slot.joined = true;
  return {
    identity: slot.identity,
    kind: slot.identityRetained ? "joined" : "closed-unretained",
    outcome,
  };
}

function independentCooperativeReceipt(fixture, expectedLabel) {
  assert.equal(typeof expectedLabel, "string", "independent fixture label was not sealed");
  assert.notEqual(expectedLabel.length, 0, "independent fixture label was empty");
  const suppliedLabel = Object.getOwnPropertyDescriptor(fixture, "label");
  if (suppliedLabel) {
    assert.equal(
      Object.hasOwn(suppliedLabel, "value") &&
        !Object.hasOwn(suppliedLabel, "get") &&
        !Object.hasOwn(suppliedLabel, "set"),
      true,
      "independent fixture label was not exact data",
    );
    assert.equal(
      suppliedLabel.value,
      expectedLabel,
      "independent fixture label did not match its sealed slot",
    );
  }
  const closeOutcome = fixture.closeState?.outcome ?? fixture.close;
  return Object.freeze({
    child: fixture.child,
    childPid: fixture.child.pid,
    closeOutcome,
    handlerReadyPath: fixture.handlerReadyPath,
    label: expectedLabel,
    signalMarkerPath: fixture.signalMarkerPath,
    stopPath: fixture.stopPath,
  });
}

async function retainIndependentCooperativeReceipt(receipt) {
  const ready = await waitForFile(receipt.handlerReadyPath, 10_000);
  assert.equal(ready.pid, receipt.childPid, "independent fixture PID changed");
  const identity = captureStableProcessIdentity(ready.pid);
  assert.equal(identity.ppid, process.pid, "independent fixture is not a direct child");
  assert.equal(identity.pid, identity.pgid, "independent fixture does not lead its group");
  const sessionObservation = readSemanticSessionObservation(identity);
  assert.equal(
    isSemanticSessionLeader(sessionObservation),
    true,
    "independent fixture is not a semantic session leader",
  );
  return Object.freeze({
    ...receipt,
    identity: Object.freeze({ ...identity }),
    sessionObservation: Object.freeze({
      ...sessionObservation,
      identity: Object.freeze({ ...sessionObservation.identity }),
    }),
  });
}

function retainIndependentCooperativeReceiptImmediately(receipt) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const identity = captureStableProcessIdentity(receipt.childPid);
      assert.equal(identity.ppid, process.pid, "independent fixture is not a direct child");
      assert.equal(identity.pid, identity.pgid, "independent fixture does not lead its group");
      const sessionObservation = readSemanticSessionObservation(identity);
      assert.equal(
        isSemanticSessionLeader(sessionObservation),
        true,
        "independent fixture is not a semantic session leader",
      );
      return Object.freeze({
        ...receipt,
        identity: Object.freeze({ ...identity }),
        sessionObservation: Object.freeze({
          ...sessionObservation,
          identity: Object.freeze({ ...sessionObservation.identity }),
        }),
      });
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, remaining));
      }
    }
  }
  throw new Error("independent fixture identity was not retained within its bound", {
    cause: lastError,
  });
}

async function settleIndependentCooperativeReceipt(receipt, timeoutMs = 10_000) {
  const close = receipt.closeOutcome;
  assert.equal(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000,
    true,
    "independent cooperative fixture close bound was invalid",
  );
  assert.equal(
    opaqueChildPidSnapshot(receipt.child, receipt.childPid),
    receipt.childPid,
    "independent child receipt was not exact data",
  );
  assert.equal(isExactOpaqueCloseOutcome(close), true, "independent close receipt missing");
  let timeout;
  const closeObservation = Promise.prototype.then.call(
    close,
    (value) => Object.freeze({ kind: "fulfilled", value }),
    (reason) => Object.freeze({ kind: "rejected", reason }),
  );
  const timeoutObservation = new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout(Object.freeze({ kind: "timeout" })), timeoutMs);
  });
  let observed;
  try {
    observed = await Promise.race([closeObservation, timeoutObservation]);
  } finally {
    clearTimeout(timeout);
  }
  if (observed.kind === "timeout") {
    throw new Error("independent cooperative fixture close exceeded its bound");
  }
  if (observed.kind === "rejected") throw observed.reason;
  const outcome = plainDataRecordSnapshot(observed.value, ["code", "signal"]);
  if (
    !outcome ||
    !(outcome.code === null || Number.isSafeInteger(outcome.code)) ||
    !(outcome.signal === null || typeof outcome.signal === "string")
  ) {
    throw new Error("independent cooperative fixture close result was not exact data");
  }
  return Object.freeze({ code: outcome.code, signal: outcome.signal });
}

function plainDataRecordSnapshot(value, keys) {
  try {
    if (!value || typeof value !== "object" || isProxy(value)) return undefined;
    if (
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return undefined;
    }
    const names = Object.getOwnPropertyNames(value);
    const expected = [...keys].sort();
    if (names.length !== expected.length || expected.some((key) => !names.includes(key))) {
      return undefined;
    }
    const snapshot = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        Object.hasOwn(descriptor, "get") ||
        Object.hasOwn(descriptor, "set")
      ) {
        return undefined;
      }
      snapshot[name] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

function frozenPlainDataRecordSnapshot(value, keys) {
  try {
    if (!value || typeof value !== "object" || isProxy(value)) return undefined;
    if (
      !Object.isFrozen(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return undefined;
    }
    const names = Object.getOwnPropertyNames(value);
    const expected = [...keys].sort();
    if (names.length !== expected.length || expected.some((key) => !names.includes(key))) {
      return undefined;
    }
    const snapshot = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        Object.hasOwn(descriptor, "get") ||
        Object.hasOwn(descriptor, "set") ||
        descriptor.configurable !== false ||
        descriptor.enumerable !== true ||
        descriptor.writable !== false
      ) {
        return undefined;
      }
      snapshot[name] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

function frozenArraySnapshot(value) {
  try {
    if (!value || typeof value !== "object" || isProxy(value)) return undefined;
    if (
      !Array.isArray(value) ||
      !Object.isFrozen(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      Object.hasOwn(lengthDescriptor, "get") ||
      Object.hasOwn(lengthDescriptor, "set") ||
      lengthDescriptor.configurable !== false ||
      lengthDescriptor.enumerable !== false ||
      lengthDescriptor.writable !== false ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > 3
    ) {
      return undefined;
    }
    const expectedNames = new Set([
      ...Array.from({ length: lengthDescriptor.value }, (_, index) => String(index)),
      "length",
    ]);
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== expectedNames.size || names.some((name) => !expectedNames.has(name))) {
      return undefined;
    }
    const snapshot = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        Object.hasOwn(descriptor, "get") ||
        Object.hasOwn(descriptor, "set") ||
        descriptor.configurable !== false ||
        descriptor.enumerable !== true ||
        descriptor.writable !== false
      ) {
        return undefined;
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

function freezeSettledResults(results) {
  return Object.freeze(results.map((result) => Object.freeze(result)));
}

function opaqueChildPidSnapshot(child, expectedPid) {
  try {
    if (!child || typeof child !== "object" || isProxy(child)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(child, "pid");
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set") ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value <= 0 ||
      descriptor.value !== expectedPid
    ) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function isExactOpaqueCloseOutcome(value) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      isProxy(value) ||
      !isPromise(value) ||
      Object.getPrototypeOf(value) !== Promise.prototype ||
      Object.getOwnPropertyNames(value).length !== 0
    ) {
      return false;
    }
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length === 0) return true;
    const descriptions = symbols.map((symbol) => symbol.description).sort();
    if (
      descriptions.length !== 2 ||
      descriptions[0] !== "async_id_symbol" ||
      descriptions[1] !== "trigger_async_id_symbol"
    ) {
      return false;
    }
    return symbols.every((symbol) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
      return Boolean(
        descriptor &&
          Object.hasOwn(descriptor, "value") &&
          !Object.hasOwn(descriptor, "get") &&
          !Object.hasOwn(descriptor, "set") &&
          descriptor.configurable === true &&
          descriptor.enumerable === true &&
          descriptor.writable === true &&
          Number.isSafeInteger(descriptor.value) &&
          descriptor.value >= 0,
      );
    });
  } catch {
    return false;
  }
}

const malformedRecoveryExpectedFixtureLabels = Object.freeze(["claimed", "sentinel"]);
const malformedRecoveryParentPid = process.pid;
const malformedRecoveryPlatform = process.platform;

function malformedRecoveryRootCleanupPlan(evidence) {
  const evidenceData = plainDataRecordSnapshot(evidence, [
    "acquisitionReceipts",
    "cleanupRoots",
    "closeJoins",
    "exactAbsenceResults",
    "exactOwners",
    "helperCallAttempted",
    "rootCapabilityResults",
    "stopPublications",
  ]);
  if (!evidenceData || typeof evidenceData.helperCallAttempted !== "boolean") {
    return undefined;
  }
  const {
    acquisitionReceipts,
    cleanupRoots,
    closeJoins,
    exactAbsenceResults,
    exactOwners,
    helperCallAttempted,
    rootCapabilityResults,
    stopPublications,
  } = evidenceData;
  const arrays = [
    acquisitionReceipts,
    cleanupRoots,
    closeJoins,
    exactAbsenceResults,
    exactOwners,
    rootCapabilityResults,
    stopPublications,
  ].map(frozenArraySnapshot);
  if (arrays.some((value) => value === undefined)) return undefined;
  const [
    receiptItems,
    rootItems,
    closeItems,
    absenceItems,
    ownerItems,
    rootResultItems,
    stopItems,
  ] = arrays;
  if (
    (helperCallAttempted
      ? receiptItems.length !== malformedRecoveryExpectedFixtureLabels.length
      : receiptItems.length !== 0) ||
    rootItems.length !== 3 ||
    (!helperCallAttempted &&
      [receiptItems, closeItems, absenceItems, ownerItems, stopItems].some(
        (value) => value.length !== 0,
      )) ||
    ownerItems.length > receiptItems.length ||
    closeItems.length !== receiptItems.length ||
    absenceItems.length !== ownerItems.length ||
    rootResultItems.length !== rootItems.length ||
    stopItems.length !== receiptItems.length
  ) {
    return undefined;
  }
  const normalizedOwnedCapability = (owned, path) => {
    const data = frozenPlainDataRecordSnapshot(owned, ["dev", "ino", "label", "path"]);
    if (
      !data ||
      typeof data.dev !== "string" ||
      data.dev.length === 0 ||
      typeof data.ino !== "string" ||
      data.ino.length === 0 ||
      typeof data.label !== "string" ||
      data.label.length === 0 ||
      data.path !== path
    ) {
      return undefined;
    }
    return Object.freeze({ data, original: owned });
  };
  const normalizedRoots = rootItems.map((root) => {
    const data = frozenPlainDataRecordSnapshot(root, ["label", "owned", "path"]);
    if (!data || typeof data.label !== "string" || data.label.length === 0) {
      return undefined;
    }
    if (data.path === undefined) {
      return !helperCallAttempted && data.owned === undefined
        ? Object.freeze({ data, owned: undefined })
        : undefined;
    }
    if (typeof data.path !== "string" || data.path.length === 0) return undefined;
    const owned =
      data.owned === undefined ? undefined : normalizedOwnedCapability(data.owned, data.path);
    if (!owned && (helperCallAttempted || data.owned !== undefined)) return undefined;
    return Object.freeze({ data, owned });
  });
  if (normalizedRoots.some((root) => root === undefined)) return undefined;
  const definedRootPaths = normalizedRoots
    .map((root) => root.data.path)
    .filter((path) => path !== undefined);
  if (new Set(definedRootPaths).size !== definedRootPaths.length) return undefined;
  const ownedRoots = [];
  for (let index = 0; index < rootResultItems.length; index += 1) {
    const envelope = frozenPlainDataRecordSnapshot(rootResultItems[index], ["status", "value"]);
    if (!envelope || envelope.status !== "fulfilled") return undefined;
    const absent = frozenPlainDataRecordSnapshot(envelope.value, ["kind"]);
    if (absent?.kind === "absent") continue;
    const value = frozenPlainDataRecordSnapshot(envelope.value, ["kind", "owned"]);
    const root = normalizedRoots[index];
    if (!value || value.kind !== "owned" || root.data.path === undefined) return undefined;
    if (root.owned) {
      if (value.owned !== root.owned.original) return undefined;
      ownedRoots.push(root.owned.original);
      continue;
    }
    if (helperCallAttempted) return undefined;
    const recovered = normalizedOwnedCapability(value.owned, root.data.path);
    if (!recovered) return undefined;
    ownedRoots.push(recovered.original);
  }
  const receiptData = receiptItems.map((receipt) =>
    frozenPlainDataRecordSnapshot(receipt, [
      "child",
      "childPid",
      "closeOutcome",
      "handlerReadyPath",
      "label",
      "signalMarkerPath",
      "stopPath",
    ]),
  );
  const ownerData = ownerItems.map((owner) =>
    frozenPlainDataRecordSnapshot(owner, [
      "child",
      "childPid",
      "closeOutcome",
      "handlerReadyPath",
      "identity",
      "label",
      "sessionObservation",
      "signalMarkerPath",
      "stopPath",
    ]),
  );
  if (receiptData.some((value) => !value) || ownerData.some((value) => !value)) {
    return undefined;
  }
  const normalizedReceipts = receiptData.map((receipt) => {
    const childPid = opaqueChildPidSnapshot(receipt.child, receipt.childPid);
    if (
      childPid === undefined ||
      !isExactOpaqueCloseOutcome(receipt.closeOutcome) ||
      typeof receipt.handlerReadyPath !== "string" ||
      typeof receipt.label !== "string" ||
      typeof receipt.signalMarkerPath !== "string" ||
      typeof receipt.stopPath !== "string"
    ) {
      return undefined;
    }
    return Object.freeze({ childPid, data: receipt });
  });
  const normalizedOwners = ownerData.map((owner) => {
    const childPid = opaqueChildPidSnapshot(owner.child, owner.childPid);
    const identity = frozenPlainDataRecordSnapshot(owner.identity, [
      "command",
      "pgid",
      "pid",
      "ppid",
      "session",
      "start",
      "uid",
    ]);
    const sessionObservationData = frozenPlainDataRecordSnapshot(owner.sessionObservation, [
      "identity",
      "pid",
      "platform",
      "state",
    ]);
    const sessionIdentity = sessionObservationData
      ? frozenPlainDataRecordSnapshot(sessionObservationData.identity, [
          "command",
          "pgid",
          "pid",
          "ppid",
          "session",
          "start",
          "uid",
        ])
      : undefined;
    const sessionObservation =
      sessionObservationData && sessionIdentity
        ? Object.freeze({
            identity: sessionIdentity,
            pid: sessionObservationData.pid,
            platform: sessionObservationData.platform,
            state: sessionObservationData.state,
          })
        : undefined;
    if (
      childPid === undefined ||
      !isExactOpaqueCloseOutcome(owner.closeOutcome) ||
      !identity ||
      typeof identity.command !== "string" ||
      identity.command.length === 0 ||
      !Number.isSafeInteger(identity.pgid) ||
      identity.pgid <= 0 ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      !Number.isSafeInteger(identity.ppid) ||
      identity.ppid <= 0 ||
      !Number.isSafeInteger(identity.session) ||
      identity.session < 0 ||
      typeof identity.start !== "string" ||
      identity.start.length === 0 ||
      !Number.isSafeInteger(identity.uid) ||
      identity.uid < 0 ||
      !sessionObservation ||
      !sameProcessIdentity(identity, sessionIdentity) ||
      sessionObservation.pid !== identity.pid ||
      sessionObservation.platform !== malformedRecoveryPlatform ||
      !isSemanticSessionLeader(sessionObservation)
    ) {
      return undefined;
    }
    return Object.freeze({ childPid, data: owner, identity, sessionObservation });
  });
  if (
    normalizedReceipts.some((value) => !value) ||
    normalizedOwners.some((value) => !value) ||
    !Number.isSafeInteger(malformedRecoveryParentPid) ||
    malformedRecoveryParentPid <= 0 ||
    normalizedReceipts.some(
      (receipt, index) => receipt.data.label !== malformedRecoveryExpectedFixtureLabels[index],
    )
  ) {
    return undefined;
  }
  const receiptSet =
    new Set(normalizedReceipts.map((receipt) => receipt.data.stopPath)).size ===
      normalizedReceipts.length &&
    new Set(normalizedReceipts.map((receipt) => receipt.data.child)).size ===
      normalizedReceipts.length &&
    new Set(normalizedReceipts.map((receipt) => receipt.childPid)).size ===
      normalizedReceipts.length &&
    new Set(normalizedReceipts.map((receipt) => receipt.data.closeOutcome)).size ===
      normalizedReceipts.length &&
    normalizedReceipts.every(
      (receipt) =>
        receipt.data.child &&
        receipt.data.handlerReadyPath.length > 0 &&
        receipt.data.label.length > 0 &&
        receipt.data.signalMarkerPath.length > 0 &&
        receipt.data.stopPath.length > 0,
    );
  if (!receiptSet) return undefined;
  const ownerSet =
    new Set(normalizedOwners.map((owner) => owner.identity.pid)).size === normalizedOwners.length &&
    normalizedOwners.every(
      (owner) =>
        owner.identity.ppid === malformedRecoveryParentPid &&
        owner.identity.pid === owner.identity.pgid &&
        normalizedReceipts.filter(
          (receipt) =>
            owner.data.child === receipt.data.child &&
            owner.childPid === receipt.childPid &&
            owner.data.closeOutcome === receipt.data.closeOutcome &&
            owner.data.handlerReadyPath === receipt.data.handlerReadyPath &&
            owner.data.label === receipt.data.label &&
            owner.data.signalMarkerPath === receipt.data.signalMarkerPath &&
            owner.data.stopPath === receipt.data.stopPath &&
            owner.identity.pid === receipt.childPid,
        ).length === 1,
    );
  if (!ownerSet) return undefined;
  const stopsProved = stopItems.every((result, index) => {
    const envelope = frozenPlainDataRecordSnapshot(result, ["status", "value"]);
    const value =
      envelope?.status === "fulfilled"
        ? frozenPlainDataRecordSnapshot(envelope.value, ["kind", "stopPath"])
        : undefined;
    return (
      value &&
      value.kind === "published" &&
      value.stopPath === normalizedReceipts[index].data.stopPath
    );
  });
  const closesProved = closeItems.every((result, index) => {
    const envelope = frozenPlainDataRecordSnapshot(result, ["status", "value"]);
    const value =
      envelope?.status === "fulfilled"
        ? frozenPlainDataRecordSnapshot(envelope.value, ["code", "pid", "signal", "signalAbsent"])
        : undefined;
    return (
      value &&
      value.code === 0 &&
      value.signal === null &&
      value.signalAbsent === true &&
      value.pid === normalizedReceipts[index].childPid
    );
  });
  const exactAbsenceProved = absenceItems.every((result, index) => {
    const envelope = frozenPlainDataRecordSnapshot(result, ["status", "value"]);
    const value =
      envelope?.status === "fulfilled"
        ? frozenPlainDataRecordSnapshot(envelope.value, ["identityAbsent", "pid", "signalAbsent"])
        : undefined;
    return (
      value &&
      value.identityAbsent === true &&
      value.signalAbsent === true &&
      value.pid === normalizedOwners[index].identity.pid
    );
  });
  return stopsProved && closesProved && exactAbsenceProved ? Object.freeze(ownedRoots) : undefined;
}

async function stopAndJoinCooperativeFixture(slot) {
  await retainCooperativeFixture(slot);
  await publishCooperativeFixtureStop(slot);
  return await joinCooperativeFixture(slot);
}

function diagnosticsExcludeTrackedValues(output, trackedValues) {
  return (
    trackedValues.length === 5 &&
    new Set(trackedValues).size === trackedValues.length &&
    trackedValues.every((value) => typeof value === "string" && value.length > 0) &&
    trackedValues.every((value) => !String(output).includes(value))
  );
}

function delayUntil(deadline) {
  return new Promise((resolveWait) => setTimeout(resolveWait, Math.max(0, deadline - Date.now())));
}

function sourceLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function visitNode(root, callback) {
  const visit = (node) => {
    callback(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function isCallNamed(node, name) {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
  );
}

function isAsyncFunctionLike(node) {
  return Boolean(
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
  );
}

function namedFunctionDeclarations(sourceFile, name) {
  const declarations = [];
  visitNode(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declarations.push(node);
  });
  return declarations;
}

function uniqueTopLevelFunctionDeclaration(sourceFile, name) {
  const declarations = namedFunctionDeclarations(sourceFile, name);
  return declarations.length === 1 && declarations[0].parent === sourceFile
    ? declarations[0]
    : undefined;
}

function normalizedModuleIdentity(moduleName) {
  if (typeof moduleName !== "string" || moduleName.length === 0) return undefined;
  if (moduleName.startsWith("file:")) {
    try {
      return `file:${resolve(fileURLToPath(moduleName))}`;
    } catch {
      return undefined;
    }
  }
  const withoutNodePrefix = moduleName.startsWith("node:")
    ? moduleName.slice("node:".length)
    : moduleName;
  if (withoutNodePrefix.startsWith(".") || withoutNodePrefix.startsWith("/")) {
    try {
      return `file:${resolve(fileURLToPath(new URL(withoutNodePrefix, import.meta.url)))}`;
    } catch {
      return undefined;
    }
  }
  const segments = [];
  for (const segment of withoutNodePrefix.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function canonicalHarnessStaticImportSource() {
  return [
    'import assert from "node:assert/strict";',
    'import {spawn,spawnSync} from "node:child_process";',
    'import {randomUUID} from "node:crypto";',
    'import {closeSync,fstatSync,mkdtempSync,openSync,realpathSync,statSync,unlinkSync} from "node:fs";',
    'import {access,link,mkdir,mkdtemp,readdir,readFile,realpath,rename,rm,rmdir,symlink,writeFile} from "node:fs/promises";',
    'import {createServer} from "node:net";',
    'import {homedir,tmpdir} from "node:os";',
    'import {dirname,join,resolve} from "node:path";',
    'import {after,describe,it} from "node:test";',
    'import {fileURLToPath} from "node:url";',
    'import {isPromise,isProxy} from "node:util/types";',
    'import ts from "typescript";',
    'import {assertLoopbackBrowserEndpoint,assertSafeTrackedPaths,assertSourceQualification,createArtifactDirectory,createProcessPlan,createStreamingRedactor,isExactActorRequest,lifecycleStages,runCleanupSteps,sanitizeEvidence,scrubAndAssertArtifactSecrets,stopChild,teardownStages,withTemporaryEnvironment,withTimeout} from "./hr-browser-harness.mjs";',
    'import {captureOwnedDirectory,classifyProcessGroupProbeError,classifyRetainedLeader,cleanupExactOwnedDirectories,commandUsesExactExecutable,isExactHarnessExitReceipt,isSecureControlFileMetadata,parseBrowserRegistration,renderBrowserLauncherShimForTest} from "./with-postgres.mjs";',
    'import {chromium as browserToolingChromium} from "./browser-tooling/node_modules/@playwright/test/index.mjs";',
  ].join("\n");
}

function staticModuleAcquisitionStatements(sourceFile) {
  return sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement),
  );
}

function staticModuleSpecifierText(statement) {
  if (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier &&
    (ts.isStringLiteral(statement.moduleSpecifier) ||
      ts.isNoSubstitutionTemplateLiteral(statement.moduleSpecifier))
  ) {
    return statement.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(statement) &&
    ts.isExternalModuleReference(statement.moduleReference) &&
    (ts.isStringLiteral(statement.moduleReference.expression) ||
      ts.isNoSubstitutionTemplateLiteral(statement.moduleReference.expression))
  ) {
    return statement.moduleReference.expression.text;
  }
  return undefined;
}

function staticAcquisitionFingerprintMultiset(sourceFile) {
  return staticModuleAcquisitionStatements(sourceFile)
    .map((statement) => astFingerprint(statement, sourceFile))
    .sort();
}

function exactStaticImportFingerprint(sourceText) {
  const sourceFile = ts.createSourceFile(
    "canonical-static-import",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  return imports.length === 1 ? astFingerprint(imports[0], sourceFile) : undefined;
}

function normalizedStaticSpecifierText(moduleName) {
  if (typeof moduleName !== "string") return undefined;
  const withoutQueryOrFragment = moduleName.replace(/[?#].*$/s, "");
  try {
    return decodeURIComponent(withoutQueryOrFragment).replaceAll("\\", "/").toLowerCase();
  } catch {
    return withoutQueryOrFragment.replaceAll("\\", "/").toLowerCase();
  }
}

function isPlaywrightAuthorityModule(moduleName) {
  const normalized = normalizedStaticSpecifierText(moduleName);
  if (!normalized) return false;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.some(
    (segment, index) =>
      (segment === "@playwright" && segments[index + 1] === "test") ||
      segment === "playwright" ||
      segment === "playwright-core" ||
      segment.startsWith("@playwright+test@") ||
      segment.startsWith("playwright@") ||
      segment.startsWith("playwright-core@"),
  );
}

function isEvaluatorModuleIdentity(moduleName) {
  const identity = normalizedModuleIdentity(moduleName)?.toLowerCase();
  return Boolean(
    identity &&
      ["inspector", "repl", "vm"].some(
        (root) => identity === root || identity.startsWith(root + "/"),
      ),
  );
}

function classifyStaticAuthorityAcquisitions(sourceFile, canonicalFile) {
  const acquisitions = staticModuleAcquisitionStatements(sourceFile);
  const actualFingerprintMultiset = staticAcquisitionFingerprintMultiset(sourceFile);
  const canonicalFingerprintMultiset = staticAcquisitionFingerprintMultiset(canonicalFile);
  const harnessImportFile = ts.createSourceFile(
    "canonical-harness-static-imports",
    canonicalHarnessStaticImportSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const harnessFingerprintMultiset = staticAcquisitionFingerprintMultiset(harnessImportFile);
  const exactProfile = [canonicalFingerprintMultiset, harnessFingerprintMultiset].some(
    (expected) => JSON.stringify(actualFingerprintMultiset) === JSON.stringify(expected),
  );
  const exactAssertFingerprint = exactStaticImportFingerprint(
    'import assert from "node:assert/strict";',
  );
  const exactBrowserFingerprint = exactStaticImportFingerprint(
    'import {chromium as browserToolingChromium} from "./browser-tooling/node_modules/@playwright/test/index.mjs";',
  );
  let closedFamilies = true;
  for (const statement of acquisitions) {
    if (!ts.isImportDeclaration(statement)) {
      closedFamilies = false;
      continue;
    }
    const moduleName = staticModuleSpecifierText(statement);
    const scheme =
      typeof moduleName === "string"
        ? /^([a-z][a-z0-9+.-]*):/i.exec(moduleName)?.[1]?.toLowerCase()
        : undefined;
    if (scheme && scheme !== "node") closedFamilies = false;
    const identity = normalizedModuleIdentity(moduleName)?.toLowerCase();
    const fingerprint = astFingerprint(statement, sourceFile);
    if (
      (identity === "assert" || identity === "assert/strict") &&
      fingerprint !== exactAssertFingerprint
    ) {
      closedFamilies = false;
    }
    if (isEvaluatorModuleIdentity(moduleName)) closedFamilies = false;
    if (isPlaywrightAuthorityModule(moduleName) && fingerprint !== exactBrowserFingerprint) {
      closedFamilies = false;
    }
  }
  return {
    exact: exactProfile && closedFamilies,
    exactProfile,
    closedFamilies,
  };
}

function moduleSpecifierHasIdentity(moduleSpecifier, moduleName) {
  return Boolean(
    (ts.isStringLiteral(moduleSpecifier) || ts.isNoSubstitutionTemplateLiteral(moduleSpecifier)) &&
      normalizedModuleIdentity(moduleSpecifier.text) === normalizedModuleIdentity(moduleName),
  );
}

function hasStaticEvaluatorModuleAcquisition(sourceFile) {
  return sourceFile.statements.some(
    (statement) =>
      ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        isEvaluatorModuleIdentity(statement.moduleSpecifier.text)) ||
      (ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        isEvaluatorModuleIdentity(statement.moduleReference.expression?.text)),
  );
}

function hasExactUnaliasedNamedImport(sourceFile, moduleName, importedName) {
  const moduleImports = sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      moduleSpecifierHasIdentity(statement.moduleSpecifier, moduleName),
  );
  if (moduleImports.length !== 1) return false;
  const namedBindings = moduleImports[0].importClause?.namedBindings;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return false;
  return (
    namedBindings.elements.filter(
      (element) =>
        !element.propertyName &&
        ts.isIdentifier(element.name) &&
        element.name.text === importedName,
    ).length === 1
  );
}

function hasClosedUnaliasedNamedImportSet(sourceFile, moduleName, requiredNames) {
  const moduleImports = sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      moduleSpecifierHasIdentity(statement.moduleSpecifier, moduleName),
  );
  if (moduleImports.length !== 1) return false;
  if (
    sourceFile.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        moduleSpecifierHasIdentity(statement.moduleSpecifier, moduleName),
    )
  ) {
    return false;
  }
  let secondaryAcquisition = false;
  if (
    sourceFile.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ["module", "node:module"].some((loaderModule) =>
          isStringLiteralValue(statement.moduleSpecifier, loaderModule),
        ),
    )
  ) {
    secondaryAcquisition = true;
  }
  visitNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = propertyChain(node.expression);
    const loaderName = callee.at(-1);
    if (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ["createRequire", "getBuiltinModule", "require"].includes(loaderName) ||
      (isStringLiteralValue(node.arguments[0], moduleName) &&
        ["import", "require"].includes(loaderName))
    ) {
      secondaryAcquisition = true;
    }
  });
  if (secondaryAcquisition) return false;
  const importClause = moduleImports[0].importClause;
  const namedBindings = importClause?.namedBindings;
  if (
    !importClause ||
    importClause.name ||
    importClause.isTypeOnly ||
    !namedBindings ||
    !ts.isNamedImports(namedBindings)
  ) {
    return false;
  }
  const allowedNames = new Set(["after", "describe", "it"]);
  const observedNames = [];
  for (const element of namedBindings.elements) {
    if (
      element.propertyName ||
      element.isTypeOnly ||
      !ts.isIdentifier(element.name) ||
      !allowedNames.has(element.name.text)
    ) {
      return false;
    }
    observedNames.push(element.name.text);
  }
  return (
    new Set(observedNames).size === observedNames.length &&
    requiredNames.every((name) => observedNames.includes(name))
  );
}

function hasClosedChildProcessImportSet(sourceFile, requiredNames) {
  const moduleImports = sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ["child_process", "node:child_process"].some((moduleName) =>
        isStringLiteralValue(statement.moduleSpecifier, moduleName),
      ),
  );
  if (moduleImports.length !== 1) return false;
  if (
    sourceFile.statements.some(
      (statement) =>
        (ts.isExportDeclaration(statement) &&
          statement.moduleSpecifier &&
          ["child_process", "node:child_process"].some((moduleName) =>
            isStringLiteralValue(statement.moduleSpecifier, moduleName),
          )) ||
        (ts.isImportDeclaration(statement) &&
          ["module", "node:module"].some((moduleName) =>
            isStringLiteralValue(statement.moduleSpecifier, moduleName),
          )),
    )
  ) {
    return false;
  }
  const importClause = moduleImports[0].importClause;
  const namedBindings = importClause?.namedBindings;
  if (
    !importClause ||
    importClause.name ||
    importClause.isTypeOnly ||
    !namedBindings ||
    !ts.isNamedImports(namedBindings)
  ) {
    return false;
  }
  const allowedNames = new Set(["spawn", "spawnSync"]);
  const observedNames = [];
  for (const element of namedBindings.elements) {
    if (
      element.propertyName ||
      element.isTypeOnly ||
      !ts.isIdentifier(element.name) ||
      !allowedNames.has(element.name.text)
    ) {
      return false;
    }
    observedNames.push(element.name.text);
  }
  if (
    new Set(observedNames).size !== observedNames.length ||
    !requiredNames.every((name) => observedNames.includes(name))
  ) {
    return false;
  }
  let secondaryAcquisition = false;
  visitNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = propertyChain(node.expression);
    const loaderName = callee.at(-1);
    if (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      [
        "_linkedBinding",
        "binding",
        "createRequire",
        "dlopen",
        "getBuiltinModule",
        "require",
      ].includes(loaderName)
    ) {
      secondaryAcquisition = true;
    }
  });
  return !secondaryAcquisition;
}

function hasExactAliasedNamedImport(sourceFile, moduleName, importedName, localName) {
  const moduleImports = sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      moduleSpecifierHasIdentity(statement.moduleSpecifier, moduleName),
  );
  if (moduleImports.length !== 1) return false;
  const importClause = moduleImports[0].importClause;
  const namedBindings = importClause?.namedBindings;
  if (
    !importClause ||
    importClause.name ||
    importClause.isTypeOnly ||
    !namedBindings ||
    !ts.isNamedImports(namedBindings) ||
    namedBindings.elements.length !== 1
  ) {
    return false;
  }
  const [element] = namedBindings.elements;
  return Boolean(
    element.propertyName?.text === importedName &&
      element.name.text === localName &&
      !element.isTypeOnly,
  );
}

function hasExactDefaultImport(sourceFile, moduleName, localName) {
  const moduleImports = sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      moduleSpecifierHasIdentity(statement.moduleSpecifier, moduleName),
  );
  if (moduleImports.length !== 1) return false;
  const importClause = moduleImports[0].importClause;
  return Boolean(
    importClause?.name?.text === localName &&
      !importClause.namedBindings &&
      !importClause.isTypeOnly,
  );
}

function containsLocalBinding(root, name) {
  return namedBindingNodes(root, name).some(
    (binding) =>
      !((ts.isFunctionDeclaration(root) || ts.isClassDeclaration(root)) && root.name === binding),
  );
}

function astFingerprint(node, sourceFile) {
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(astFingerprint(child, sourceFile));
  });
  const declarationListKind = ts.isVariableDeclarationList(node)
    ? (node.flags & ts.NodeFlags.Const) !== 0
      ? "const"
      : (node.flags & ts.NodeFlags.Let) !== 0
        ? "let"
        : "var"
    : undefined;
  const nodeIdentity = declarationListKind
    ? `${node.kind}:${declarationListKind}`
    : String(node.kind);
  const semanticLeafText = () => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return JSON.stringify(node.text);
    }
    if (ts.isNumericLiteral(node)) {
      return String(Number(node.text.replaceAll("_", "")));
    }
    if (ts.isBigIntLiteral(node)) {
      return `${node.text.replaceAll("_", "").replace(/n$/i, "")}n`;
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      return JSON.stringify({ rawText: node.rawText ?? node.text, text: node.text });
    }
    return node.getText(sourceFile);
  };
  return children.length === 0
    ? `${nodeIdentity}:${semanticLeafText()}`
    : `${nodeIdentity}(${children.join(",")})`;
}

function propertyChain(node) {
  if (!node) return [];
  if (ts.isIdentifier(node)) return [node.text];
  if (!ts.isPropertyAccessExpression(node)) return [];
  return [...propertyChain(node.expression), node.name.text];
}

function isStringLiteralValue(node, value) {
  return (
    Boolean(node) &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    node.text === value
  );
}

function staticStringValue(node) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticStringValue(span.expression);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function unparenthesizedExpression(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function bindingNameNodes(nameNode, name) {
  if (ts.isIdentifier(nameNode)) return nameNode.text === name ? [nameNode] : [];
  if (!ts.isObjectBindingPattern(nameNode) && !ts.isArrayBindingPattern(nameNode)) {
    return [];
  }
  return nameNode.elements.flatMap((element) =>
    ts.isOmittedExpression(element) || !ts.isBindingElement(element)
      ? []
      : bindingNameNodes(element.name, name),
  );
}

function sourceLevelBindingNodes(sourceFile, name) {
  const bindings = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name?.text === name) bindings.push(clause.name);
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.name.text === name) bindings.push(element.name);
        }
      }
      if (named && ts.isNamespaceImport(named) && named.name.text === name) {
        bindings.push(named.name);
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindings.push(...bindingNameNodes(declaration.name, name));
      }
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      bindings.push(statement.name);
    }
  }
  return bindings;
}

function directVariableDeclarations(container, name) {
  const declarations = [];
  for (const statement of container?.statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (bindingNameNodes(declaration.name, name).length > 0) declarations.push(declaration);
    }
  }
  return declarations;
}

function namedBindingNodes(root, name) {
  const bindings = [];
  visitNode(root, (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      bindingNameNodes(node.name, name).length > 0
    ) {
      bindings.push(...bindingNameNodes(node.name, name));
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === name
    ) {
      bindings.push(node.name);
    }
  });
  return [...new Set(bindings)];
}

function isConstVariableDeclaration(declaration) {
  return Boolean(
    declaration &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
  );
}

function assignmentTargetContainsName(node, name) {
  let found = false;
  visitNode(node, (candidate) => {
    if (ts.isIdentifier(candidate) && candidate.text === name) found = true;
  });
  return found;
}

function identifierMutationNodes(root, name) {
  const mutations = [];
  visitNode(root, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignmentTargetContainsName(node.left, name)
    ) {
      mutations.push(node);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
      assignmentTargetContainsName(node.operand, name)
    ) {
      mutations.push(node);
    }
  });
  return mutations;
}

function hasIdentifierReassignment(root, name) {
  return identifierMutationNodes(root, name).length > 0;
}

function hasDirectIdentifierReassignment(root, name) {
  let found = false;
  visitNode(root, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(unparenthesizedExpression(node.left)) &&
      unparenthesizedExpression(node.left).text === name
    ) {
      found = true;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
      ts.isIdentifier(unparenthesizedExpression(node.operand)) &&
      unparenthesizedExpression(node.operand).text === name
    ) {
      found = true;
    }
  });
  return found;
}

function hasAuthorityMutation(root, name) {
  if (hasIdentifierReassignment(root, name)) return true;
  let found = false;
  visitNode(root, (node) => {
    if (ts.isDeleteExpression(node) && assignmentTargetContainsName(node.expression, name)) {
      found = true;
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const callee = propertyChain(node.expression).join(".");
    if (
      ![
        "Object.assign",
        "Object.defineProperties",
        "Object.defineProperty",
        "Object.setPrototypeOf",
        "Reflect.defineProperty",
        "Reflect.deleteProperty",
        "Reflect.set",
        "Reflect.setPrototypeOf",
      ].includes(callee)
    ) {
      return;
    }
    const targetChain = propertyChain(unparenthesizedExpression(node.arguments[0]));
    if (targetChain[0] === name) found = true;
  });
  return found;
}

function staticAuthorityPath(node, sourceFile) {
  const expression = unparenthesizedExpression(node);
  if (!expression) return undefined;
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = staticAuthorityPath(expression.expression, sourceFile);
    return parent ? [...parent, expression.name.text] : undefined;
  }
  if (ts.isElementAccessExpression(expression)) {
    const parent = staticAuthorityPath(expression.expression, sourceFile);
    if (!parent) return undefined;
    return [...parent, resolvedStaticStringValue(expression.argumentExpression, sourceFile) ?? "*"];
  }
  return undefined;
}

function authorityAliasEscapeNodes(
  root,
  sourceFile,
  protectedRoots,
  callEscapeRoots = protectedRoots,
  allowedSubtrees = [],
) {
  const escapes = [];
  const derivedAuthorityBindings = new Set();
  const isAllowedNode = (node) =>
    allowedSubtrees.some((allowedRoot) => nodeIsWithin(node, allowedRoot));
  const staticMemberName = (node) => {
    const expression = unparenthesizedExpression(node);
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression)) {
      return resolvedStaticStringValue(expression.argumentExpression, sourceFile);
    }
    return undefined;
  };
  const hasIntrinsicRecoveryEdge = (node) => {
    let current = unparenthesizedExpression(node);
    if (!current) return false;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      if (
        [
          "__defineGetter__",
          "__defineSetter__",
          "__lookupGetter__",
          "__lookupSetter__",
          "__proto__",
          "constructor",
        ].includes(staticMemberName(current))
      ) {
        return true;
      }
      current = unparenthesizedExpression(current.expression);
    }
    if (!ts.isCallExpression(current)) return false;
    const callee = propertyChain(current.expression).join(".");
    if (["Object.getPrototypeOf", "Reflect.getPrototypeOf"].includes(callee)) return true;
    return (
      callee === "Reflect.get" &&
      ["__proto__", "constructor", "prototype"].includes(
        resolvedStaticStringValue(current.arguments[1], sourceFile),
      )
    );
  };
  const protectedPath = (node, roots = protectedRoots) => {
    if (hasIntrinsicRecoveryEdge(node)) return true;
    const path = staticAuthorityPath(node, sourceFile);
    if (!path || (!roots.has(path[0]) && !derivedAuthorityBindings.has(path[0]))) {
      return false;
    }
    if (path[0] === "process") {
      return (
        path.length === 1 ||
        [
          "_kill",
          "_linkedBinding",
          "binding",
          "dlopen",
          "getBuiltinModule",
          "kill",
          "mainModule",
        ].includes(path[1])
      );
    }
    if (path[0] === "Number" && path.length === 2 && path[1] === "MAX_SAFE_INTEGER") {
      return false;
    }
    return true;
  };
  visitNode(root, (node) => {
    if (!ts.isHeritageClause(node)) return;
    for (const type of node.types) {
      let protectedBase = false;
      visitNode(type.expression, (candidate) => {
        const basePath = staticAuthorityPath(candidate, sourceFile);
        if (basePath && protectedRoots.has(basePath[0])) protectedBase = true;
      });
      if (!protectedBase) continue;
      const declaration = node.parent;
      if (ts.isClassDeclaration(declaration) && declaration.name) {
        derivedAuthorityBindings.add(declaration.name.text);
      }
      if (
        ts.isClassExpression(declaration) &&
        ts.isVariableDeclaration(declaration.parent) &&
        ts.isIdentifier(declaration.parent.name)
      ) {
        derivedAuthorityBindings.add(declaration.parent.name.text);
      }
    }
  });
  const containsProtectedReference = (node, roots = protectedRoots) => {
    let found = false;
    visitNode(node, (candidate) => {
      if (protectedPath(candidate, roots)) found = true;
    });
    return found;
  };
  const exposesAuthority = (node, roots = protectedRoots) => {
    const expression = unparenthesizedExpression(node);
    if (!expression) return false;
    if (protectedPath(expression, roots)) return true;
    if (
      ts.isAwaitExpression(expression) ||
      ts.isYieldExpression(expression) ||
      ts.isSpreadElement(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return Boolean(expression.expression) && exposesAuthority(expression.expression, roots);
    }
    if (
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.CommaToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(expression.operatorToken.kind)
    ) {
      return exposesAuthority(expression.left, roots) || exposesAuthority(expression.right, roots);
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        exposesAuthority(expression.whenTrue, roots) ||
        exposesAuthority(expression.whenFalse, roots)
      );
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some((element) =>
        ts.isSpreadElement(element)
          ? exposesAuthority(element.expression, roots)
          : exposesAuthority(element, roots),
      );
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some((property) => {
        if (ts.isSpreadAssignment(property)) return exposesAuthority(property.expression, roots);
        if (ts.isPropertyAssignment(property)) return exposesAuthority(property.initializer, roots);
        if (ts.isShorthandPropertyAssignment(property))
          return exposesAuthority(property.name, roots);
        return false;
      });
    }
    if (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      exposesAuthority(expression.expression, roots)
    ) {
      return true;
    }
    if (ts.isCallExpression(expression)) {
      const callee = staticAuthorityPath(expression.expression, sourceFile) ?? [];
      if (["bind", "valueOf"].includes(callee.at(-1))) {
        return protectedPath(unparenthesizedExpression(expression.expression).expression, roots);
      }
      if (
        [
          "Object.getPrototypeOf",
          "Reflect.get",
          "Reflect.getPrototypeOf",
          "Promise.resolve",
        ].includes(callee.join("."))
      ) {
        if (
          ["Object.getPrototypeOf", "Reflect.getPrototypeOf"].includes(callee.join(".")) ||
          (callee.join(".") === "Reflect.get" &&
            ["__proto__", "constructor", "prototype"].includes(
              resolvedStaticStringValue(expression.arguments[1], sourceFile),
            ))
        ) {
          return true;
        }
        return expression.arguments.some(
          (argument) =>
            exposesAuthority(argument, roots) || containsProtectedReference(argument, roots),
        );
      }
    }
    return false;
  };
  visitNode(root, (node) => {
    if (isAllowedNode(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer && exposesAuthority(node.initializer)) {
      escapes.push(node);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (exposesAuthority(node.right) || protectedPath(node.left))
    ) {
      escapes.push(node);
      return;
    }
    if (ts.isReturnStatement(node) && node.expression && exposesAuthority(node.expression)) {
      escapes.push(node);
      return;
    }
    if (ts.isThrowStatement(node) && node.expression && exposesAuthority(node.expression)) {
      escapes.push(node);
      return;
    }
    if (ts.isYieldExpression(node) && node.expression && exposesAuthority(node.expression)) {
      escapes.push(node);
      return;
    }
    if (ts.isParameter(node) && node.initializer && exposesAuthority(node.initializer)) {
      escapes.push(node);
      return;
    }
    if (ts.isPropertyDeclaration(node) && node.initializer && exposesAuthority(node.initializer)) {
      escapes.push(node);
      return;
    }
    if (
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        protectedPath(node.operand)) ||
      (ts.isDeleteExpression(node) && protectedPath(node.expression))
    ) {
      escapes.push(node);
      return;
    }
    if (
      ts.isForOfStatement(node) &&
      (exposesAuthority(node.expression) ||
        (!ts.isVariableDeclarationList(node.initializer) && exposesAuthority(node.initializer)))
    ) {
      escapes.push(node);
      return;
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      (exposesAuthority(node.tag, callEscapeRoots) ||
        (ts.isTemplateExpression(node.template) &&
          node.template.templateSpans.some((span) => exposesAuthority(span.expression))))
    ) {
      escapes.push(node);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        [
          "_linkedBinding",
          "binding",
          "createRequire",
          "dlopen",
          "getBuiltinModule",
          "require",
        ].includes(propertyChain(node.expression).at(-1)))
    ) {
      escapes.push(node);
      return;
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && exposesAuthority(node.body)) {
      escapes.push(node);
      return;
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      (() => {
        const callee = unparenthesizedExpression(node.expression);
        const calleePath = staticAuthorityPath(callee, sourceFile);
        const directCallOnlyRoots = new Set([
          "after",
          "describe",
          "it",
          "runMaliciousRegistrationCase",
          "spawn",
          "spawnSync",
        ]);
        let optionalAuthorityCall = Boolean(node.questionDotToken);
        for (
          let current = callee;
          !optionalAuthorityCall &&
          (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current));
          current = unparenthesizedExpression(current.expression)
        ) {
          optionalAuthorityCall = Boolean(current.questionDotToken);
        }
        const directProtectedCall = Boolean(
          calleePath &&
            (callEscapeRoots.has(calleePath[0]) || derivedAuthorityBindings.has(calleePath[0])) &&
            !hasIntrinsicRecoveryEdge(callee) &&
            !optionalAuthorityCall &&
            !(ts.isNewExpression(node) && directCallOnlyRoots.has(calleePath[0])) &&
            calleePath.length <= (directCallOnlyRoots.has(calleePath[0]) ? 1 : 2),
        );
        const forbiddenDynamicCall = Boolean(
          calleePath &&
            (calleePath.includes("*") || ["eval", "Function"].includes(calleePath.at(-1))) &&
            (callEscapeRoots.has(calleePath[0]) || derivedAuthorityBindings.has(calleePath[0])),
        );
        return (
          forbiddenDynamicCall ||
          (exposesAuthority(callee, callEscapeRoots) && !directProtectedCall) ||
          (node.arguments ?? []).some((argument) => exposesAuthority(argument, callEscapeRoots))
        );
      })()
    ) {
      escapes.push(node);
    }
  });
  return [...new Set(escapes)];
}

function evaluatorCapabilityPathValues() {
  return [
    "eval",
    "Function",
    "global.*",
    "global.eval",
    "global.Function",
    "globalThis.*",
    "globalThis.eval",
    "globalThis.Function",
  ];
}

function signalCapabilityAliasPathValues() {
  return [
    ...evaluatorCapabilityPathValues(),
    "Object.assign",
    "Object.defineProperties",
    "Object.defineProperty",
    "Object.setPrototypeOf",
    "Reflect.deleteProperty",
    "Reflect.defineProperty",
    "Reflect.get",
    "Reflect.set",
    "Reflect.setPrototypeOf",
    "Set.prototype",
    "process.binding",
    "process.getBuiltinModule",
    "process.mainModule.require",
  ];
}

function capabilityAliasEscapeNodes(
  root,
  sourceFile,
  protectedPathValues,
  callablePathValues = [],
  allowedSubtrees = [],
) {
  const protectedPaths = new Set(protectedPathValues);
  const callablePaths = new Set(callablePathValues);
  const protectedPrefixes = new Set();
  for (const path of protectedPaths) {
    const parts = path.split(".");
    for (let length = 1; length <= parts.length; length += 1) {
      protectedPrefixes.add(parts.slice(0, length).join("."));
    }
  }
  const globalRoots = new Set([...protectedPrefixes].map((path) => path.split(".")[0]));
  const normalizedGlobalMembers = new Set([
    "Array",
    "eval",
    "Function",
    "Object",
    "process",
    "Reflect",
    "RegExp",
    "Set",
    "String",
  ]);
  const escapes = new Set();
  const scopeByNode = new Map();
  const nodeIsAllowed = (node) =>
    allowedSubtrees.some((allowedRoot) => nodeIsWithin(node, allowedRoot));
  const isFunctionScope = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
  const createsScope = (node) =>
    ts.isSourceFile(node) ||
    isFunctionScope(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCaseBlock(node);
  const nearestScope = (node) => {
    for (let current = node; current; current = current.parent) {
      const scope = scopeByNode.get(current);
      if (scope) return scope;
    }
    return undefined;
  };
  visitNode(sourceFile, (node) => {
    if (!createsScope(node)) return;
    scopeByNode.set(node, {
      bindings: new Map(),
      node,
      parent: nearestScope(node.parent),
    });
  });
  const bindingIdentifiers = (name) => {
    if (ts.isIdentifier(name)) return [name];
    if (!ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name)) return [];
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
    );
  };
  const addBinding = (scope, identifier) => {
    if (!scope) return;
    const bindings = scope.bindings.get(identifier.text) ?? [];
    bindings.push(identifier);
    scope.bindings.set(identifier.text, bindings);
  };
  const nearestVarScope = (node) => {
    for (let scope = nearestScope(node); scope; scope = scope.parent) {
      if (ts.isSourceFile(scope.node) || isFunctionScope(scope.node)) return scope;
    }
    return undefined;
  };
  visitNode(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) addBinding(scopeByNode.get(sourceFile), clause.name);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        addBinding(scopeByNode.get(sourceFile), clause.namedBindings.name);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          addBinding(scopeByNode.get(sourceFile), element.name);
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      addBinding(scopeByNode.get(sourceFile), node.name);
      return;
    }
    if (ts.isParameter(node)) {
      for (const identifier of bindingIdentifiers(node.name)) {
        addBinding(nearestScope(node.parent), identifier);
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : undefined;
      const blockScoped = Boolean(
        declarationList && declarationList.flags & ts.NodeFlags.BlockScoped,
      );
      const scope = ts.isCatchClause(node.parent)
        ? nearestScope(node.parent)
        : blockScoped
          ? nearestScope(node.parent)
          : nearestVarScope(node.parent);
      for (const identifier of bindingIdentifiers(node.name)) addBinding(scope, identifier);
      return;
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      addBinding(nearestScope(node.parent), node.name);
      return;
    }
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      addBinding(nearestScope(node), node.name);
    }
  });
  const ambiguousBinding = Symbol("ambiguous-binding");
  const parameterInitializerFunction = (reference) => {
    for (let current = reference; current; current = current.parent) {
      if (
        ts.isParameter(current) &&
        current.initializer &&
        nodeIsWithin(reference, current.initializer)
      ) {
        return isFunctionScope(current.parent) ? current.parent : undefined;
      }
    }
    return undefined;
  };
  const isFunctionBodyVarBinding = (binding, functionNode) => {
    for (let current = binding; current && current !== functionNode; current = current.parent) {
      if (!ts.isVariableDeclaration(current)) continue;
      const declarationList = ts.isVariableDeclarationList(current.parent)
        ? current.parent
        : undefined;
      return Boolean(
        declarationList &&
          !(declarationList.flags & ts.NodeFlags.BlockScoped) &&
          functionNode.body &&
          nodeIsWithin(current, functionNode.body),
      );
    }
    return false;
  };
  const resolveBinding = (identifier) => {
    const parameterFunction = parameterInitializerFunction(identifier);
    for (let scope = nearestScope(identifier); scope; scope = scope.parent) {
      const bindings = (scope.bindings.get(identifier.text) ?? []).filter(
        (binding) =>
          scope.node !== parameterFunction || !isFunctionBodyVarBinding(binding, parameterFunction),
      );
      if (bindings.length === 0) continue;
      return bindings.length === 1 ? bindings[0] : ambiguousBinding;
    }
    return undefined;
  };
  const aliasPaths = new Map();
  const mergePaths = (...sets) => new Set(sets.flatMap((set) => [...set]));
  const normalizePath = (path) => {
    const parts = path.split(".");
    return ["global", "globalThis"].includes(parts[0]) && normalizedGlobalMembers.has(parts[1])
      ? parts.slice(1).join(".")
      : path;
  };
  const staticMember = (node) => {
    const direct = staticStringValue(node);
    if (direct !== undefined) return direct;
    const expression = unparenthesizedExpression(node);
    if (ts.isNumericLiteral(expression)) return String(Number(expression.text.replaceAll("_", "")));
    if (
      ts.isCallExpression(expression) &&
      expression.arguments.length === 1 &&
      ts.isPropertyAccessExpression(unparenthesizedExpression(expression.expression)) &&
      ts.isIdentifier(unparenthesizedExpression(expression.expression).expression) &&
      unparenthesizedExpression(expression.expression).expression.text === "JSON" &&
      unparenthesizedExpression(expression.expression).name.text === "parse" &&
      resolveBinding(unparenthesizedExpression(expression.expression).expression) === undefined
    ) {
      const encoded = staticStringValue(expression.arguments[0]);
      if (encoded === undefined) return undefined;
      try {
        const decoded = JSON.parse(encoded);
        return typeof decoded === "string" ? decoded : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const expressionPaths = (node) => {
    const expression = unparenthesizedExpression(node);
    if (!expression) return new Set();
    if (ts.isIdentifier(expression)) {
      const binding = resolveBinding(expression);
      if (binding === undefined && globalRoots.has(expression.text)) {
        return new Set([expression.text]);
      }
      return binding && binding !== ambiguousBinding
        ? new Set(aliasPaths.get(binding) ?? [])
        : new Set();
    }
    if (
      ts.isAwaitExpression(expression) ||
      ts.isYieldExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return expression.expression ? expressionPaths(expression.expression) : new Set();
    }
    if (ts.isBinaryExpression(expression)) {
      if (expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return expressionPaths(expression.right);
      }
      if (
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(expression.operatorToken.kind)
      ) {
        return mergePaths(expressionPaths(expression.left), expressionPaths(expression.right));
      }
      return new Set();
    }
    if (ts.isConditionalExpression(expression)) {
      return mergePaths(
        expressionPaths(expression.whenTrue),
        expressionPaths(expression.whenFalse),
      );
    }
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isArrayLiteralExpression(unparenthesizedExpression(expression.expression))
    ) {
      const indexText = staticMember(expression.argumentExpression);
      const index = indexText !== undefined && /^\d+$/.test(indexText) ? Number(indexText) : NaN;
      const element = unparenthesizedExpression(expression.expression).elements[index];
      return element && !ts.isSpreadElement(element) ? expressionPaths(element) : new Set();
    }
    if (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      ts.isObjectLiteralExpression(unparenthesizedExpression(expression.expression))
    ) {
      const member = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : staticMember(expression.argumentExpression);
      if (member === undefined) return new Set();
      const property = unparenthesizedExpression(expression.expression).properties.find(
        (candidate) =>
          (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
          propertyNameStaticValue(candidate.name, sourceFile) === member,
      );
      if (property && ts.isPropertyAssignment(property))
        return expressionPaths(property.initializer);
      if (property && ts.isShorthandPropertyAssignment(property))
        return expressionPaths(property.name);
      return new Set();
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const basePaths = expressionPaths(expression.expression);
      const member = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : staticMember(expression.argumentExpression);
      if (member === undefined) {
        return new Set(
          [...basePaths]
            .filter((path) => ["global", "globalThis"].includes(path))
            .map((path) => `${path}.*`),
        );
      }
      return new Set([...basePaths].map((path) => normalizePath(`${path}.${member}`)));
    }
    if (ts.isCallExpression(expression)) {
      const callee = unparenthesizedExpression(expression.expression);
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        (ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : staticMember(callee.argumentExpression)) === "valueOf"
      ) {
        return expressionPaths(callee.expression);
      }
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        (ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : staticMember(callee.argumentExpression)) === "bind"
      ) {
        return mergePaths(
          expressionPaths(callee.expression),
          ...expression.arguments.map((argument) => expressionPaths(argument)),
        );
      }
      const calleePaths = expressionPaths(callee);
      if (calleePaths.has("Reflect.get") && expression.arguments.length >= 2) {
        const member = staticMember(expression.arguments[1]);
        const basePaths = expressionPaths(expression.arguments[0]);
        if (member === undefined) {
          return new Set(
            [...basePaths]
              .filter((path) => ["global", "globalThis"].includes(path))
              .map((path) => `${path}.*`),
          );
        }
        return new Set([...basePaths].map((path) => normalizePath(`${path}.${member}`)));
      }
    }
    return new Set();
  };
  const tracked = (paths) => new Set([...paths].filter((path) => protectedPrefixes.has(path)));
  const setBindingPaths = (binding, paths, acquisition) => {
    const next = tracked(paths);
    if (next.size === 0) return false;
    if (!binding || binding === ambiguousBinding) {
      if (!nodeIsAllowed(acquisition)) escapes.add(acquisition);
      return false;
    }
    if (!nodeIsAllowed(acquisition)) escapes.add(acquisition);
    const current = aliasPaths.get(binding) ?? new Set();
    const merged = mergePaths(current, next);
    if (merged.size === current.size) return false;
    aliasPaths.set(binding, merged);
    return true;
  };
  const patternMember = (name) => {
    const direct = propertyNameStaticValue(name, sourceFile);
    if (direct !== undefined) return direct;
    return ts.isComputedPropertyName(name) ? staticMember(name.expression) : undefined;
  };
  const unsupportedTarget = (paths, acquisition) => {
    if (tracked(paths).size > 0 && !nodeIsAllowed(acquisition)) escapes.add(acquisition);
    return false;
  };
  const bindPattern = (name, paths, acquisition, declaration, sourceExpression) => {
    const target = declaration ? name : unparenthesizedExpression(name);
    if (ts.isIdentifier(target)) {
      return setBindingPaths(declaration ? target : resolveBinding(target), paths, acquisition);
    }
    if (
      !declaration &&
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return bindPattern(
        target.left,
        mergePaths(paths, expressionPaths(target.right)),
        acquisition,
        false,
        sourceExpression,
      );
    }
    let changed = false;
    if (ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) {
        if (element.dotDotDotToken) {
          changed =
            bindPattern(element.name, paths, acquisition, declaration, sourceExpression) || changed;
          continue;
        }
        const member = element.propertyName
          ? patternMember(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (member === undefined) {
          changed = unsupportedTarget(paths, acquisition) || changed;
          continue;
        }
        const derived = new Set([...paths].map((path) => normalizePath(`${path}.${member}`)));
        const values = element.initializer
          ? mergePaths(derived, expressionPaths(element.initializer))
          : derived;
        changed = bindPattern(element.name, values, acquisition, declaration, undefined) || changed;
      }
      return changed;
    }
    if (!declaration && ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isSpreadAssignment(property)) {
          changed =
            bindPattern(property.expression, paths, acquisition, false, sourceExpression) ||
            changed;
          continue;
        }
        if (ts.isPropertyAssignment(property)) {
          const member = patternMember(property.name);
          if (member === undefined) {
            changed = unsupportedTarget(paths, acquisition) || changed;
            continue;
          }
          const derived = new Set([...paths].map((path) => normalizePath(`${path}.${member}`)));
          changed =
            bindPattern(property.initializer, derived, acquisition, false, undefined) || changed;
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          const derived = new Set(
            [...paths].map((path) => normalizePath(`${path}.${property.name.text}`)),
          );
          const values = property.objectAssignmentInitializer
            ? mergePaths(derived, expressionPaths(property.objectAssignmentInitializer))
            : derived;
          changed = bindPattern(property.name, values, acquisition, false, undefined) || changed;
          continue;
        }
        changed = unsupportedTarget(paths, acquisition) || changed;
      }
      return changed;
    }
    if (ts.isArrayBindingPattern(target) || (!declaration && ts.isArrayLiteralExpression(target))) {
      const elements = target.elements;
      const unwrappedSource = sourceExpression
        ? unparenthesizedExpression(sourceExpression)
        : undefined;
      const sourceArray =
        unwrappedSource && ts.isArrayLiteralExpression(unwrappedSource)
          ? unwrappedSource
          : undefined;
      for (const [index, element] of elements.entries()) {
        if (ts.isOmittedExpression(element)) continue;
        const assignmentElement = ts.isBindingElement(element)
          ? element
          : ts.isSpreadElement(element)
            ? element
            : element;
        const elementTarget = ts.isBindingElement(assignmentElement)
          ? assignmentElement.name
          : ts.isSpreadElement(assignmentElement)
            ? assignmentElement.expression
            : assignmentElement;
        const sourceElement = sourceArray?.elements[index];
        const derived = new Set([...paths].map((path) => `${path}.${index}`));
        const values = mergePaths(
          derived,
          sourceElement && !ts.isOmittedExpression(sourceElement)
            ? expressionPaths(
                ts.isSpreadElement(sourceElement) ? sourceElement.expression : sourceElement,
              )
            : new Set(),
          ts.isBindingElement(assignmentElement) && assignmentElement.initializer
            ? expressionPaths(assignmentElement.initializer)
            : new Set(),
        );
        changed =
          bindPattern(
            elementTarget,
            values,
            acquisition,
            declaration,
            sourceElement && !ts.isOmittedExpression(sourceElement)
              ? ts.isSpreadElement(sourceElement)
                ? sourceElement.expression
                : sourceElement
              : undefined,
          ) || changed;
      }
      return changed;
    }
    return unsupportedTarget(paths, acquisition);
  };
  const acquisitions = [];
  visitNode(root, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      acquisitions.push(() =>
        bindPattern(node.name, expressionPaths(node.initializer), node, true, node.initializer),
      );
    } else if (ts.isParameter(node) && node.initializer) {
      acquisitions.push(() =>
        bindPattern(node.name, expressionPaths(node.initializer), node, true, node.initializer),
      );
    } else if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      acquisitions.push(() =>
        bindPattern(node.left, expressionPaths(node.right), node, false, node.right),
      );
    }
  });
  for (let pass = 0; pass <= acquisitions.length; pass += 1) {
    let changed = false;
    for (const acquire of acquisitions) changed = acquire() || changed;
    if (!changed) break;
  }
  const calledPaths = (node) => {
    const direct = expressionPaths(node);
    const normalized = new Set(direct);
    for (const path of direct) {
      if (path.endsWith(".call") || path.endsWith(".apply")) {
        normalized.add(path.slice(0, path.lastIndexOf(".")));
      }
    }
    return normalized;
  };
  visitNode(root, (node) => {
    if (nodeIsAllowed(node)) return;
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      [...calledPaths(node.expression)].some((path) => callablePaths.has(path))
    ) {
      escapes.add(node);
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      [...calledPaths(node.tag)].some((path) => callablePaths.has(path))
    ) {
      escapes.add(node);
    }
    if (
      ts.isCallExpression(node) &&
      propertyChain(node.expression).join(".") === "Reflect.apply" &&
      [...expressionPaths(node.arguments[0])].some((path) => callablePaths.has(path))
    ) {
      escapes.add(node);
    }
  });
  return [...escapes];
}

function authorityAliasEscapesContainingNamedRoots(root, sourceFile, names) {
  const protectedNames = new Set(names);
  return authorityAliasEscapeNodes(root, sourceFile, protectedNames).filter((escapeNode) => {
    let containsNamedRoot = false;
    visitNode(escapeNode, (node) => {
      if (ts.isIdentifier(node) && protectedNames.has(node.text)) {
        containsNamedRoot = true;
      }
    });
    return containsNamedRoot;
  });
}

function protectedStateMutationMultiset(sourceFile, stateNames) {
  const calls = [];
  visitNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const chain = staticAuthorityPath(node.expression, sourceFile) ?? [];
    if (chain.length === 2 && stateNames.has(chain[0]) && chain[1] !== "has") {
      calls.push(chain.join("."));
    }
  });
  return calls.sort();
}

function exactCanonicalSuiteFinalizerCallback(sourceFile) {
  const canonicalFile = ts.createSourceFile(
    "canonical-suite-finalizer-presence",
    canonicalSuiteFinalizerSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const afterCalls = (file) =>
    file.statements
      .filter(ts.isExpressionStatement)
      .map((statement) => statement.expression)
      .filter((expression) => isCallNamed(expression, "after"));
  const actual = afterCalls(sourceFile);
  const canonical = afterCalls(canonicalFile);
  return actual.length === 1 &&
    canonical.length === 1 &&
    actual[0].arguments.length === 1 &&
    astFingerprint(actual[0].arguments[0], sourceFile) ===
      astFingerprint(canonical[0].arguments[0], canonicalFile)
    ? actual[0].arguments[0]
    : undefined;
}

function hasExactCanonicalSuiteFinalizer(sourceFile) {
  return Boolean(exactCanonicalSuiteFinalizerCallback(sourceFile));
}

function resolvedStaticStringValue(node, sourceFile, depth = 0, seen = new Set()) {
  if (!node || depth > 12) return undefined;
  const expression = unparenthesizedExpression(node);
  const direct = staticStringValue(expression);
  if (direct !== undefined) return direct;
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    const bindings = sourceLevelBindingNodes(sourceFile, expression.text);
    if (bindings.length !== 1) return undefined;
    const declaration = bindings[0].parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.name !== bindings[0] ||
      !isConstVariableDeclaration(declaration) ||
      !declaration.initializer ||
      hasIdentifierReassignment(sourceFile, expression.text)
    ) {
      return undefined;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(expression.text);
    return resolvedStaticStringValue(declaration.initializer, sourceFile, depth + 1, nextSeen);
  }
  if (
    ts.isCallExpression(expression) &&
    propertyChain(expression.expression).join(".") === "Array.prototype.join.call"
  ) {
    return undefined;
  }
  return undefined;
}

function propertyNameStaticValue(name, sourceFile) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return resolvedStaticStringValue(name.expression, sourceFile);
  }
  return undefined;
}

function numericLiteralValue(node) {
  const expression = unparenthesizedExpression(node);
  if (ts.isNumericLiteral(expression)) return Number(expression.text.replaceAll("_", ""));
  return undefined;
}

function enclosingFunctionNode(node) {
  for (let current = node?.parent; current; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
  }
  return undefined;
}

function functionLikeName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return undefined;
}

function statementListLocation(node) {
  for (let current = node; current?.parent; current = current.parent) {
    const statements = current.parent.statements;
    if (statements && typeof statements.indexOf === "function") {
      const index = statements.indexOf(current);
      if (index >= 0) return { index, statement: current, statements };
    }
  }
  return undefined;
}

function canonicalSignalHelperSemanticSource(name) {
  return {
    captureStableProcessIdentity: [
      "function captureStableProcessIdentity(pid, expected) {",
      "  const first = readProcessIdentity(pid);",
      "  const second = readProcessIdentity(pid);",
      "  assert.ok(first && second, `process ${pid} was not live`);",
      "  assert.ok(sameProcessIdentity(first, second), `process ${pid} identity was unstable`);",
      "  if (expected) assert.ok(sameProcessIdentity(expected, first), `process ${pid} identity changed`);",
      "  return first;",
      "}",
    ].join("\n"),
    exactFilesystemIdentity: [
      "function exactFilesystemIdentity(metadata) {",
      "  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };",
      "}",
    ].join("\n"),
    readProcessGroupMembers: [
      "function readProcessGroupMembers(pgid) {",
      "  if (!Number.isSafeInteger(pgid) || pgid <= 0) {",
      '    throw new Error("Process-group membership subject is invalid");',
      "  }",
      '  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {',
      '    encoding: "utf8",',
      "    timeout: 1_000,",
      "  });",
      "  if (result.error || result.status !== 0) {",
      '    throw new Error("Process-group membership scan failed");',
      "  }",
      '  const lines = result.stdout.trim() ? result.stdout.trim().split("\\n") : [];',
      "  const members = lines.map((line) => {",
      "    const match = /^\\s*(\\d+)\\s+(\\d+)\\s*$/.exec(line);",
      '    if (!match) throw new Error("Process-group membership scan was ambiguous");',
      "    const pid = Number(match[1]);",
      "    const observedPgid = Number(match[2]);",
      "    if (",
      "      !Number.isSafeInteger(pid) ||",
      "      pid <= 0 ||",
      "      !Number.isSafeInteger(observedPgid) ||",
      "      observedPgid <= 0",
      "    ) {",
      '      throw new Error("Process-group membership scan contained invalid identities");',
      "    }",
      "    return { pgid: observedPgid, pid };",
      "  });",
      "  return members.filter((member) => member.pgid === pgid);",
      "}",
    ].join("\n"),
    readProcessDescriptorIdentity: [
      "function readProcessDescriptorIdentity(pid, descriptor) {",
      '  if (process.platform === "linux") {',
      "    try {",
      "      return exactFilesystemIdentity(statSync(`/proc/${pid}/fd/${descriptor}`, { bigint: true }));",
      "    } catch (error) {",
      '      if (error?.code === "ENOENT") return undefined;',
      "      throw error;",
      "    }",
      "  }",
      '  if (process.platform === "darwin") {',
      "    const result = spawnSync(",
      '      "/usr/sbin/lsof",',
      '      ["-a", "-n", "-P", "-p", String(pid), "-d", String(descriptor), "-F", "fDdit"],',
      '      { encoding: "utf8", timeout: 1_000 },',
      "    );",
      "    if (result.error) throw result.error;",
      "    if (!result.stdout.trim() && (result.status === 0 || result.status === 1)) return undefined;",
      '    if (result.status !== 0) throw new Error("Darwin descriptor identity is ambiguous");',
      '    const [processLine, ...lines] = result.stdout.trim().split("\\n");',
      "    if (processLine !== `p${pid}` || lines.some((line) => !/^[fDdit].+$/.test(line))) {",
      '      throw new Error("Darwin descriptor metadata is ambiguous");',
      "    }",
      "    const entries = lines.map((line) => [line[0], line.slice(1)]);",
      "    if (new Set(entries.map(([key]) => key)).size !== entries.length) {",
      '      throw new Error("Darwin descriptor metadata is ambiguous");',
      "    }",
      "    const fields = new Map(entries);",
      '    if (fields.get("f") !== String(descriptor)) {',
      '      throw new Error("Darwin descriptor metadata is ambiguous");',
      "    }",
      "    if (",
      "      lines.length === 4 &&",
      "      fields.size === 4 &&",
      '      fields.get("t") === "REG" &&',
      '      /^0x[0-9a-f]+$/i.test(fields.get("D") ?? "") &&',
      '      /^[0-9]+$/.test(fields.get("i") ?? "")',
      "    ) {",
      "      return {",
      '        dev: BigInt(fields.get("D")).toString(),',
      '        ino: BigInt(fields.get("i")).toString(),',
      "      };",
      "    }",
      "    if (",
      "      lines.length === 3 &&",
      "      fields.size === 3 &&",
      '      fields.get("t") === "unix" &&',
      '      /^0x[0-9a-f]+$/i.test(fields.get("d") ?? "")',
      "    ) {",
      '      return { dev: `unix:${fields.get("d").toLowerCase()}`, ino: "socket" };',
      "    }",
      '    throw new Error("Darwin descriptor metadata is ambiguous");',
      "  }",
      '  throw new Error("Stable descriptor identity is unsupported on this platform");',
      "}",
    ].join("\n"),
    readProcessIdentity: [
      "function readProcessIdentity(pid, timeoutMs = 1_000) {",
      "  const result = spawnSync(",
      '    "/bin/ps",',
      '    ["-ww", "-o", "pid=,ppid=,pgid=,sess=,uid=,lstart=,command=", "-p", String(pid)],',
      '    { encoding: "utf8", timeout: timeoutMs },',
      "  );",
      "  if (result.error) throw new Error(`Unable to inspect process ${pid}: ${result.error.message}`);",
      "  if (result.status !== 0 || !result.stdout.trim()) return undefined;",
      "  const parts = result.stdout.trim().split(/\\s+/);",
      "  if (parts.length < 11) throw new Error(`Process ${pid} identity is ambiguous`);",
      "  const numeric = parts.slice(0, 5).map((part) => Number(part));",
      "  if (numeric.some((value) => !Number.isSafeInteger(value) || value < 0)) {",
      "    throw new Error(`Process ${pid} identity has invalid numeric fields`);",
      "  }",
      '  const start = parts.slice(5, 10).join(" ");',
      "  if (!Number.isFinite(Date.parse(start))) throw new Error(`Process ${pid} start is ambiguous`);",
      "  return {",
      '    command: parts.slice(10).join(" "),',
      "    pgid: numeric[2],",
      "    pid: numeric[0],",
      "    ppid: numeric[1],",
      "    session: numeric[3],",
      "    start,",
      "    uid: numeric[4],",
      "  };",
      "}",
    ].join("\n"),
    readSemanticSessionObservation: [
      "function readSemanticSessionObservation(expectedIdentity) {",
      "  const before = readProcessIdentity(expectedIdentity.pid, 1_000);",
      "  assert.ok(",
      "    sameProcessIdentity(expectedIdentity, before),",
      '    "session observation subject changed before state read",',
      "  );",
      "  const result = spawnSync(",
      '    "/bin/ps",',
      '    ["-ww", "-o", "pid=,state=", "-p", String(expectedIdentity.pid)],',
      '    { encoding: "utf8", timeout: 1_000 },',
      "  );",
      '  assert.equal(result.error, undefined, "session state observation failed");',
      '  assert.equal(result.status, 0, "session state observation was not successful");',
      "  const match = /^\\s*(\\d+)\\s+(\\S+)\\s*$/.exec(result.stdout);",
      '  assert.ok(match, "session state observation was ambiguous");',
      '  assert.equal(Number(match[1]), expectedIdentity.pid, "session state PID changed");',
      "  const afterIdentity = readProcessIdentity(expectedIdentity.pid, 1_000);",
      "  assert.ok(",
      "    sameProcessIdentity(before, afterIdentity),",
      '    "session observation subject changed after state read",',
      "  );",
      "  return {",
      "    identity: afterIdentity,",
      "    pid: Number(match[1]),",
      "    platform: process.platform,",
      "    state: match[2],",
      "  };",
      "}",
    ].join("\n"),
    isSemanticSessionLeader: [
      "function isSemanticSessionLeader(observation) {",
      "  if (",
      "    !observation ||",
      "    observation.pid !== observation.identity?.pid ||",
      '    typeof observation.state !== "string"',
      "  ) {",
      "    return false;",
      "  }",
      '  if (observation.platform === "darwin") return observation.state.includes("s");',
      '  if (observation.platform === "linux") {',
      "    return observation.identity.session === observation.identity.pid;",
      "  }",
      "  return false;",
      "}",
    ].join("\n"),
    sameFilesystemIdentity:
      "function sameFilesystemIdentity(left, right) { return Boolean(left && right && left.dev === right.dev && left.ino === right.ino); }",
    sameProcessIdentity:
      "function sameProcessIdentity(left, right) { return Boolean(left && right && left.pid === right.pid && left.ppid === right.ppid && left.pgid === right.pgid && left.session === right.session && left.uid === right.uid && left.start === right.start && left.command === right.command); }",
  }[name];
}

function staticSignalMemberName(node, sourceFile) {
  const expression = unparenthesizedExpression(node);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    return resolvedStaticStringValue(expression.argumentExpression, sourceFile);
  }
  return undefined;
}

function isGlobalProcessMember(node, sourceFile) {
  const expression = unparenthesizedExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ["global", "globalThis"].includes(
        propertyChain(unparenthesizedExpression(expression.expression)).join("."),
      ) && expression.name.text === "process"
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    const member = resolvedStaticStringValue(expression.argumentExpression, sourceFile);
    return (
      ["global", "globalThis"].includes(
        propertyChain(unparenthesizedExpression(expression.expression)).join("."),
      ) &&
      (member === "process" || member === undefined)
    );
  }
  return false;
}

function nodeIsWithin(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function ignoredSignalFixtureText(node) {
  if (
    !ts.isStringLiteral(node) &&
    !ts.isNoSubstitutionTemplateLiteral(node) &&
    !ts.isTemplateExpression(node) &&
    !ts.isBinaryExpression(node)
  ) {
    return false;
  }
  const owner = enclosingFunctionNode(node);
  const name = owner ? functionLikeName(owner) : undefined;
  return Boolean(
    name &&
      (name.startsWith("canonical") ||
        name.startsWith("synthetic") ||
        name === "collectBlindSignalDiagnostics"),
  );
}

function embeddedTextLooksSignalExecutable(value) {
  return Boolean(
    typeof value === "string" &&
      value.length <= 100_000 &&
      /[;()={}[\]]/.test(value) &&
      (/(?:^|[\s;|&(){}])(?:kill|pkill)\s+-(?!0\s)[A-Za-z0-9]+\s+/i.test(value) ||
        /(?:^|[^\w])(?:process|child|wrapper|controller|globalThis(?:\s*\.\s*process)?)\s*(?:\.\s*kill|\[[^\]\r\n]{0,160}(?:kill|JSON\s*\.\s*parse)[^\]\r\n]*\])\s*(?:\?\.\s*)?\(/i.test(
          value,
        ) ||
        /\/(?:bin|usr\/bin)\/kill|(?:_linkedBinding|binding|getBuiltinModule)\s*\([^\r\n]{0,120}(?:spawn|child_process)/i.test(
          value,
        ) ||
        /(?:exec|execFile|spawn|spawnSync)\s*\([^;\r\n]{0,240}(?:\bkill\b|SIG(?:HUP|INT|KILL|TERM))/i.test(
          value,
        ) ||
        /Reflect\s*\.\s*(?:get|set|defineProperty)\s*\([^\r\n]{0,160}kill/i.test(value) ||
        /Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\([^\r\n]{0,160}kill/i.test(
          value,
        )),
  );
}

function canonicalProbeSignalSource() {
  return [
    "function pidExists(pid){",
    "try{process.kill(pid,0);return true}",
    'catch(error){if(error?.code==="ESRCH")return false;throw error}',
    "}",
    "function processGroupExists(pgid){",
    "try{process.kill(-pgid,0);return true}",
    'catch(error){if(error?.code==="ESRCH")return false;throw error}',
    "}",
  ].join("\n");
}

function killMemberNodes(root, sourceFile) {
  const members = [];
  visitNode(root, (node) => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ["_kill", "kill"].includes(staticSignalMemberName(node, sourceFile))
    ) {
      members.push(node);
    }
  });
  return members;
}

function abruptSignalAuthorization(sourceFile) {
  const target = uniqueTopLevelFunctionDeclaration(sourceFile, "runAbruptHarnessCrashCase");
  const canonicalFile = ts.createSourceFile(
    "canonical-abrupt-signal",
    syntheticAbruptHarnessProgram(undefined),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const canonicalTarget = uniqueTopLevelFunctionDeclaration(
    canonicalFile,
    "runAbruptHarnessCrashCase",
  );
  const canonicalFacadeFile = ts.createSourceFile(
    "canonical-full-abrupt-signal-carrier",
    canonicalExecutableFacadeProvenanceSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const canonicalFacadeTarget = uniqueTopLevelFunctionDeclaration(
    canonicalFacadeFile,
    "runAbruptHarnessCrashCase",
  );
  if (!target?.body || !canonicalTarget?.body || target.parameters.length !== 0) {
    return { allowedMember: undefined, exact: false };
  }
  const declarationNamed = (root, name) => {
    const declarations = [];
    visitNode(root, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        declarations.push(node);
      }
    });
    return declarations.length === 1 ? declarations[0] : undefined;
  };
  const actualRelation = declarationNamed(target, "assertRelation");
  const canonicalRelation = declarationNamed(canonicalTarget, "assertRelation");
  const actualMembers = killMemberNodes(target, sourceFile).filter(
    (member) =>
      ts.isCallExpression(member.parent) &&
      member.parent.expression === member &&
      propertyChain(member).join(".") === "process.kill" &&
      isStringLiteralValue(member.parent.arguments[1], "SIGKILL"),
  );
  const canonicalMembers = killMemberNodes(canonicalTarget, canonicalFile).filter(
    (member) =>
      ts.isCallExpression(member.parent) &&
      member.parent.expression === member &&
      propertyChain(member).join(".") === "process.kill" &&
      isStringLiteralValue(member.parent.arguments[1], "SIGKILL"),
  );
  if (
    !actualRelation ||
    !canonicalRelation ||
    actualMembers.length !== 1 ||
    canonicalMembers.length !== 1 ||
    astFingerprint(actualRelation, sourceFile) !== astFingerprint(canonicalRelation, canonicalFile)
  ) {
    return { allowedMember: actualMembers[0], exact: false };
  }
  const actualLocation = statementListLocation(actualMembers[0]);
  const canonicalLocation = statementListLocation(canonicalMembers[0]);
  if (
    !actualLocation ||
    !canonicalLocation ||
    actualLocation.index < 2 ||
    canonicalLocation.index < 2
  ) {
    return { allowedMember: actualMembers[0], exact: false };
  }
  const actualSequence = actualLocation.statements.slice(
    actualLocation.index - 2,
    actualLocation.index + 1,
  );
  const canonicalSequence = canonicalLocation.statements.slice(
    canonicalLocation.index - 2,
    canonicalLocation.index + 1,
  );
  const exactSequence =
    actualSequence.length === 3 &&
    canonicalSequence.length === 3 &&
    actualSequence.every(
      (statement, index) =>
        astFingerprint(statement, sourceFile) ===
        astFingerprint(canonicalSequence[index], canonicalFile),
    );
  const fingerprintStatements = (statements, containingFile) =>
    statements.map((statement) => astFingerprint(statement, containingFile));
  const matchesFingerprintSequence = (statements, containingFile, expected) =>
    JSON.stringify(fingerprintStatements(statements, containingFile)) === JSON.stringify(expected);
  const exactDirectCarrier = Boolean(
    actualLocation.statement.parent === target.body &&
      !isAsyncFunctionLike(target) &&
      actualLocation.index === canonicalLocation.index &&
      matchesFingerprintSequence(
        target.body.statements.slice(0, actualLocation.index + 1),
        sourceFile,
        fingerprintStatements(
          canonicalTarget.body.statements.slice(0, canonicalLocation.index + 1),
          canonicalFile,
        ),
      ),
  );
  const directTry = (functionNode) => {
    const tries = functionNode?.body?.statements.filter(ts.isTryStatement) ?? [];
    return tries.length === 1 ? tries[0] : undefined;
  };
  const canonicalFacadeTry = directTry(canonicalFacadeTarget);
  const actualKillBlock = actualLocation.statement.parent;
  const actualCarrierTry =
    ts.isBlock(actualKillBlock) &&
    ts.isTryStatement(actualKillBlock.parent) &&
    actualKillBlock.parent.tryBlock === actualKillBlock
      ? actualKillBlock.parent
      : undefined;
  const actualCarrierTryIndex = actualCarrierTry
    ? target.body.statements.indexOf(actualCarrierTry)
    : -1;
  const canonicalFacadeTryIndex = canonicalFacadeTry
    ? canonicalFacadeTarget.body.statements.indexOf(canonicalFacadeTry)
    : -1;
  const expectedFullBodyPredecessors =
    canonicalFacadeTryIndex >= 0
      ? fingerprintStatements(
          canonicalFacadeTarget.body.statements.slice(0, canonicalFacadeTryIndex),
          canonicalFacadeFile,
        )
      : undefined;
  const expectedFullTryPredecessors =
    canonicalFacadeTry?.tryBlock.statements.length > 0
      ? fingerprintStatements(canonicalFacadeTry.tryBlock.statements, canonicalFacadeFile)
      : undefined;
  const exactFullTryCarrier = Boolean(
    isAsyncFunctionLike(target) &&
      actualCarrierTry &&
      actualCarrierTry.parent === target.body &&
      !actualCarrierTry.catchClause &&
      actualCarrierTry.finallyBlock &&
      expectedFullBodyPredecessors &&
      expectedFullTryPredecessors &&
      actualCarrierTryIndex === expectedFullBodyPredecessors.length &&
      actualLocation.index === expectedFullTryPredecessors.length - 1 &&
      matchesFingerprintSequence(
        target.body.statements.slice(0, actualCarrierTryIndex),
        sourceFile,
        expectedFullBodyPredecessors,
      ) &&
      matchesFingerprintSequence(
        actualCarrierTry.tryBlock.statements.slice(0, actualLocation.index + 1),
        sourceFile,
        expectedFullTryPredecessors,
      ),
  );
  const unshadowed = [
    "assert",
    "captureStableProcessIdentity",
    "process",
    "processGroupExists",
    "readProcessDescriptorIdentity",
    "sameFilesystemIdentity",
  ].every((name) => !containsLocalBinding(target, name));
  return {
    allowedMember: actualMembers[0],
    exact: Boolean(
      exactSequence &&
        (exactDirectCarrier || exactFullTryCarrier) &&
        unshadowed &&
        !hasIdentifierReassignment(sourceFile, "assert") &&
        hasExactDefaultImport(sourceFile, "node:assert/strict", "assert"),
    ),
  };
}

function exactControllerBaselineDeclaration(sourceFile) {
  const registration = directNamedTestRegistration(
    sourceFile,
    "Red G rejects a mutated semantic session-leader observation",
    "HR browser harness contracts",
  );
  const callback = registration?.arguments.at(-1);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !isAsyncFunctionLike(callback) ||
    callback.parameters.length !== 0 ||
    !ts.isBlock(callback.body)
  ) {
    return undefined;
  }
  const declarations = directVariableDeclarations(callback.body, "controllerBaseline");
  if (declarations.length !== 1) return undefined;
  const [declaration] = declarations;
  const statement = declaration.parent?.parent;
  if (
    !isConstVariableDeclaration(declaration) ||
    !ts.isVariableStatement(statement) ||
    statement.parent !== callback.body ||
    namedBindingNodes(callback, "controllerBaseline").length !== 1 ||
    hasIdentifierReassignment(callback, "controllerBaseline")
  ) {
    return undefined;
  }
  const canonicalBaselineFile = ts.createSourceFile(
    "canonical-controller-baseline",
    "const controllerBaseline=Object.freeze({active:activeWrapperControllers.size,completed:completedWrapperControllers.length,descriptors:openWrapperOwnershipDescriptors.size,identities:recordedWrapperIdentities.length});",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const canonicalDeclaration = directVariableDeclarations(
    canonicalBaselineFile,
    "controllerBaseline",
  )[0];
  return canonicalDeclaration &&
    astFingerprint(declaration, sourceFile) ===
      astFingerprint(canonicalDeclaration, canonicalBaselineFile)
    ? declaration
    : undefined;
}

function exactOwnedControllerAuthority(sourceFile, canonicalCarrierFile) {
  const canonicalControllerFile = ts.createSourceFile(
    "canonical-owned-controller",
    [
      canonicalOwnedControllerEnvironmentSource(),
      "const activeWrapperControllers=new Set();",
      "const completedWrapperControllers=[];",
      "const openWrapperOwnershipDescriptors=new Set();",
      "const recordedWrapperIdentities=[];",
      canonicalSignalHelperSemanticSource("captureStableProcessIdentity"),
      canonicalProbeSignalSource(),
      canonicalOwnedControllerLifecycleSource(),
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const actualController = uniqueTopLevelFunctionDeclaration(
    sourceFile,
    "spawnOwnedWrapperController",
  );
  const canonicalController = uniqueTopLevelFunctionDeclaration(
    canonicalControllerFile,
    "spawnOwnedWrapperController",
  );
  const exactAuthorityHelper = (name) => {
    const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
    const canonical = uniqueTopLevelFunctionDeclaration(canonicalControllerFile, name);
    return Boolean(
      actual &&
        canonical &&
        sourceLevelBindingNodes(sourceFile, name).length === 1 &&
        !hasAuthorityMutation(sourceFile, name) &&
        astFingerprint(actual, sourceFile) === astFingerprint(canonical, canonicalControllerFile),
    );
  };
  const exactAuthorityState = (name) => {
    const actual = directVariableDeclarations(sourceFile, name);
    const canonical = directVariableDeclarations(canonicalControllerFile, name);
    return Boolean(
      actual.length === 1 &&
        canonical.length === 1 &&
        isConstVariableDeclaration(actual[0]) &&
        sourceLevelBindingNodes(sourceFile, name).length === 1 &&
        !hasAuthorityMutation(sourceFile, name) &&
        astFingerprint(actual[0], sourceFile) ===
          astFingerprint(canonical[0], canonicalControllerFile),
    );
  };
  const controllerHelpers = [
    "captureStableProcessIdentity",
    "createWrapperCloseDeadlineError",
    "exactFilesystemIdentity",
    "openOwnershipDescriptor",
    "ordinaryChildOutcome",
    "pidExists",
    "processGroupExists",
    "readProcessDescriptorIdentity",
    "readProcessIdentity",
    "retainExactWrapperIdentity",
    "sameFilesystemIdentity",
    "sameProcessIdentity",
    "settleControllerBefore",
    "spawnOwnedChild",
  ];
  const controllerStates = [
    "activeWrapperControllers",
    "completedWrapperControllers",
    "openWrapperOwnershipDescriptors",
    "recordedWrapperIdentities",
    "repositoryRoot",
    "withPostgres",
    "wrapperTemporaryRoot",
  ];
  const protectedGlobals = [
    "AggregateError",
    "Array",
    "Atomics",
    "BigInt",
    "Boolean",
    "Date",
    "Error",
    "Function",
    "Int32Array",
    "JSON",
    "Map",
    "Math",
    "Number",
    "Object",
    "Promise",
    "Proxy",
    "Reflect",
    "RegExp",
    "Set",
    "SharedArrayBuffer",
    "String",
    "URL",
    "clearTimeout",
    "global",
    "globalThis",
    "setTimeout",
  ];
  const protectedRoots = new Set([...controllerStates, "assert", "eval", "spawn", "spawnSync"]);
  const immutablePathStates = new Set(["repositoryRoot", "withPostgres", "wrapperTemporaryRoot"]);
  const callEscapeRoots = new Set(
    [...protectedRoots].filter((name) => !immutablePathStates.has(name)),
  );
  const mutableControllerStates = new Set([
    "activeWrapperControllers",
    "completedWrapperControllers",
    "openWrapperOwnershipDescriptors",
    "recordedWrapperIdentities",
  ]);
  const expectedStateMutations = protectedStateMutationMultiset(
    canonicalControllerFile,
    mutableControllerStates,
  );
  const exactSuiteFinalizerCallback = exactCanonicalSuiteFinalizerCallback(sourceFile);
  if (exactSuiteFinalizerCallback) {
    const canonicalFinalizerFile = ts.createSourceFile(
      "canonical-suite-finalizer-state-mutations",
      canonicalSuiteFinalizerSource(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    expectedStateMutations.push(
      ...protectedStateMutationMultiset(canonicalFinalizerFile, mutableControllerStates),
    );
    expectedStateMutations.sort();
  }
  const exactStateMutationMultiset =
    JSON.stringify(protectedStateMutationMultiset(sourceFile, mutableControllerStates)) ===
    JSON.stringify(expectedStateMutations);
  const exactController = Boolean(
    actualController &&
      canonicalController &&
      sourceLevelBindingNodes(sourceFile, "spawnOwnedWrapperController").length === 1 &&
      !hasIdentifierReassignment(sourceFile, "spawnOwnedWrapperController") &&
      astFingerprint(actualController, sourceFile) ===
        astFingerprint(canonicalController, canonicalControllerFile),
  );
  const exactCanonicalCarrierFunctions = [];
  const exactCanonicalCarrierStatements = [];
  if (canonicalCarrierFile) {
    for (const canonicalStatement of canonicalCarrierFile.statements) {
      if (ts.isFunctionDeclaration(canonicalStatement) && canonicalStatement.name) {
        const name = canonicalStatement.name.text;
        const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
        if (
          actual &&
          sourceLevelBindingNodes(sourceFile, name).length === 1 &&
          !hasAuthorityMutation(sourceFile, name) &&
          astFingerprint(actual, sourceFile) ===
            astFingerprint(canonicalStatement, canonicalCarrierFile)
        ) {
          exactCanonicalCarrierFunctions.push(actual);
        }
        continue;
      }
      const canonicalFingerprint = astFingerprint(canonicalStatement, canonicalCarrierFile);
      const matchingStatements = sourceFile.statements.filter(
        (statement) => astFingerprint(statement, sourceFile) === canonicalFingerprint,
      );
      let actualStatement = matchingStatements.length === 1 ? matchingStatements[0] : undefined;
      if (
        !actualStatement &&
        ts.isExpressionStatement(canonicalStatement) &&
        isCallNamed(canonicalStatement.expression, "describe") &&
        isStringLiteralValue(
          canonicalStatement.expression.arguments[0],
          "HR browser harness contracts",
        )
      ) {
        const isDeferredItStatement = (statement) => {
          if (!ts.isExpressionStatement(statement) || !isCallNamed(statement.expression, "it")) {
            return false;
          }
          const callback = statement.expression.arguments.at(-1);
          return Boolean(
            [2, 3].includes(statement.expression.arguments.length) &&
              (ts.isArrowFunction(callback) ||
                ts.isFunctionExpression(callback) ||
                ts.isIdentifier(callback)),
          );
        };
        const isDeferredItLoop = (statement) =>
          Boolean(
            ts.isForOfStatement(statement) &&
              !statement.awaitModifier &&
              ts.isVariableDeclarationList(statement.initializer) &&
              (statement.initializer.flags & ts.NodeFlags.Const) !== 0 &&
              statement.initializer.declarations.length === 1 &&
              ts.isArrayLiteralExpression(statement.expression) &&
              ts.isBlock(statement.statement) &&
              statement.statement.statements.length === 1 &&
              isDeferredItStatement(statement.statement.statements[0]),
          );
        const candidates = sourceFile.statements.filter((statement) => {
          if (
            !ts.isExpressionStatement(statement) ||
            !isCallNamed(statement.expression, "describe")
          ) {
            return false;
          }
          const callback = statement.expression.arguments[1];
          return Boolean(
            statement.expression.arguments.length === 2 &&
              isStringLiteralValue(
                statement.expression.arguments[0],
                "HR browser harness contracts",
              ) &&
              ts.isArrowFunction(callback) &&
              callback.parameters.length === 0 &&
              !isAsyncFunctionLike(callback) &&
              ts.isBlock(callback.body) &&
              callback.body.statements.every(
                (child) => isDeferredItStatement(child) || isDeferredItLoop(child),
              ),
          );
        });
        if (candidates.length === 1) actualStatement = candidates[0];
      }
      if (
        actualStatement &&
        ts.isVariableStatement(canonicalStatement) &&
        canonicalStatement.declarationList.declarations.length > 0 &&
        canonicalStatement.declarationList.declarations.every(
          (declaration) =>
            ts.isIdentifier(declaration.name) && isConstVariableDeclaration(declaration),
        ) &&
        canonicalStatement.declarationList.declarations.every(
          (declaration) =>
            sourceLevelBindingNodes(sourceFile, declaration.name.text).length === 1 &&
            !hasAuthorityMutation(sourceFile, declaration.name.text),
        )
      ) {
        exactCanonicalCarrierStatements.push(actualStatement);
        continue;
      }
      if (
        actualStatement &&
        ts.isExpressionStatement(canonicalStatement) &&
        isCallNamed(canonicalStatement.expression, "describe") &&
        canonicalStatement.expression.arguments.length === 2 &&
        isStringLiteralValue(
          canonicalStatement.expression.arguments[0],
          "HR browser harness contracts",
        ) &&
        hasClosedUnaliasedNamedImportSet(sourceFile, "node:test", ["after", "describe", "it"]) &&
        ["after", "describe", "it"].every(
          (name) =>
            sourceLevelBindingNodes(sourceFile, name).length === 1 &&
            !hasAuthorityMutation(sourceFile, name),
        )
      ) {
        exactCanonicalCarrierStatements.push(actualStatement);
      }
    }
  }
  const cooperativeCanonicalFile = ts.createSourceFile(
    "canonical-cooperative-authority-subtrees",
    canonicalCooperativeFixtureAcquisitionSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const exactCooperativeAuthorityFunctions = cooperativeCanonicalFile.statements
    .filter(ts.isFunctionDeclaration)
    .flatMap((canonical) => {
      const name = canonical.name?.text;
      const actual = name ? uniqueTopLevelFunctionDeclaration(sourceFile, name) : undefined;
      return actual &&
        name &&
        sourceLevelBindingNodes(sourceFile, name).length === 1 &&
        !hasAuthorityMutation(sourceFile, name) &&
        astFingerprint(actual, sourceFile) === astFingerprint(canonical, cooperativeCanonicalFile)
        ? [actual]
        : [];
    });
  const controllerBaselineDeclaration = exactControllerBaselineDeclaration(sourceFile);
  const exactAuthoritySubtrees = [
    ...(exactController ? [actualController] : []),
    ...controllerHelpers
      .filter((name) => exactAuthorityHelper(name))
      .map((name) => uniqueTopLevelFunctionDeclaration(sourceFile, name)),
    ...exactCanonicalCarrierFunctions,
    ...exactCanonicalCarrierStatements,
    ...exactCooperativeAuthorityFunctions,
    ...(exactSuiteFinalizerCallback ? [exactSuiteFinalizerCallback] : []),
    ...(controllerBaselineDeclaration ? [controllerBaselineDeclaration] : []),
  ].filter(Boolean);
  const controllerAuthorityExact =
    controllerHelpers.every(exactAuthorityHelper) &&
    controllerStates.every(exactAuthorityState) &&
    hasClosedChildProcessImportSet(sourceFile, ["spawn", "spawnSync"]) &&
    [
      ["node:child_process", "spawn"],
      ["node:child_process", "spawnSync"],
      ["node:crypto", "randomUUID"],
      ["node:fs", "closeSync"],
      ["node:fs", "fstatSync"],
      ["node:fs", "openSync"],
      ["node:fs", "statSync"],
      ["node:fs", "unlinkSync"],
      ["node:fs/promises", "mkdtemp"],
      ["node:path", "join"],
      ["node:path", "resolve"],
      ["node:url", "fileURLToPath"],
    ].every(
      ([moduleName, importedName]) =>
        hasExactUnaliasedNamedImport(sourceFile, moduleName, importedName) &&
        !hasAuthorityMutation(sourceFile, importedName),
    ) &&
    hasExactDefaultImport(sourceFile, "node:assert/strict", "assert") &&
    !hasAuthorityMutation(sourceFile, "assert") &&
    sourceLevelBindingNodes(sourceFile, "process").length === 0 &&
    namedBindingNodes(sourceFile, "process").length === 0 &&
    !hasDirectIdentifierReassignment(sourceFile, "process") &&
    protectedGlobals.every(
      (name) =>
        sourceLevelBindingNodes(sourceFile, name).length === 0 &&
        namedBindingNodes(sourceFile, name).length === 0 &&
        !hasAuthorityMutation(sourceFile, name),
    ) &&
    capabilityAliasEscapeNodes(
      sourceFile,
      sourceFile,
      signalCapabilityAliasPathValues(),
      evaluatorCapabilityPathValues(),
      [...new Set(exactAuthoritySubtrees)],
    ).length === 0 &&
    authorityAliasEscapeNodes(sourceFile, sourceFile, protectedRoots, callEscapeRoots, [
      ...new Set(exactAuthoritySubtrees),
    ]).length === 0 &&
    exactStateMutationMultiset;
  return {
    actualController,
    canonicalController,
    canonicalControllerFile,
    exact: Boolean(controllerAuthorityExact && exactController),
  };
}

function collectBlindSignalDiagnostics(sourceText, label, facadeMode) {
  const sourceFile = ts.createSourceFile(
    label,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) return [`${label}:1:parse-error`];

  const diagnostics = [];
  const fullFacadeSurface = facadeMode === "full";
  const canonicalFacadeFile = ts.createSourceFile(
    "canonical-executable-facade-provenance",
    canonicalExecutableFacadeProvenanceSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const diagnosticKeys = new Set();
  const addDiagnostic = (node, category) => {
    const line = node ? sourceLine(sourceFile, node) : 1;
    const value = `${label}:${line}:${category}`;
    if (!diagnosticKeys.has(value)) {
      diagnosticKeys.add(value);
      diagnostics.push(value);
    }
  };

  const allKillMembers = killMemberNodes(sourceFile, sourceFile);
  const allowedMembers = new Set();
  const processBindings = new Set([
    ...sourceLevelBindingNodes(sourceFile, "process"),
    ...namedBindingNodes(sourceFile, "process"),
  ]);
  if (processBindings.size > 0 || hasDirectIdentifierReassignment(sourceFile, "process")) {
    addDiagnostic([...processBindings][0], "process-binding-shadow");
  }

  const canonicalProbeFile = ts.createSourceFile(
    "canonical-signal-probes",
    canonicalProbeSignalSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  for (const name of ["pidExists", "processGroupExists"]) {
    const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
    const canonical = uniqueTopLevelFunctionDeclaration(canonicalProbeFile, name);
    if (
      actual &&
      canonical &&
      sourceLevelBindingNodes(sourceFile, name).length === 1 &&
      !hasIdentifierReassignment(sourceFile, name) &&
      astFingerprint(actual, sourceFile) === astFingerprint(canonical, canonicalProbeFile)
    ) {
      for (const member of allKillMembers) {
        if (nodeIsWithin(member, actual)) allowedMembers.add(member);
      }
    }
  }

  const controllerAuthority = exactOwnedControllerAuthority(
    sourceFile,
    fullFacadeSurface ? canonicalFacadeFile : undefined,
  );
  const actualController = controllerAuthority.actualController;
  const cooperativeCanonicalFile = ts.createSourceFile(
    "canonical-cooperative-signal-owner",
    canonicalCooperativeFixtureAcquisitionSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const actualCooperativeSpawn = uniqueTopLevelFunctionDeclaration(
    sourceFile,
    "spawnCooperativeFixture",
  );
  const canonicalCooperativeSpawn = uniqueTopLevelFunctionDeclaration(
    cooperativeCanonicalFile,
    "spawnCooperativeFixture",
  );
  const exactCooperativeSpawn = Boolean(
    actualCooperativeSpawn &&
      canonicalCooperativeSpawn &&
      sourceLevelBindingNodes(sourceFile, "spawnCooperativeFixture").length === 1 &&
      !hasAuthorityMutation(sourceFile, "spawnCooperativeFixture") &&
      astFingerprint(actualCooperativeSpawn, sourceFile) ===
        astFingerprint(canonicalCooperativeSpawn, cooperativeCanonicalFile),
  );
  const malformedTarget = uniqueTopLevelFunctionDeclaration(
    sourceFile,
    "runMalformedCancellationIsolationCase",
  );
  const malformedSourceDeclarations = [];
  if (malformedTarget) {
    visitNode(malformedTarget, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "source"
      ) {
        malformedSourceDeclarations.push(node);
      }
    });
  }
  const exactMalformedSourceDeclaration =
    malformedTarget &&
    malformedSourceDeclarations.length === 1 &&
    exactMalformedProgramSourceDeclaration(malformedTarget, sourceFile)
      ? malformedSourceDeclarations[0]
      : undefined;
  if (!controllerAuthority.exact) {
    addDiagnostic(undefined, "signal-helper-provenance");
  }
  if (controllerAuthority.exact && actualController) {
    for (const member of allKillMembers) {
      if (nodeIsWithin(member, actualController)) allowedMembers.add(member);
    }
  }

  const abrupt = abruptSignalAuthorization(sourceFile);
  if (controllerAuthority.exact && abrupt.exact && abrupt.allowedMember) {
    allowedMembers.add(abrupt.allowedMember);
  }

  const exactCanonicalFunctionOwner = (owner, name, canonicalSource) => {
    if (!owner || functionLikeName(owner) !== name || !canonicalSource) return false;
    const canonicalFile = ts.createSourceFile(
      "canonical-external-owner-" + name,
      canonicalSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
    const canonical = uniqueTopLevelFunctionDeclaration(canonicalFile, name);
    return Boolean(
      actual === owner &&
        canonical &&
        sourceLevelBindingNodes(sourceFile, name).length === 1 &&
        !hasAuthorityMutation(sourceFile, name) &&
        astFingerprint(actual, sourceFile) === astFingerprint(canonical, canonicalFile),
    );
  };
  const exactExternalProbeOwner = (owner) => {
    const name = owner ? functionLikeName(owner) : undefined;
    if (
      [
        "readProcessDescriptorIdentity",
        "readProcessGroupMembers",
        "readProcessIdentity",
        "readSemanticSessionObservation",
      ].includes(name)
    ) {
      return exactCanonicalFunctionOwner(owner, name, canonicalSignalHelperSemanticSource(name));
    }
    if (name === "assertNoOwnedResidue") {
      return exactCanonicalFunctionOwner(
        owner,
        name,
        canonicalCleanupResidueAuthoritySource(false),
      );
    }
    return false;
  };
  const executableFacadeNames = new Set([
    "spawnOwnedWrapperController",
    "spawnPostgresWrapper",
    "spawnSupervisedPostgresWrapper",
  ]);
  const allowedFacadeCalls = new Set();
  const allowedFacadeCarrierNodes = new Set();
  const canonicalFacadeDefinitionsFile = ts.createSourceFile(
    "canonical-executable-facade-definitions",
    canonicalExecutableFacadeDefinitionsSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const exactFacadeDefinitions = ["spawnPostgresWrapper", "spawnSupervisedPostgresWrapper"].every(
    (name) => {
      const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
      const canonical = uniqueTopLevelFunctionDeclaration(canonicalFacadeDefinitionsFile, name);
      return Boolean(
        actual &&
          canonical &&
          sourceLevelBindingNodes(sourceFile, name).length === 1 &&
          namedBindingNodes(sourceFile, name).length === 1 &&
          !hasAuthorityMutation(sourceFile, name) &&
          astFingerprint(actual, sourceFile) ===
            astFingerprint(canonical, canonicalFacadeDefinitionsFile),
      );
    },
  );
  const templateTitleMatches = (node, expressionSource, containingFile = sourceFile) => {
    const expectedFile = ts.createSourceFile(
      "canonical-executable-facade-title",
      `const title=${expressionSource};`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const expected = directVariableDeclarations(expectedFile, "title")[0]?.initializer;
    return Boolean(
      expected && astFingerprint(node, containingFile) === astFingerprint(expected, expectedFile),
    );
  };
  const executableFacadeOwnerKey = (call, containingFile = sourceFile) => {
    const owner = enclosingFunctionNode(call);
    const ownerName = owner ? functionLikeName(owner) : undefined;
    if (ownerName) return ownerName;
    for (let current = call.parent; current; current = current.parent) {
      if (!isCallNamed(current, "it")) continue;
      const callback = current.arguments.at(-1);
      if (!callback || !nodeIsWithin(call, callback)) continue;
      const title = current.arguments[0];
      if (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) {
        return `test:${title.text}`;
      }
      if (
        templateTitleMatches(
          title,
          "`forwards ${signal}, drains the complete child group, and preserves signal exit semantics`",
          containingFile,
        )
      ) {
        return "test-template:forwarded-signal";
      }
      if (
        templateTitleMatches(
          title,
          "`cancels a real BrowserServer launch before registration on ${signal}`",
          containingFile,
        )
      ) {
        return "test-template:pre-registration-signal";
      }
      return undefined;
    }
    return undefined;
  };
  const variableStatementForDeclaration = (declaration) =>
    ts.isVariableDeclarationList(declaration?.parent) &&
    ts.isVariableStatement(declaration.parent.parent)
      ? declaration.parent.parent
      : undefined;
  const ownerScopedBinding = (owner, name) => {
    const bindings = [];
    const visit = (node) => {
      if (
        node !== owner &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node))
      ) {
        return;
      }
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        bindingNameNodes(node.name, name).length > 0
      ) {
        bindings.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(owner);
    const unique = [...new Set(bindings)];
    if (unique.length === 0) return { kind: "external" };
    if (unique.length !== 1) return { kind: "ambiguous" };
    return {
      binding: unique[0],
      kind: ts.isParameter(unique[0]) ? "parameter" : "variable",
      name,
    };
  };
  const isValueIdentifierReference = (node) => {
    if (!ts.isIdentifier(node)) return false;
    const parent = node.parent;
    if (!parent) return false;
    if (
      ((ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent)) &&
        parent.name === node) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isPropertyDeclaration(parent)) &&
        parent.name === node &&
        !ts.isComputedPropertyName(parent.name)) ||
      (ts.isLabeledStatement(parent) && parent.label === node) ||
      ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)
    ) {
      return false;
    }
    return true;
  };
  const executableFacadeCarrierStatements = (call) => {
    const argumentsExpression = unparenthesizedExpression(call.arguments[1]);
    if (
      !argumentsExpression ||
      !ts.isArrayLiteralExpression(argumentsExpression) ||
      !isStringLiteralValue(argumentsExpression.elements[0], "-e")
    ) {
      return [];
    }
    const program = argumentsExpression.elements[1];
    if (
      isStringLiteralValue(program, "process.exit(0)") ||
      isStringLiteralValue(program, "process.exit(7)")
    ) {
      return [{ controlPath: [], node: program }];
    }
    const owner = enclosingFunctionNode(call);
    if (!owner || !ts.isIdentifier(program)) return undefined;
    const carrierEntries = new Map();
    const carrierControlPath = (statement) => {
      let currentStatement = statement;
      let container = statement.parent;
      const path = [];
      while (true) {
        if (!ts.isBlock(container)) return undefined;
        const statementIndex = container.statements.indexOf(currentStatement);
        if (statementIndex < 0) return undefined;
        path.push({
          predecessorControls: container.statements
            .slice(0, statementIndex)
            .map((candidate) => astFingerprint(candidate, statement.getSourceFile())),
          tryShell:
            container === owner.body
              ? null
              : (() => {
                  const tryStatement = container.parent;
                  if (!ts.isTryStatement(tryStatement) || tryStatement.tryBlock !== container) {
                    return undefined;
                  }
                  return {
                    catchBinding: tryStatement.catchClause?.variableDeclaration
                      ? astFingerprint(
                          tryStatement.catchClause.variableDeclaration.name,
                          statement.getSourceFile(),
                        )
                      : null,
                    hasCatch: Boolean(tryStatement.catchClause),
                    hasFinally: Boolean(tryStatement.finallyBlock),
                  };
                })(),
        });
        if (container === owner.body) return path;
        if (path.at(-1).tryShell === undefined || !ts.isTryStatement(container.parent)) {
          return undefined;
        }
        currentStatement = container.parent;
        container = container.parent.parent;
      }
    };
    const retainCarrierStatement = (statement) => {
      const controlPath = carrierControlPath(statement);
      if (!controlPath) return false;
      carrierEntries.set(statement, { controlPath, node: statement });
      return true;
    };
    const resolvedBindings = new Set();
    const resolvingBindings = new Set();
    const retainValueReferences = (expression, consumerNode) => {
      let exact = true;
      visitNode(expression, (node) => {
        if (!isValueIdentifierReference(node)) return;
        const dependency = ownerScopedBinding(owner, node.text);
        if (dependency.kind === "external") return;
        if (dependency.kind === "ambiguous" || !retainCarrierBinding(dependency, consumerNode)) {
          exact = false;
        }
      });
      return exact;
    };
    const ownerScopedMutationNodes = (name) => {
      const mutations = [];
      const visit = (node) => {
        if (
          node !== owner &&
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isClassExpression(node))
        ) {
          return;
        }
        if (
          (ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            assignmentTargetContainsName(node.left, name)) ||
          ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
            assignmentTargetContainsName(node.operand, name))
        ) {
          mutations.push(node);
          return;
        }
        if (ts.isDeleteExpression(node) && assignmentTargetContainsName(node.expression, name)) {
          mutations.push(node);
          return;
        }
        if (ts.isCallExpression(node)) {
          const containingFile = node.getSourceFile();
          const calleePath = staticAuthorityPath(node.expression, containingFile) ?? [];
          const callee = calleePath.join(".");
          const targetChain =
            staticAuthorityPath(unparenthesizedExpression(node.arguments[0]), containingFile) ?? [];
          const receiverChain = calleePath.slice(0, -1);
          if (
            ([
              "Object.assign",
              "Object.defineProperties",
              "Object.defineProperty",
              "Object.setPrototypeOf",
              "Reflect.defineProperty",
              "Reflect.deleteProperty",
              "Reflect.set",
              "Reflect.setPrototypeOf",
            ].includes(callee) &&
              targetChain[0] === name) ||
            (["__defineGetter__", "__defineSetter__"].includes(calleePath.at(-1)) &&
              receiverChain[0] === name)
          ) {
            mutations.push(node);
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(owner);
      return mutations;
    };
    const retainCarrierBinding = (resolved, consumerNode) => {
      if (resolved.kind === "parameter") {
        return ownerScopedMutationNodes(resolved.name).length === 0;
      }
      if (resolved.kind !== "variable" || !resolved.binding) return false;
      const declaration = resolved.binding;
      if (resolvedBindings.has(declaration)) return true;
      if (resolvingBindings.has(declaration)) return false;
      const declarationStatement = variableStatementForDeclaration(declaration);
      if (
        !declarationStatement ||
        enclosingFunctionNode(declarationStatement) !== owner ||
        declarationStatement.getStart(declarationStatement.getSourceFile()) >=
          consumerNode.getStart(consumerNode.getSourceFile())
      ) {
        return false;
      }
      resolvingBindings.add(declaration);
      if (!retainCarrierStatement(declarationStatement)) {
        resolvingBindings.delete(declaration);
        return false;
      }
      let exact = false;
      if (declaration.initializer) {
        exact =
          isConstVariableDeclaration(declaration) &&
          ownerScopedMutationNodes(resolved.name).length === 0 &&
          retainValueReferences(declaration.initializer, declaration);
      } else if (ts.isIdentifier(declaration.name)) {
        const producers = ownerScopedMutationNodes(declaration.name.text);
        const producer = producers.length === 1 ? producers[0] : undefined;
        const producerLocation = producer ? statementListLocation(producer) : undefined;
        exact = Boolean(
          producer &&
            ts.isBinaryExpression(producer) &&
            producer.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(unparenthesizedExpression(producer.left)) &&
            unparenthesizedExpression(producer.left).text === declaration.name.text &&
            producerLocation &&
            ts.isExpressionStatement(producerLocation.statement) &&
            producerLocation.statement.expression === producer &&
            enclosingFunctionNode(producerLocation.statement) === owner &&
            producerLocation.statement.getStart(producerLocation.statement.getSourceFile()) <
              consumerNode.getStart(consumerNode.getSourceFile()),
        );
        if (exact) {
          exact =
            retainCarrierStatement(producerLocation.statement) &&
            retainValueReferences(producer.right, producer);
        }
      }
      resolvingBindings.delete(declaration);
      if (exact) resolvedBindings.add(declaration);
      return exact;
    };
    const rootBinding = ownerScopedBinding(owner, program.text);
    if (rootBinding.kind !== "variable" || !retainCarrierBinding(rootBinding, call)) {
      return undefined;
    }
    return [...carrierEntries.values()].sort(
      (left, right) =>
        left.node.getStart(left.node.getSourceFile()) -
        right.node.getStart(right.node.getSourceFile()),
    );
  };
  const facadeExpressionFingerprint = (expressionSource) => {
    const contractFile = ts.createSourceFile(
      "canonical-executable-facade-call",
      `function contract(){${expressionSource};}`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const calls = [];
    visitNode(contractFile, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        executableFacadeNames.has(node.expression.text)
      ) {
        calls.push(node);
      }
    });
    return calls.length === 1 ? astFingerprint(calls[0], contractFile) : undefined;
  };
  const isClosedStaticRegistrationValue = (node) => {
    const value = unparenthesizedExpression(node);
    return Boolean(
      value &&
        (ts.isStringLiteral(value) ||
          ts.isNoSubstitutionTemplateLiteral(value) ||
          ts.isNumericLiteral(value) ||
          [
            ts.SyntaxKind.TrueKeyword,
            ts.SyntaxKind.FalseKeyword,
            ts.SyntaxKind.NullKeyword,
          ].includes(value.kind) ||
          (ts.isArrayLiteralExpression(value) &&
            value.elements.every(
              (element) => !ts.isSpreadElement(element) && isClosedStaticRegistrationValue(element),
            ))),
    );
  };
  const isClosedRegistrationTitle = (node) => {
    const title = unparenthesizedExpression(node);
    return Boolean(
      title &&
        (ts.isStringLiteral(title) ||
          ts.isNoSubstitutionTemplateLiteral(title) ||
          (ts.isTemplateExpression(title) &&
            title.templateSpans.every((span) =>
              ts.isIdentifier(unparenthesizedExpression(span.expression)),
            ))),
    );
  };
  const isDeferredTestRegistration = (statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const registration = unparenthesizedExpression(statement.expression);
    if (
      !isCallNamed(registration, "it") ||
      ![2, 3].includes(registration.arguments.length) ||
      !isClosedRegistrationTitle(registration.arguments[0])
    ) {
      return false;
    }
    const callback = registration.arguments.at(-1);
    if (
      !(
        ts.isArrowFunction(callback) ||
        ts.isFunctionExpression(callback) ||
        ts.isIdentifier(callback)
      )
    ) {
      return false;
    }
    if (registration.arguments.length === 2) return true;
    const options = unparenthesizedExpression(registration.arguments[1]);
    return Boolean(
      options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.every(
          (property) =>
            ts.isPropertyAssignment(property) &&
            !ts.isComputedPropertyName(property.name) &&
            isClosedStaticRegistrationValue(property.initializer),
        ),
    );
  };
  const isClosedRegistrationBinding = (name) =>
    ts.isIdentifier(name) ||
    (ts.isArrayBindingPattern(name) &&
      name.elements.every(
        (element) =>
          ts.isBindingElement(element) &&
          !element.dotDotDotToken &&
          !element.initializer &&
          isClosedRegistrationBinding(element.name),
      ));
  const isDeferredRegistrationLoop = (statement) =>
    Boolean(
      ts.isForOfStatement(statement) &&
        !statement.awaitModifier &&
        ts.isVariableDeclarationList(statement.initializer) &&
        (statement.initializer.flags & ts.NodeFlags.Const) !== 0 &&
        statement.initializer.declarations.length === 1 &&
        isClosedRegistrationBinding(statement.initializer.declarations[0].name) &&
        isClosedStaticRegistrationValue(statement.expression) &&
        ts.isBlock(statement.statement) &&
        statement.statement.statements.length === 1 &&
        isDeferredTestRegistration(statement.statement.statements[0]),
    );
  const isProcessTerminationCall = (node, containingFile) =>
    ts.isCallExpression(node) &&
    ["process.exit", "process.abort"].includes(
      (staticAuthorityPath(node.expression, containingFile) ?? []).join("."),
    );
  const isNeverSettlingPromiseAwait = (node) => {
    if (!ts.isAwaitExpression(node)) return false;
    const awaited = unparenthesizedExpression(node.expression);
    if (
      !ts.isNewExpression(awaited) ||
      !ts.isIdentifier(unparenthesizedExpression(awaited.expression)) ||
      unparenthesizedExpression(awaited.expression).text !== "Promise"
    ) {
      return false;
    }
    const executor = awaited.arguments?.[0];
    if (!(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return false;
    const settlers = new Set(
      executor.parameters
        .slice(0, 2)
        .filter((parameter) => ts.isIdentifier(parameter.name))
        .map((parameter) => parameter.name.text),
    );
    if (settlers.size === 0) return true;
    let settlementEdge = false;
    visitNode(executor.body, (candidate) => {
      if (
        settlementEdge ||
        !ts.isIdentifier(candidate) ||
        !settlers.has(candidate.text) ||
        !isValueIdentifierReference(candidate)
      ) {
        return;
      }
      const parent = candidate.parent;
      const receiver =
        ts.isPropertyAccessExpression(parent) && parent.expression === candidate
          ? parent
          : candidate;
      const invocation = receiver.parent;
      settlementEdge = Boolean(
        (ts.isCallExpression(invocation) &&
          (invocation.expression === receiver ||
            invocation.arguments.some(
              (argument) => unparenthesizedExpression(argument) === candidate,
            ))) ||
          (ts.isNewExpression(invocation) &&
            invocation.arguments?.some(
              (argument) => unparenthesizedExpression(argument) === candidate,
            )),
      );
    });
    return !settlementEdge;
  };
  const inlineFunctionAtInvocationTarget = (node) => {
    const target = unparenthesizedExpression(node);
    if (!target) return undefined;
    if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return target;
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return inlineFunctionAtInvocationTarget(target.right);
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      ["call", "apply", "bind"].includes(target.name.text)
    ) {
      return inlineFunctionAtInvocationTarget(target.expression);
    }
    if (
      ts.isCallExpression(target) &&
      ts.isPropertyAccessExpression(unparenthesizedExpression(target.expression)) &&
      unparenthesizedExpression(target.expression).name.text === "bind"
    ) {
      return inlineFunctionAtInvocationTarget(
        unparenthesizedExpression(target.expression).expression,
      );
    }
    return undefined;
  };
  const immediatelyInvokedInlineFunction = (node, containingFile) => {
    if (ts.isCallExpression(node)) {
      const path = (staticAuthorityPath(node.expression, containingFile) ?? []).join(".");
      if (["Reflect.apply", "Reflect.construct"].includes(path)) {
        return inlineFunctionAtInvocationTarget(node.arguments[0]);
      }
      return inlineFunctionAtInvocationTarget(node.expression);
    }
    if (ts.isNewExpression(node)) return inlineFunctionAtInvocationTarget(node.expression);
    if (ts.isTaggedTemplateExpression(node)) return inlineFunctionAtInvocationTarget(node.tag);
    return undefined;
  };
  const inlineFunctionHasHardBarrier = (owner, containingFile) => {
    let found = false;
    const scan = (node) => {
      if (found) return;
      if (
        node !== owner.body &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node))
      ) {
        return;
      }
      if (
        ts.isThrowStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        isProcessTerminationCall(node, containingFile) ||
        isNeverSettlingPromiseAwait(node)
      ) {
        found = true;
        return;
      }
      const invoked = immediatelyInvokedInlineFunction(node, containingFile);
      if (invoked && inlineFunctionHasHardBarrier(invoked, containingFile)) {
        found = true;
        return;
      }
      ts.forEachChild(node, scan);
    };
    scan(owner.body);
    return found;
  };
  const genuineExecutionBarrierFingerprint = (statement, containingFile) => {
    if (
      isDeferredTestRegistration(statement) ||
      isDeferredRegistrationLoop(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement)
    ) {
      return undefined;
    }
    let barrier;
    const scan = (node) => {
      if (barrier) return;
      if (
        node !== statement &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node))
      ) {
        return;
      }
      if (
        ts.isReturnStatement(node) ||
        ts.isThrowStatement(node) ||
        ts.isBreakStatement(node) ||
        ts.isContinueStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        isProcessTerminationCall(node, containingFile) ||
        isNeverSettlingPromiseAwait(node)
      ) {
        barrier = node;
        return;
      }
      const invoked = immediatelyInvokedInlineFunction(node, containingFile);
      if (invoked && inlineFunctionHasHardBarrier(invoked, containingFile)) {
        barrier = node;
        return;
      }
      ts.forEachChild(node, scan);
    };
    scan(statement);
    return barrier ? astFingerprint(barrier, containingFile) : undefined;
  };
  const genuineExecutionBarrierFingerprints = (statements, containingFile) =>
    statements
      .map((statement) => genuineExecutionBarrierFingerprint(statement, containingFile))
      .filter((fingerprint) => fingerprint !== undefined);
  const precedingExecutionBarrierFingerprints = (statement, containingFile) => {
    const block = statement?.parent;
    if (!ts.isBlock(block)) return undefined;
    const index = block.statements.indexOf(statement);
    if (index < 0) return undefined;
    return genuineExecutionBarrierFingerprints(block.statements.slice(0, index), containingFile);
  };
  const facadeCallControl = (call, containingFile = sourceFile) => {
    const owner = enclosingFunctionNode(call);
    const location = statementListLocation(call);
    if (!owner?.body || !ts.isBlock(owner.body) || !location) return undefined;
    let statement = location.statement;
    let container = statement.parent;
    let protectedTryDepth = 0;
    const controlPath = [];
    while (true) {
      if (!ts.isBlock(container)) return undefined;
      const statementIndex = container.statements.indexOf(statement);
      if (statementIndex < 0) return undefined;
      const predecessorControls = genuineExecutionBarrierFingerprints(
        container.statements.slice(0, statementIndex),
        containingFile,
      );
      if (container === owner.body) {
        controlPath.push({ predecessorControls, tryShell: null });
        break;
      }
      const tryStatement = container.parent;
      if (
        !ts.isTryStatement(tryStatement) ||
        tryStatement.tryBlock !== container ||
        !ts.isBlock(tryStatement.parent)
      ) {
        return undefined;
      }
      protectedTryDepth += 1;
      controlPath.push({
        predecessorControls,
        tryShell: {
          catchBinding: tryStatement.catchClause?.variableDeclaration
            ? astFingerprint(tryStatement.catchClause.variableDeclaration.name, containingFile)
            : null,
          hasCatch: Boolean(tryStatement.catchClause),
          hasFinally: Boolean(tryStatement.finallyBlock),
        },
      });
      statement = tryStatement;
      container = tryStatement.parent;
    }
    return {
      controlPath,
      protectedTryDepth,
      statement: location.statement,
      statementKind: ts.isVariableStatement(location.statement)
        ? "VariableStatement"
        : ts.isExpressionStatement(location.statement)
          ? "ExpressionStatement"
          : ts.isReturnStatement(location.statement)
            ? "ReturnStatement"
            : ts.SyntaxKind[location.statement.kind],
    };
  };
  const facadeRegistrationEnvelope = (registration, containingFile) => {
    if (!registration || !isCallNamed(registration, "it") || registration.arguments.length < 2) {
      return undefined;
    }
    const callback = registration.arguments.at(-1);
    if (
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !ts.isBlock(callback.body)
    ) {
      return undefined;
    }
    return {
      argumentCount: registration.arguments.length,
      callbackAsync: isAsyncFunctionLike(callback),
      callbackGenerator: Boolean(callback.asteriskToken),
      callbackKind: callback.kind,
      callbackParameters: callback.parameters.map((parameter) =>
        astFingerprint(parameter, containingFile),
      ),
      registrationBarriers: precedingExecutionBarrierFingerprints(
        registration.parent,
        containingFile,
      ),
      registrationArguments: registration.arguments
        .slice(0, -1)
        .map((argument) => astFingerprint(argument, containingFile)),
    };
  };
  const facadeRegistrationEnvelopesMatch = (actualRegistration, canonicalRegistration) => {
    const actual = facadeRegistrationEnvelope(actualRegistration, sourceFile);
    const canonical = facadeRegistrationEnvelope(canonicalRegistration, canonicalFacadeFile);
    return Boolean(
      actual &&
        canonical &&
        actual.callbackAsync &&
        !actual.callbackGenerator &&
        JSON.stringify(actual) === JSON.stringify(canonical),
    );
  };
  const facadeCallRegistrationIsDirect = (call, canonicalCall, ownerKey) => {
    const owner = enclosingFunctionNode(call);
    if (!owner || !ownerKey) return false;
    if (!ownerKey.startsWith("test:")) {
      if (ownerKey.startsWith("test-template:")) return true;
      return Boolean(
        ts.isFunctionDeclaration(owner) &&
          owner.parent === sourceFile &&
          functionLikeName(owner) === ownerKey &&
          sourceLevelBindingNodes(sourceFile, ownerKey).length === 1 &&
          !hasAuthorityMutation(sourceFile, ownerKey),
      );
    }
    const registration = directNamedTestRegistration(
      sourceFile,
      ownerKey.slice("test:".length),
      "HR browser harness contracts",
    );
    const canonicalRegistration = directNamedTestRegistration(
      canonicalFacadeFile,
      ownerKey.slice("test:".length),
      "HR browser harness contracts",
    );
    return Boolean(
      registration &&
        canonicalRegistration &&
        nodeIsWithin(call, registration.arguments.at(-1)) &&
        canonicalCall &&
        nodeIsWithin(canonicalCall, canonicalRegistration.arguments.at(-1)) &&
        facadeRegistrationEnvelopesMatch(registration, canonicalRegistration),
    );
  };
  const directFacadeSignalLoop = (call, containingFile) => {
    let registration;
    for (let current = call.parent; current; current = current.parent) {
      if (isCallNamed(current, "it") && nodeIsWithin(call, current.arguments.at(-1))) {
        registration = current;
        break;
      }
    }
    if (!registration) return undefined;
    let loop;
    for (let current = registration.parent; current; current = current.parent) {
      if (ts.isForOfStatement(current)) {
        loop = current;
        break;
      }
    }
    const describeBlock = loop?.parent;
    const describeCallback = describeBlock?.parent;
    const describeCall = describeCallback?.parent;
    const describeStatement = describeCall?.parent;
    if (
      !loop ||
      loop.awaitModifier ||
      !ts.isBlock(loop.statement) ||
      loop.statement.statements.length !== 1 ||
      !ts.isExpressionStatement(loop.statement.statements[0]) ||
      loop.statement.statements[0].expression !== registration ||
      !ts.isBlock(describeBlock) ||
      !(ts.isArrowFunction(describeCallback) || ts.isFunctionExpression(describeCallback)) ||
      describeCallback.body !== describeBlock ||
      !isCallNamed(describeCall, "describe") ||
      describeCall.arguments.length !== 2 ||
      !isStringLiteralValue(describeCall.arguments[0], "HR browser harness contracts") ||
      describeCall.arguments[1] !== describeCallback ||
      !ts.isExpressionStatement(describeStatement) ||
      describeStatement.parent !== containingFile ||
      sourceLevelBindingNodes(containingFile, "describe").length !== 1 ||
      sourceLevelBindingNodes(containingFile, "it").length !== 1 ||
      !hasClosedUnaliasedNamedImportSet(containingFile, "node:test", ["describe", "it"]) ||
      hasAuthorityMutation(containingFile, "describe") ||
      hasAuthorityMutation(containingFile, "it") ||
      authorityAliasEscapesContainingNamedRoots(containingFile, containingFile, ["describe", "it"])
        .length !== 0
    ) {
      return undefined;
    }
    return { loop, registration };
  };
  const facadeSignalLoopMatchesCanonical = (call, canonicalCall, ownerKey) => {
    if (!ownerKey?.startsWith("test-template:")) return true;
    const actual = directFacadeSignalLoop(call, sourceFile);
    const canonical = canonicalCall
      ? directFacadeSignalLoop(canonicalCall, canonicalFacadeFile)
      : undefined;
    return Boolean(
      actual &&
        canonical &&
        astFingerprint(actual.loop.initializer, sourceFile) ===
          astFingerprint(canonical.loop.initializer, canonicalFacadeFile) &&
        astFingerprint(actual.loop.expression, sourceFile) ===
          astFingerprint(canonical.loop.expression, canonicalFacadeFile) &&
        JSON.stringify(precedingExecutionBarrierFingerprints(actual.loop, sourceFile)) ===
          JSON.stringify(
            precedingExecutionBarrierFingerprints(canonical.loop, canonicalFacadeFile),
          ) &&
        facadeRegistrationEnvelopesMatch(actual.registration, canonical.registration),
    );
  };
  const canonicalFacadeCallsByKey = new Map();
  visitNode(canonicalFacadeFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !executableFacadeNames.has(node.expression.text)
    ) {
      return;
    }
    const owner = executableFacadeOwnerKey(node, canonicalFacadeFile);
    if (!owner) return;
    const key = `${owner}\u0000${astFingerprint(node, canonicalFacadeFile)}`;
    const calls = canonicalFacadeCallsByKey.get(key) ?? [];
    calls.push(node);
    canonicalFacadeCallsByKey.set(key, calls);
  });
  const expectedFacadeCallCounts = new Map();
  const expectedFacadeCallControls = new Map();
  for (const contract of canonicalExecutableFacadeCallContracts()) {
    const fingerprint = facadeExpressionFingerprint(contract.expression);
    if (!fingerprint) continue;
    const key = `${contract.owner}\u0000${fingerprint}`;
    expectedFacadeCallCounts.set(key, (expectedFacadeCallCounts.get(key) ?? 0) + 1);
    expectedFacadeCallControls.set(
      key,
      `${contract.statementKind}\u0000${contract.protectedTryDepth}`,
    );
  }
  const actualFacadeCalls = [];
  visitNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const path = staticAuthorityPath(node.expression, sourceFile) ?? [];
    if (!executableFacadeNames.has(path[0])) return;
    if (!ts.isIdentifier(node.expression) || path.length !== 1 || node.questionDotToken) {
      addDiagnostic(node, "executable-facade-provenance");
      return;
    }
    actualFacadeCalls.push(node);
  });
  const remainingFacadeCallCounts = new Map(expectedFacadeCallCounts);
  for (const call of actualFacadeCalls) {
    const owner = executableFacadeOwnerKey(call);
    const key = owner ? `${owner}\u0000${astFingerprint(call, sourceFile)}` : undefined;
    const remaining = key ? (remainingFacadeCallCounts.get(key) ?? 0) : 0;
    if (remaining <= 0) {
      addDiagnostic(call, "executable-facade-provenance");
      continue;
    }
    remainingFacadeCallCounts.set(key, remaining - 1);
    allowedFacadeCalls.add(call);
    const control = facadeCallControl(call, sourceFile);
    const canonicalCalls = canonicalFacadeCallsByKey.get(key) ?? [];
    const canonicalCall = canonicalCalls.length === 1 ? canonicalCalls[0] : undefined;
    const canonicalControl = canonicalCall
      ? facadeCallControl(canonicalCall, canonicalFacadeFile)
      : undefined;
    const actualOwner = enclosingFunctionNode(call);
    const canonicalOwner = canonicalCall ? enclosingFunctionNode(canonicalCall) : undefined;
    const ownerSignatureExact = Boolean(
      actualOwner &&
        canonicalOwner &&
        actualOwner.kind === canonicalOwner.kind &&
        Boolean(actualOwner.asteriskToken) === Boolean(canonicalOwner.asteriskToken) &&
        isAsyncFunctionLike(actualOwner) === isAsyncFunctionLike(canonicalOwner) &&
        actualOwner.parameters.length === canonicalOwner.parameters.length &&
        actualOwner.parameters.every(
          (parameter, index) =>
            astFingerprint(parameter, sourceFile) ===
            astFingerprint(canonicalOwner.parameters[index], canonicalFacadeFile),
        ),
    );
    const actualCarrierStatements = executableFacadeCarrierStatements(call);
    const canonicalCarrierStatements = canonicalCall
      ? executableFacadeCarrierStatements(canonicalCall)
      : undefined;
    if (
      !control ||
      !canonicalControl ||
      !ownerSignatureExact ||
      control.statementKind !== canonicalControl.statementKind ||
      control.protectedTryDepth !== canonicalControl.protectedTryDepth ||
      JSON.stringify(control.controlPath) !== JSON.stringify(canonicalControl.controlPath) ||
      astFingerprint(control.statement, sourceFile) !==
        astFingerprint(canonicalControl.statement, canonicalFacadeFile) ||
      !actualCarrierStatements ||
      !canonicalCarrierStatements ||
      actualCarrierStatements.length !== canonicalCarrierStatements.length ||
      actualCarrierStatements.some(
        (entry, index) =>
          astFingerprint(entry.node, sourceFile) !==
            astFingerprint(canonicalCarrierStatements[index].node, canonicalFacadeFile) ||
          JSON.stringify(entry.controlPath) !==
            JSON.stringify(canonicalCarrierStatements[index].controlPath),
      ) ||
      !facadeCallRegistrationIsDirect(call, canonicalCall, owner) ||
      !facadeSignalLoopMatchesCanonical(call, canonicalCall, owner)
    ) {
      addDiagnostic(call, "executable-facade-provenance");
    }
    for (const entry of actualCarrierStatements ?? []) {
      allowedFacadeCarrierNodes.add(entry.node);
    }
  }
  if (!new Set(["full", "signal-only"]).has(facadeMode)) {
    addDiagnostic(undefined, "executable-facade-provenance");
  }
  if (
    fullFacadeSurface &&
    (!controllerAuthority.exact ||
      !exactFacadeDefinitions ||
      canonicalFacadeCallsByKey.size !== expectedFacadeCallCounts.size ||
      [...canonicalFacadeCallsByKey.values()].some((calls) => calls.length !== 1) ||
      [...expectedFacadeCallCounts].some(
        ([key, count]) => (canonicalFacadeCallsByKey.get(key) ?? []).length !== count,
      ) ||
      [...expectedFacadeCallControls].some(([key, expectedControl]) => {
        const calls = canonicalFacadeCallsByKey.get(key) ?? [];
        const control =
          calls.length === 1 ? facadeCallControl(calls[0], canonicalFacadeFile) : undefined;
        return (
          !control ||
          `${control.statementKind}\u0000${control.protectedTryDepth}` !== expectedControl
        );
      }) ||
      actualFacadeCalls.length !== 20 ||
      [...remainingFacadeCallCounts.values()].some((count) => count !== 0))
  ) {
    addDiagnostic(undefined, "executable-facade-multiset");
  }
  if (
    authorityAliasEscapeNodes(
      sourceFile,
      sourceFile,
      executableFacadeNames,
      executableFacadeNames,
      [...allowedFacadeCalls],
    ).length > 0
  ) {
    addDiagnostic(undefined, "executable-facade-provenance");
  }

  const canonicalRealBrowserConsumerCalls = [];
  visitNode(canonicalFacadeFile, (node) => {
    if (isCallNamed(node, "runRealBrowserSignalCase")) {
      canonicalRealBrowserConsumerCalls.push(node);
    }
  });
  let canonicalRealBrowserConsumer;
  if (canonicalRealBrowserConsumerCalls.length === 1) {
    for (
      let current = canonicalRealBrowserConsumerCalls[0].parent;
      current;
      current = current.parent
    ) {
      if (ts.isForOfStatement(current)) {
        canonicalRealBrowserConsumer = current;
        break;
      }
    }
  }
  const realBrowserConsumerCalls = [];
  visitNode(sourceFile, (node) => {
    if (isCallNamed(node, "runRealBrowserSignalCase")) realBrowserConsumerCalls.push(node);
  });
  let actualRealBrowserConsumer;
  if (realBrowserConsumerCalls.length === 1) {
    for (let current = realBrowserConsumerCalls[0].parent; current; current = current.parent) {
      if (ts.isForOfStatement(current)) {
        actualRealBrowserConsumer = current;
        break;
      }
    }
  }
  if (
    fullFacadeSurface &&
    (!canonicalRealBrowserConsumer ||
      !actualRealBrowserConsumer ||
      sourceLevelBindingNodes(sourceFile, "runRealBrowserSignalCase").length !== 1 ||
      namedBindingNodes(sourceFile, "runRealBrowserSignalCase").length !== 1 ||
      hasAuthorityMutation(sourceFile, "runRealBrowserSignalCase") ||
      JSON.stringify(
        precedingExecutionBarrierFingerprints(actualRealBrowserConsumer, sourceFile),
      ) !==
        JSON.stringify(
          precedingExecutionBarrierFingerprints(canonicalRealBrowserConsumer, canonicalFacadeFile),
        ) ||
      astFingerprint(actualRealBrowserConsumer, sourceFile) !==
        astFingerprint(canonicalRealBrowserConsumer, canonicalFacadeFile))
  ) {
    addDiagnostic(undefined, "executable-facade-provenance");
  }
  const abruptRegistrationTitle =
    "owns and drains real Chromium after exact parent-delivered post-ACK harness SIGKILL";
  const actualAbruptRegistration = directNamedTestRegistration(
    sourceFile,
    abruptRegistrationTitle,
    "HR browser harness contracts",
  );
  const canonicalAbruptRegistration = directNamedTestRegistration(
    canonicalFacadeFile,
    abruptRegistrationTitle,
    "HR browser harness contracts",
  );
  if (
    fullFacadeSurface &&
    (!actualAbruptRegistration ||
      !canonicalAbruptRegistration ||
      astFingerprint(actualAbruptRegistration, sourceFile) !==
        astFingerprint(canonicalAbruptRegistration, canonicalFacadeFile) ||
      JSON.stringify(
        precedingExecutionBarrierFingerprints(actualAbruptRegistration.parent, sourceFile),
      ) !==
        JSON.stringify(
          precedingExecutionBarrierFingerprints(
            canonicalAbruptRegistration.parent,
            canonicalFacadeFile,
          ),
        ) ||
      sourceLevelBindingNodes(sourceFile, "runAbruptHarnessCrashCase").length !== 1 ||
      hasAuthorityMutation(sourceFile, "runAbruptHarnessCrashCase"))
  ) {
    addDiagnostic(undefined, "executable-facade-provenance");
  }
  const safeDirectChildRegistration = directNamedTestRegistration(
    sourceFile,
    "stops TERM-responsive and TERM-resistant direct children without timers or residue",
    "HR browser harness contracts",
  );
  const safeDirectChildCalls = new Set();
  if (safeDirectChildRegistration) {
    const callback = safeDirectChildRegistration.arguments.at(-1);
    const actualCalls = [];
    if (callback) {
      visitNode(callback, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "spawn"
        ) {
          actualCalls.push(node);
        }
      });
    }
    const canonicalSafeFile = ts.createSourceFile(
      "canonical-safe-direct-child-evals",
      [
        "function canonicalSafeDirectChildren(){",
        'spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready\\\\n");setInterval(()=>{},1000)\'],{stdio:["ignore","pipe","pipe"]});',
        'spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>{});process.stdout.write("ready\\\\n");setInterval(()=>{},1000)\'],{stdio:["ignore","pipe","pipe"]});',
        "}",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const canonicalCalls = [];
    visitNode(canonicalSafeFile, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "spawn"
      ) {
        canonicalCalls.push(node);
      }
    });
    const exactSafeMultiset =
      actualCalls.length === canonicalCalls.length &&
      actualCalls.every(
        (call, index) =>
          astFingerprint(call, sourceFile) ===
          astFingerprint(canonicalCalls[index], canonicalSafeFile),
      );
    if (exactSafeMultiset) {
      for (const call of actualCalls) safeDirectChildCalls.add(call);
    }
  }
  const safeRedactionChildRegistration = directNamedTestRegistration(
    sourceFile,
    "redacts syntactically valid control paths before realpath validation",
    "HR browser harness contracts",
  );
  if (safeRedactionChildRegistration) {
    const callback = safeRedactionChildRegistration.arguments.at(-1);
    const actualCalls = [];
    if (callback) {
      visitNode(callback, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "spawn"
        ) {
          actualCalls.push(node);
        }
      });
    }
    const canonicalSafeRedactionFile = ts.createSourceFile(
      "canonical-safe-redaction-child",
      'const child=spawn(process.execPath,[browserHarness],{cwd:repositoryRoot,env:{...process.env,ESBLA_BROWSER_CONTROL_NONCE:nonce,ESBLA_BROWSER_CONTROL_ROOT:root,ESBLA_BROWSER_LAUNCHER:launcher,ESBLA_BROWSER_OWNERSHIP_TOKEN:ownership,ESBLA_BROWSER_PROFILE_ROOT:profile,ESBLA_BROWSER_SUPERVISOR_PID:String(process.pid)},stdio:["ignore","pipe","pipe"]});',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const canonicalCalls = [];
    visitNode(canonicalSafeRedactionFile, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "spawn"
      ) {
        canonicalCalls.push(node);
      }
    });
    const actualLocation = statementListLocation(actualCalls[0]);
    const canonicalLocation = statementListLocation(canonicalCalls[0]);
    const tryBlock = actualLocation?.statement.parent;
    const tryStatement = tryBlock?.parent;
    if (
      actualCalls.length === 1 &&
      canonicalCalls.length === 1 &&
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      isAsyncFunctionLike(callback) &&
      callback.parameters.length === 0 &&
      ts.isBlock(callback.body) &&
      actualLocation &&
      canonicalLocation &&
      astFingerprint(actualLocation.statement, sourceFile) ===
        astFingerprint(canonicalLocation.statement, canonicalSafeRedactionFile) &&
      ts.isBlock(tryBlock) &&
      ts.isTryStatement(tryStatement) &&
      tryStatement.tryBlock === tryBlock &&
      !tryStatement.catchClause &&
      tryStatement.finallyBlock &&
      tryStatement.parent === callback.body
    ) {
      safeDirectChildCalls.add(actualCalls[0]);
    }
  }
  const safeAckPublicationRegistration = directNamedTestRegistration(
    sourceFile,
    "waits for exact one-link ACK publication before browser execution",
    "HR browser harness contracts",
  );
  if (safeAckPublicationRegistration) {
    const callback = safeAckPublicationRegistration.arguments.at(-1);
    const actualCalls = [];
    if (callback) {
      visitNode(callback, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "spawn"
        ) {
          actualCalls.push(node);
        }
      });
    }
    const canonicalSafeAckFile = ts.createSourceFile(
      "canonical-safe-ack-publication-child",
      [
        "async function canonicalAckPublication(){",
        "try{",
        'child=spawn(launcherPath,["-e",realSource],{',
        "detached:true,",
        "env:{",
        "...process.env,",
        "ESBLA_BROWSER_CONTROL_NONCE:nonce,",
        "ESBLA_BROWSER_CONTROL_ROOT:root,",
        "ESBLA_BROWSER_LAUNCHER:launcherPath,",
        "ESBLA_BROWSER_OWNERSHIP_TOKEN:ownershipPath,",
        "ESBLA_BROWSER_PROFILE_ROOT:profileRoot,",
        "ESBLA_BROWSER_REAL_EXECUTABLE:process.execPath,",
        "ESBLA_BROWSER_SUPERVISOR_PID:String(process.pid),",
        "},",
        'stdio:["ignore","ignore","ignore","pipe","pipe"],',
        "});",
        "}catch(error){primaryError=error;}finally{cleanup();}",
        "}",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const canonicalCalls = [];
    visitNode(canonicalSafeAckFile, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "spawn"
      ) {
        canonicalCalls.push(node);
      }
    });
    const actualLocation = statementListLocation(actualCalls[0]);
    const canonicalLocation = statementListLocation(canonicalCalls[0]);
    const actualTryBlock = actualLocation?.statement.parent;
    const canonicalTryBlock = canonicalLocation?.statement.parent;
    const actualTryStatement = actualTryBlock?.parent;
    const canonicalTryStatement = canonicalTryBlock?.parent;
    if (
      actualCalls.length === 1 &&
      canonicalCalls.length === 1 &&
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      isAsyncFunctionLike(callback) &&
      callback.parameters.length === 0 &&
      ts.isBlock(callback.body) &&
      hasClosedChildProcessImportSet(sourceFile, ["spawn", "spawnSync"]) &&
      sourceLevelBindingNodes(sourceFile, "spawn").length === 1 &&
      !hasAuthorityMutation(sourceFile, "spawn") &&
      !containsLocalBinding(callback, "spawn") &&
      actualLocation &&
      canonicalLocation &&
      astFingerprint(actualLocation.statement, sourceFile) ===
        astFingerprint(canonicalLocation.statement, canonicalSafeAckFile) &&
      ts.isBlock(actualTryBlock) &&
      ts.isBlock(canonicalTryBlock) &&
      ts.isTryStatement(actualTryStatement) &&
      ts.isTryStatement(canonicalTryStatement) &&
      actualTryStatement.tryBlock === actualTryBlock &&
      canonicalTryStatement.tryBlock === canonicalTryBlock &&
      actualTryStatement.catchClause &&
      canonicalTryStatement.catchClause &&
      astFingerprint(actualTryStatement.catchClause, sourceFile) ===
        astFingerprint(canonicalTryStatement.catchClause, canonicalSafeAckFile) &&
      actualTryStatement.finallyBlock?.statements.length &&
      actualTryStatement.parent === callback.body &&
      JSON.stringify(precedingExecutionBarrierFingerprints(actualTryStatement, sourceFile)) ===
        JSON.stringify(
          precedingExecutionBarrierFingerprints(canonicalTryStatement, canonicalSafeAckFile),
        ) &&
      JSON.stringify(
        precedingExecutionBarrierFingerprints(actualLocation.statement, sourceFile),
      ) ===
        JSON.stringify(
          precedingExecutionBarrierFingerprints(canonicalLocation.statement, canonicalSafeAckFile),
        )
    ) {
      safeDirectChildCalls.add(actualCalls[0]);
    }
  }

  visitNode(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      const calleePath = staticAuthorityPath(node.expression, sourceFile) ?? [];
      if (
        ["spawn", "spawnSync"].includes(calleePath[0]) &&
        !(ts.isIdentifier(node.expression) && calleePath.length === 1)
      ) {
        addDiagnostic(node, "external-signal-command");
      }
    }
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !["spawn", "spawnSync"].includes(node.expression.text)
    ) {
      return;
    }
    const owner = enclosingFunctionNode(node);
    const ownerName = owner ? functionLikeName(owner) : undefined;
    if (
      (controllerAuthority.exact && ownerName === "spawnOwnedChild") ||
      (exactCooperativeSpawn && ownerName === "spawnCooperativeFixture") ||
      exactExternalProbeOwner(owner) ||
      safeDirectChildCalls.has(node)
    ) {
      return;
    }
    addDiagnostic(node, "external-signal-command");
  });

  for (const member of allKillMembers) {
    if (!allowedMembers.has(member)) {
      const owner = enclosingFunctionNode(member);
      const ownerName = owner ? functionLikeName(owner) : undefined;
      addDiagnostic(
        member,
        ownerName === "runAbruptHarnessCrashCase"
          ? "abrupt-harness-authorization"
          : ownerName === "signal" || nodeIsWithin(member, actualController)
            ? "controller-verification"
            : "blind-signal-call",
      );
    }
  }

  visitNode(sourceFile, (node) => {
    if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text)) {
      addDiagnostic(node, "kill-reference-escape");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isGlobalProcessMember(node.left, sourceFile)
    ) {
      addDiagnostic(node, "process-binding-shadow");
    }
    if (ts.isDeleteExpression(node) && isGlobalProcessMember(node.expression, sourceFile)) {
      addDiagnostic(node, "process-binding-shadow");
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isCallExpression(node.parent) &&
      unparenthesizedExpression(node.parent.expression) === node &&
      [
        "child",
        "controller",
        "global.process",
        "globalThis.process",
        "process",
        "wrapper",
      ].includes(propertyChain(unparenthesizedExpression(node.expression)).join(".")) &&
      staticSignalMemberName(node, sourceFile) === undefined
    ) {
      addDiagnostic(node, "blind-signal-call");
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (propertyChain(unparenthesizedExpression(node.initializer)).join(".") === "Reflect.get" ||
        ["global.process", "globalThis.process", "process"].includes(
          propertyChain(unparenthesizedExpression(node.initializer)).join("."),
        ) ||
        isGlobalProcessMember(node.initializer, sourceFile) ||
        (ts.isIdentifier(unparenthesizedExpression(node.initializer)) &&
          unparenthesizedExpression(node.initializer).text === "Reflect") ||
        (ts.isIdentifier(unparenthesizedExpression(node.initializer)) &&
          ["eval", "Function"].includes(unparenthesizedExpression(node.initializer).text)))
    ) {
      addDiagnostic(node, "kill-reference-escape");
    }
    if (
      (ts.isImportSpecifier(node) || ts.isBindingElement(node)) &&
      propertyNameStaticValue(node.propertyName ?? node.name, sourceFile) === "kill"
    ) {
      addDiagnostic(node, "kill-reference-escape");
    }
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      propertyNameStaticValue(node.name, sourceFile) === "kill"
    ) {
      addDiagnostic(node, "generic-kill-facade");
    }
    if (ts.isCallExpression(node)) {
      const callee = propertyChain(node.expression).join(".");
      if (
        ["Object.defineProperty", "Reflect.defineProperty", "Reflect.set"].includes(callee) &&
        ["global", "globalThis"].includes(
          propertyChain(unparenthesizedExpression(node.arguments[0])).join("."),
        ) &&
        ["process", undefined].includes(resolvedStaticStringValue(node.arguments[1], sourceFile))
      ) {
        addDiagnostic(node, "process-binding-shadow");
      }
      if (
        ["Object.setPrototypeOf", "Reflect.setPrototypeOf"].includes(callee) &&
        ["global", "globalThis"].includes(
          propertyChain(unparenthesizedExpression(node.arguments[0])).join("."),
        )
      ) {
        addDiagnostic(node, "process-binding-shadow");
      }
      if (
        callee === "Object.assign" &&
        ["global", "globalThis"].includes(
          propertyChain(unparenthesizedExpression(node.arguments[0])).join("."),
        ) &&
        node.arguments.slice(1).some((argument) => {
          const source = unparenthesizedExpression(argument);
          if (!ts.isObjectLiteralExpression(source)) return true;
          return source.properties.some(
            (property) =>
              ts.isSpreadAssignment(property) ||
              (property.name &&
                ["process", undefined].includes(
                  propertyNameStaticValue(property.name, sourceFile),
                )),
          );
        })
      ) {
        addDiagnostic(node, "process-binding-shadow");
      }
      if (
        ["Reflect.get", "Object.getOwnPropertyDescriptor"].includes(callee) &&
        resolvedStaticStringValue(node.arguments[1], sourceFile) === "kill"
      ) {
        addDiagnostic(node, "kill-reference-escape");
      }
      if (
        [
          "Reflect.set",
          "Reflect.defineProperty",
          "Reflect.deleteProperty",
          "Object.defineProperty",
          "Object.defineProperties",
          "Object.setPrototypeOf",
        ].includes(callee) &&
        resolvedStaticStringValue(node.arguments[1], sourceFile) === "kill"
      ) {
        addDiagnostic(node, "generic-kill-facade");
      }
      if (
        ["eval", "Function"].includes(callee) &&
        node.arguments.some((argument) =>
          embeddedTextLooksSignalExecutable(resolvedStaticStringValue(argument, sourceFile)),
        )
      ) {
        addDiagnostic(node, "embedded-signal-program");
      }
      if (
        ["eval", "Function"].includes(callee) &&
        node.arguments.some(
          (argument) => resolvedStaticStringValue(argument, sourceFile) === undefined,
        )
      ) {
        addDiagnostic(node, "embedded-unresolved-executable");
      }
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        ts.isBinaryExpression(node)) &&
      !ignoredSignalFixtureText(node) &&
      ![...allowedFacadeCarrierNodes].some((carrier) => nodeIsWithin(node, carrier)) &&
      !(exactMalformedSourceDeclaration && nodeIsWithin(node, exactMalformedSourceDeclaration)) &&
      embeddedTextLooksSignalExecutable(resolvedStaticStringValue(node, sourceFile))
    ) {
      addDiagnostic(node, "embedded-signal-program");
    }
  });

  if (allowedMembers.size !== 4) addDiagnostic(undefined, "signal-call-multiset");
  return diagnostics.sort((left, right) => {
    const leftLine = Number(left.split(":").at(-2));
    const rightLine = Number(right.split(":").at(-2));
    return leftLine - rightLine || left.localeCompare(right);
  });
}

function replaceExactlyOnce(source, before, replacement, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  assert.notEqual(first, -1, `${label} mutation subject was absent`);
  assert.equal(first, last, `${label} mutation subject was ambiguous`);
  const mutated = `${source.slice(0, first)}${replacement}${source.slice(first + before.length)}`;
  assert.notEqual(mutated, source, `${label} mutation did not change bytes`);
  return mutated;
}

function replaceExactlyCount(source, before, replacement, expectedCount, label) {
  assert.equal(
    source.split(before).length - 1,
    expectedCount,
    `${label} mutation subject cardinality changed`,
  );
  const mutated = source.replaceAll(before, replacement);
  assert.notEqual(mutated, source, `${label} mutation did not change bytes`);
  return mutated;
}

function replaceInNamedTestExactlyOnce(source, title, before, replacement, label) {
  const sourceFile = ts.createSourceFile(
    `${label}-source`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.deepEqual(sourceFile.parseDiagnostics, [], `${label} source did not parse`);
  const registration = directNamedTestRegistration(
    sourceFile,
    title,
    "HR browser harness contracts",
  );
  assert.ok(registration, `${label} named test was absent or ambiguous`);
  const start = registration.getStart(sourceFile);
  const end = registration.getEnd();
  const original = source.slice(start, end);
  const mutated = replaceExactlyOnce(original, before, replacement, label);
  return `${source.slice(0, start)}${mutated}${source.slice(end)}`;
}

function replaceInNamedTestExactlyCount(source, title, before, replacement, expectedCount, label) {
  const sourceFile = ts.createSourceFile(
    `${label}-source`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.deepEqual(sourceFile.parseDiagnostics, [], `${label} source did not parse`);
  const registration = directNamedTestRegistration(
    sourceFile,
    title,
    "HR browser harness contracts",
  );
  assert.ok(registration, `${label} named test was absent or ambiguous`);
  const start = registration.getStart(sourceFile);
  const end = registration.getEnd();
  const original = source.slice(start, end);
  const mutated = replaceExactlyCount(original, before, replacement, expectedCount, label);
  return `${source.slice(0, start)}${mutated}${source.slice(end)}`;
}

function replaceInTopLevelFunctionExactlyOnce(source, functionName, before, replacement, label) {
  const sourceFile = ts.createSourceFile(
    `${label}-source`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.deepEqual(sourceFile.parseDiagnostics, [], `${label} source did not parse`);
  const declaration = uniqueTopLevelFunctionDeclaration(sourceFile, functionName);
  assert.ok(declaration, `${label} function was absent or ambiguous`);
  const start = declaration.getStart(sourceFile);
  const end = declaration.getEnd();
  const original = source.slice(start, end);
  const mutated = replaceExactlyOnce(original, before, replacement, label);
  return `${source.slice(0, start)}${mutated}${source.slice(end)}`;
}

function canonicalManagedProcessGroupMembersSource() {
  return [
    "function readProcessGroupMembers(pgid) {",
    "  if (!Number.isSafeInteger(pgid) || pgid <= 0) {",
    '    throw new Error("Process-group membership subject is invalid");',
    "  }",
    '  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {',
    '    encoding: "utf8",',
    "    timeout: 1_000,",
    "  });",
    "  if (",
    "    result.error ||",
    "    result.status !== 0 ||",
    "    !Number.isSafeInteger(result.pid) ||",
    "    result.pid <= 0",
    "  ) {",
    '    throw new Error("Process-group membership scan failed");',
    "  }",
    '  const lines = result.stdout.trim() ? result.stdout.trim().split("\\n") : [];',
    "  const members = lines.map((line) => {",
    "    const match = /^\\s*(\\d+)\\s+(\\d+)\\s*$/.exec(line);",
    '    if (!match) throw new Error("Process-group membership scan was ambiguous");',
    "    const pid = Number(match[1]);",
    "    const observedPgid = Number(match[2]);",
    "    if (",
    "      !Number.isSafeInteger(pid) ||",
    "      pid <= 0 ||",
    "      !Number.isSafeInteger(observedPgid) ||",
    "      observedPgid <= 0",
    "    ) {",
    '      throw new Error("Process-group membership scan contained invalid identities");',
    "    }",
    "    return { pgid: observedPgid, pid };",
    "  });",
    "  return members.filter((member) => member.pgid === pgid && member.pid !== result.pid);",
    "}",
  ].join("\n");
}

function canonicalManagedChildLifecycleSource() {
  return [
    "const managedChildCloseReceipts = new WeakMap();",
    "function managedChildCloseReceipt(child) {",
    "  const existing = managedChildCloseReceipts.get(child);",
    "  if (existing) return existing;",
    "  let resolveClose;",
    "  const receipt = { closed: false, promise: undefined };",
    "  receipt.promise = new Promise((resolveReceipt) => { resolveClose = resolveReceipt; });",
    '  child.once("close", () => { receipt.closed = true; resolveClose(); });',
    "  managedChildCloseReceipts.set(child, receipt);",
    "  return receipt;",
    "}",
    "function registerManagedChild(child, signalState) {",
    "  managedChildCloseReceipt(child);",
    "  signalState.children.add(child);",
    "  return child;",
    "}",
    "export async function stopChild(child, timeoutMs = processStopTimeoutMs) {",
    "  if (!child) return;",
    "  const receipt = managedChildCloseReceipt(child);",
    "  if (child.exitCode === null && child.signalCode === null) {",
    '    signalChild(child, "SIGTERM");',
    "    if (!(await waitForExit(child, timeoutMs))) {",
    '      signalChild(child, "SIGKILL");',
    "      if (!(await waitForExit(child, timeoutMs))) {",
    '        throw new Error(`Child process ${child.pid ?? "unknown"} survived SIGKILL`);',
    "      }",
    "    }",
    "  }",
    '  await withTimeout("child close", async () => await receipt.promise, timeoutMs);',
    '  if (!receipt.closed) throw new Error("Child close was not observed");',
    "}",
    canonicalManagedProcessGroupMembersSource(),
    "async function stopManagedChildren(signalState) {",
    "  const children = [...signalState.children];",
    "  const results = await Promise.allSettled(children.map((child) => stopChild(child)));",
    '  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);',
    '  if (errors.length > 0) throw new AggregateError(errors, "One or more child processes survived");',
    "  if (!children.every((child) => managedChildCloseReceipt(child).closed)) {",
    '    throw new Error("Managed child close proof is incomplete");',
    "  }",
    "  const members = readProcessGroupMembers(process.pid);",
    "  if (!members.some((member) => member.pid === process.pid)) {",
    '    throw new Error("Harness process-group leadership is unproved");',
    "  }",
    "  if (members.some((member) => member.pid !== process.pid)) {",
    '    throw new Error("Managed child process-group absence is unproved");',
    "  }",
    "  for (const child of children) signalState.children.delete(child);",
    "  return true;",
    "}",
    "async function captureTemporaryRoot(path) {",
    "  const canonicalPath = await realpath(path);",
    "  const metadata = await lstat(canonicalPath, { bigint: true });",
    "  if (canonicalPath !== path || !metadata.isDirectory() || metadata.isSymbolicLink() || Number(metadata.uid) !== process.getuid() || Number(metadata.mode & 0o777n) !== 0o700) {",
    '    throw new Error("Temporary root ownership is invalid");',
    "  }",
    "  return Object.freeze({ dev: String(metadata.dev), ino: String(metadata.ino), path: canonicalPath, uid: Number(metadata.uid) });",
    "}",
    "async function assertTemporaryRootOwned(path, owned) {",
    "  const canonicalPath = await realpath(path);",
    "  const metadata = await lstat(path, { bigint: true });",
    "  if (!owned || canonicalPath !== path || owned.path !== path || !metadata.isDirectory() || metadata.isSymbolicLink() || Number(metadata.uid) !== process.getuid() || Number(metadata.uid) !== owned.uid || Number(metadata.mode & 0o777n) !== 0o700 || String(metadata.dev) !== owned.dev || String(metadata.ino) !== owned.ino) {",
    '    throw new Error("Temporary root identity changed");',
    "  }",
    "  return true;",
    "}",
    "async function runHarness() {",
    "  const signalState = { activeChild: undefined, children: new Set(), signal: undefined };",
    "  let managedChildrenClosed = false;",
    "  let temporaryRoot;",
    "  let temporaryRootOwned;",
    "  try {",
    '    temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "esbla-hr-browser-")));',
    "    temporaryRootOwned = await captureTemporaryRoot(temporaryRoot);",
    "  } finally {",
    "    await runCleanupSteps([",
    "      {",
    '        name: "child-processes",',
    "        run: async () => {",
    "          const closed = await stopManagedChildren(signalState);",
    '          if (closed !== true) throw new Error("Managed child cleanup did not produce an exact receipt");',
    "          managedChildrenClosed = true;",
    "        },",
    "      },",
    "      {",
    '        name: "temporary-state",',
    "        run: async () => {",
    "          if (!temporaryRoot) return;",
    '          if (!managedChildrenClosed) throw new Error("Managed child cleanup is unproved");',
    "          await assertTemporaryRootOwned(temporaryRoot, temporaryRootOwned);",
    "          const members = readProcessGroupMembers(process.pid);",
    "          if (!members.some((member) => member.pid === process.pid) || members.some((member) => member.pid !== process.pid)) {",
    '            throw new Error("Harness process-group absence is unproved");',
    "          }",
    "          await assertTemporaryRootOwned(temporaryRoot, temporaryRootOwned);",
    "          await rm(temporaryRoot, { force: false, recursive: true });",
    "        },",
    "      },",
    "    ]);",
    "  }",
    "}",
  ].join("\n");
}

function cleanupStepByName(functionNode, sourceFile, name) {
  const calls = [];
  visitNode(functionNode, (node) => {
    if (isCallNamed(node, "runCleanupSteps")) calls.push(node);
  });
  if (calls.length !== 1) return undefined;
  const array = calls[0].arguments[0];
  if (!ts.isArrayLiteralExpression(array)) return undefined;
  const matches = array.elements.filter((element) => {
    if (!ts.isObjectLiteralExpression(element)) return false;
    const property = element.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) &&
        propertyNameStaticValue(candidate.name, sourceFile) === "name",
    );
    return Boolean(property && isStringLiteralValue(property.initializer, name));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function doubleSignalCleanupContract(testFile, registration) {
  const callbacks = registration?.arguments.filter(
    (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
  );
  const callback =
    callbacks?.length === 1 && registration.arguments.at(-1) === callbacks[0]
      ? callbacks[0]
      : undefined;
  const options = registration?.arguments[1];
  const registrationTimeout = ts.isObjectLiteralExpression(options)
    ? numericLiteralValue(options.properties[0]?.initializer)
    : undefined;
  const exactRegistrationEnvelope = Boolean(
    callback &&
      isAsyncFunctionLike(callback) &&
      callback.parameters.length === 0 &&
      ts.isBlock(callback.body) &&
      registration.arguments.length === 3 &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.length === 1 &&
      ts.isPropertyAssignment(options.properties[0]) &&
      propertyNameStaticValue(options.properties[0].name, testFile) === "timeout" &&
      Number.isSafeInteger(registrationTimeout) &&
      registrationTimeout >= 45_000 &&
      registrationTimeout <= 120_000,
  );
  if (!exactRegistrationEnvelope) return { cooperativeStop: false, rootGate: false };

  const body = callback.body;
  const outerTries = body.statements.filter(
    (statement) => ts.isTryStatement(statement) && Boolean(statement.finallyBlock),
  );
  const outerTry = outerTries.length === 1 ? outerTries[0] : undefined;
  const finalBlock = outerTry?.finallyBlock;
  if (!outerTry || !finalBlock) return { cooperativeStop: false, rootGate: false };

  const id = (node, name) =>
    ts.isIdentifier(unparenthesizedExpression(node)) &&
    unparenthesizedExpression(node).text === name;
  const identifierSet = (root) => {
    const names = new Set();
    visitNode(root, (node) => {
      if (ts.isIdentifier(node)) names.add(node.text);
    });
    return names;
  };
  const containsFalseLiteral = (root) => {
    let found = false;
    visitNode(root, (node) => {
      if (node.kind === ts.SyntaxKind.FalseKeyword) found = true;
    });
    return found;
  };
  const callsWithPath = (root, expectedPath) => {
    const calls = [];
    visitNode(root, (node) => {
      if (
        ts.isCallExpression(node) &&
        staticAuthorityPath(node.expression, testFile)?.join(".") === expectedPath
      ) {
        calls.push(node);
      }
    });
    return calls;
  };
  const isAwaited = (node) => {
    let current = node?.parent;
    while (current && ts.isParenthesizedExpression(current)) current = current.parent;
    return ts.isAwaitExpression(current);
  };
  const directStatementInBlock = (node, block) => {
    let current = node;
    while (current?.parent && current.parent !== block) current = current.parent;
    return current?.parent === block ? current : undefined;
  };
  const isInertVoidStatement = (statement) => {
    const expression = ts.isExpressionStatement(statement)
      ? unparenthesizedExpression(statement.expression)
      : undefined;
    if (!expression || !ts.isVoidExpression(expression)) return false;
    let forbidden = false;
    visitNode(expression.expression, (node) => {
      if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isAwaitExpression(node) ||
        ts.isYieldExpression(node) ||
        ts.isDeleteExpression(node) ||
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
      ) {
        forbidden = true;
      }
    });
    return !forbidden;
  };
  const precedesWithoutInterveningEffect = (
    block,
    before,
    followingStatement,
    allowedStatements = new Set(),
  ) => {
    const beforeIndex = block?.statements.indexOf(before) ?? -1;
    const followingIndex = block?.statements.indexOf(followingStatement) ?? -1;
    return Boolean(
      beforeIndex >= 0 &&
        followingIndex > beforeIndex &&
        block.statements
          .slice(beforeIndex + 1, followingIndex)
          .every(
            (statement) => allowedStatements.has(statement) || isInertVoidStatement(statement),
          ),
    );
  };
  const awaitedExpressionStatement = (call) => {
    let current = call?.parent;
    while (current && ts.isParenthesizedExpression(current)) current = current.parent;
    if (!current || !ts.isAwaitExpression(current)) return undefined;
    current = current.parent;
    while (current && ts.isParenthesizedExpression(current)) current = current.parent;
    return current && ts.isExpressionStatement(current) ? current : undefined;
  };
  const directAwaitedExpressionStatement = (call, block) => {
    const statement = awaitedExpressionStatement(call);
    return statement?.parent === block ? statement : undefined;
  };
  const owningTry = (node, boundary) => {
    for (let current = node?.parent; current && current !== boundary; current = current.parent) {
      if (ts.isTryStatement(current) && nodeIsWithin(node, current.tryBlock)) return current;
    }
    return undefined;
  };
  const catchAppendsCleanupFailure = (tryStatement, cleanupName) => {
    const clause = tryStatement?.catchClause;
    const parameter = clause?.variableDeclaration?.name;
    if (!clause || tryStatement.finallyBlock || !ts.isIdentifier(parameter)) return false;
    const pushes = callsWithPath(clause.block, `${cleanupName}.push`).filter(
      (call) => call.arguments.length === 1 && id(call.arguments[0], parameter.text),
    );
    let abrupt = false;
    visitNode(clause.block, (node) => {
      if (
        ts.isReturnStatement(node) ||
        ts.isThrowStatement(node) ||
        ts.isBreakStatement(node) ||
        ts.isContinueStatement(node)
      ) {
        abrupt = true;
      }
    });
    return pushes.length === 1 && !abrupt;
  };

  const declarationKind = (declaration) => {
    if (!declaration?.parent || !ts.isVariableDeclarationList(declaration.parent)) return undefined;
    if (declaration.parent.flags & ts.NodeFlags.Const) return "const";
    if (declaration.parent.flags & ts.NodeFlags.Let) return "let";
    return "var";
  };
  const directDeclarations = (container) =>
    (container?.statements ?? []).flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    );
  const declarationName = (declaration) =>
    declaration?.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
  const directAssignments = (container, rightMatcher) => {
    const assignments = [];
    visitNode(container, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unparenthesizedExpression(node.left)) &&
        rightMatcher(unparenthesizedExpression(node.right), node)
      ) {
        assignments.push(node);
      }
    });
    return assignments;
  };
  const uniqueAssignmentName = (container, rightMatcher) => {
    const assignments = directAssignments(container, rightMatcher);
    return assignments.length === 1
      ? unparenthesizedExpression(assignments[0].left).text
      : undefined;
  };
  const directBodyDeclarations = directDeclarations(body);
  const rootCapabilityDeclarations = directBodyDeclarations.filter((declaration) => {
    const initializer = unparenthesizedExpression(declaration.initializer);
    const label =
      initializer && ts.isCallExpression(initializer)
        ? resolvedStaticStringValue(initializer.arguments[1], testFile)
        : undefined;
    return Boolean(
      initializer &&
        ts.isCallExpression(initializer) &&
        isCallNamed(initializer, "captureOwnedDirectory") &&
        initializer.arguments.length === 2 &&
        ts.isIdentifier(unparenthesizedExpression(initializer.arguments[0])) &&
        typeof label === "string" &&
        label.length > 0 &&
        label.length <= 128 &&
        !/[\0\r\n]/u.test(label),
    );
  });
  const rootCapabilityDeclaration =
    rootCapabilityDeclarations.length === 1 ? rootCapabilityDeclarations[0] : undefined;
  const rootCapabilityCall = unparenthesizedExpression(rootCapabilityDeclaration?.initializer);
  const rootName =
    rootCapabilityCall && ts.isCallExpression(rootCapabilityCall)
      ? unparenthesizedExpression(rootCapabilityCall.arguments[0])?.text
      : undefined;
  const rootCapabilityName = declarationName(rootCapabilityDeclaration);
  const rootLabel =
    rootCapabilityCall && ts.isCallExpression(rootCapabilityCall)
      ? resolvedStaticStringValue(rootCapabilityCall.arguments[1], testFile)
      : undefined;
  const pathRoleName = (leafName) => {
    const matches = directBodyDeclarations.filter((declaration) => {
      const initializer = unparenthesizedExpression(declaration.initializer);
      return Boolean(
        initializer &&
          ts.isCallExpression(initializer) &&
          isCallNamed(initializer, "join") &&
          initializer.arguments.length === 2 &&
          id(initializer.arguments[0], rootName) &&
          isStringLiteralValue(initializer.arguments[1], leafName),
      );
    });
    return matches.length === 1 ? declarationName(matches[0]) : undefined;
  };
  const wrapperName = uniqueAssignmentName(
    outerTry.tryBlock,
    (right) => ts.isCallExpression(right) && isCallNamed(right, "spawnSupervisedPostgresWrapper"),
  );
  const identityRoleName = (memberName) =>
    uniqueAssignmentName(outerTry.tryBlock, (right) => {
      const argument = ts.isCallExpression(right)
        ? unparenthesizedExpression(right.arguments[0])
        : undefined;
      return Boolean(
        ts.isCallExpression(right) &&
          isCallNamed(right, "captureStableProcessIdentity") &&
          right.arguments.length === 1 &&
          ts.isPropertyAccessExpression(argument) &&
          argument.name.text === memberName,
      );
    });
  const primaryFailureName = uniqueAssignmentName(outerTry.catchClause?.block, (right) =>
    Boolean(
      ts.isIdentifier(right) &&
        ts.isIdentifier(outerTry.catchClause?.variableDeclaration?.name) &&
        right.text === outerTry.catchClause.variableDeclaration.name.text,
    ),
  );
  const cleanupDeclarations = directBodyDeclarations.filter(
    (declaration) =>
      isConstVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isArrayLiteralExpression(declaration.initializer) &&
      declaration.initializer.elements.length === 0,
  );
  const cleanupName =
    cleanupDeclarations.length === 1 ? declarationName(cleanupDeclarations[0]) : undefined;
  const falseStateNames = new Set(
    directBodyDeclarations
      .filter(
        (declaration) =>
          declarationKind(declaration) === "let" &&
          declaration.initializer?.kind === ts.SyntaxKind.FalseKeyword,
      )
      .map(declarationName)
      .filter(Boolean),
  );
  const proofRoleFromIdentityGate = (identityName) => {
    const candidates = [];
    for (const statement of finalBlock.statements) {
      if (!ts.isIfStatement(statement)) continue;
      const identifiers = identifierSet(statement.expression);
      if (!identifiers.has(identityName)) continue;
      visitNode(statement.expression, (node) => {
        if (
          ts.isPrefixUnaryExpression(node) &&
          node.operator === ts.SyntaxKind.ExclamationToken &&
          ts.isIdentifier(unparenthesizedExpression(node.operand)) &&
          falseStateNames.has(unparenthesizedExpression(node.operand).text)
        ) {
          candidates.push(unparenthesizedExpression(node.operand).text);
        }
      });
    }
    return new Set(candidates).size === 1 ? [...new Set(candidates)][0] : undefined;
  };
  const wrapperProofName = uniqueAssignmentName(finalBlock, (right) => {
    if (!wrapperName) return false;
    const canonical = ts.createSourceFile(
      "derived-wrapper-proof",
      `const proof=${wrapperName}.settled&&${wrapperName}.phase==="finalized";`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const expected = directVariableDeclarations(canonical, "proof")[0]?.initializer;
    return Boolean(
      expected && astFingerprint(right, testFile) === astFingerprint(expected, canonical),
    );
  });
  const unacquiredProofNames = [];
  for (const call of callsWithPath(finalBlock, "assertNoOwnedResidue")) {
    const proofTry = owningTry(call, finalBlock);
    for (const assignment of directAssignments(
      proofTry?.tryBlock,
      (right) => right?.kind === ts.SyntaxKind.TrueKeyword,
    )) {
      const name = unparenthesizedExpression(assignment.left).text;
      if (falseStateNames.has(name)) unacquiredProofNames.push(name);
    }
  }
  const unacquiredProofName =
    new Set(unacquiredProofNames).size === 1 ? [...new Set(unacquiredProofNames)][0] : undefined;
  const roles = Object.freeze({
    cleanup: cleanupName,
    grandchildIdentity: identityRoleName("grandchild"),
    grandchildProof: undefined,
    leaderIdentity: identityRoleName("leader"),
    leaderProof: undefined,
    primaryFailure: primaryFailureName,
    readyPath: pathRoleName("ready.json"),
    root: rootName,
    rootCapability: rootCapabilityName,
    stopPath: pathRoleName("grandchild.stop"),
    unacquiredProof: unacquiredProofName,
    wrapper: wrapperName,
    wrapperProof: wrapperProofName,
  });
  const derivedRoles = Object.freeze({
    ...roles,
    grandchildProof: proofRoleFromIdentityGate(roles.grandchildIdentity),
    leaderProof: proofRoleFromIdentityGate(roles.leaderIdentity),
  });
  const exactStateDeclaration = (name, kind, initializer) => {
    const declarations = directVariableDeclarations(body, name);
    const declaration = declarations[0];
    const exactInitializer =
      initializer === "none"
        ? !declaration?.initializer
        : initializer === "false"
          ? declaration?.initializer?.kind === ts.SyntaxKind.FalseKeyword
          : ts.isArrayLiteralExpression(declaration?.initializer) &&
            declaration.initializer.elements.length === 0;
    return (
      declarations.length === 1 &&
      namedBindingNodes(callback, name).length === 1 &&
      declarationKind(declaration) === kind &&
      exactInitializer
    );
  };
  const stateDeclarationsExact =
    [
      [derivedRoles.wrapper, "let", "none"],
      [derivedRoles.leaderIdentity, "let", "none"],
      [derivedRoles.grandchildIdentity, "let", "none"],
      [derivedRoles.grandchildProof, "let", "false"],
      [derivedRoles.leaderProof, "let", "false"],
      [derivedRoles.unacquiredProof, "let", "false"],
      [derivedRoles.wrapperProof, "let", "false"],
      [derivedRoles.primaryFailure, "let", "none"],
      [derivedRoles.cleanup, "const", "empty"],
    ].every((entry) => entry[0] && exactStateDeclaration(...entry)) &&
    new Set(Object.values(derivedRoles)).size === Object.values(derivedRoles).length;
  if (!stateDeclarationsExact) return { cooperativeStop: false, rootGate: false };

  const roots = directVariableDeclarations(body, derivedRoles.root);
  const ownedRoots = directVariableDeclarations(body, derivedRoles.rootCapability);
  const variableStatement = (declaration) =>
    declaration?.parent &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent)
      ? declaration.parent.parent
      : undefined;
  const rootStatement = variableStatement(roots[0]);
  const ownedRootStatement = variableStatement(ownedRoots[0]);
  const ownedRootCall = unparenthesizedExpression(ownedRoots[0]?.initializer);
  const exactLeafPathBinding = (name, leafName) => {
    const declarations = directVariableDeclarations(body, name);
    const declaration = declarations[0];
    const initializer = unparenthesizedExpression(declaration?.initializer);
    return Boolean(
      declarations.length === 1 &&
        declaration &&
        isConstVariableDeclaration(declaration) &&
        initializer &&
        ts.isCallExpression(initializer) &&
        isCallNamed(initializer, "join") &&
        initializer.arguments.length === 2 &&
        id(initializer.arguments[0], derivedRoles.root) &&
        isStringLiteralValue(initializer.arguments[1], leafName) &&
        identifierMutationNodes(callback, name).length === 0 &&
        body.statements.indexOf(variableStatement(declaration)) < body.statements.indexOf(outerTry),
    );
  };
  const exactRootCapture = Boolean(
    roots.length === 1 &&
      ownedRoots.length === 1 &&
      rootStatement &&
      ownedRootStatement &&
      body.statements.indexOf(ownedRootStatement) > body.statements.indexOf(rootStatement) &&
      body.statements.indexOf(ownedRootStatement) < body.statements.indexOf(outerTry) &&
      isConstVariableDeclaration(roots[0]) &&
      isConstVariableDeclaration(ownedRoots[0]) &&
      ts.isCallExpression(ownedRootCall) &&
      isCallNamed(ownedRootCall, "captureOwnedDirectory") &&
      ownedRootCall.arguments.length === 2 &&
      id(ownedRootCall.arguments[0], derivedRoles.root) &&
      resolvedStaticStringValue(ownedRootCall.arguments[1], testFile) === rootLabel &&
      identifierMutationNodes(callback, derivedRoles.rootCapability).length === 0 &&
      exactLeafPathBinding(derivedRoles.readyPath, "ready.json") &&
      exactLeafPathBinding(derivedRoles.stopPath, "grandchild.stop"),
  );

  const outerCatch = outerTry.catchClause;
  const outerCatchParameter = outerCatch?.variableDeclaration?.name;
  const primaryAssignments = identifierMutationNodes(callback, derivedRoles.primaryFailure);
  const exactPrimaryFailureCapture = Boolean(
    outerCatch &&
      ts.isIdentifier(outerCatchParameter) &&
      primaryAssignments.length === 1 &&
      nodeIsWithin(primaryAssignments[0], outerCatch.block) &&
      ts.isBinaryExpression(primaryAssignments[0]) &&
      primaryAssignments[0].operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      id(primaryAssignments[0].left, derivedRoles.primaryFailure) &&
      id(primaryAssignments[0].right, outerCatchParameter.text),
  );

  const epilogue = body.statements.slice(body.statements.indexOf(outerTry) + 1);
  const epilogueThrows = [];
  for (const statement of epilogue) {
    visitNode(statement, (node) => {
      if (ts.isThrowStatement(node)) epilogueThrows.push(node);
    });
  }
  const aggregateThrows = epilogueThrows.filter((statement) => {
    const expression = unparenthesizedExpression(statement.expression);
    return (
      ts.isNewExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "AggregateError"
    );
  });
  const primaryThrow = epilogueThrows.find((statement) =>
    id(statement.expression, derivedRoles.primaryFailure),
  );
  const combinedThrow = aggregateThrows.find((statement) => {
    const names = identifierSet(statement.expression);
    return names.has(derivedRoles.primaryFailure) && names.has(derivedRoles.cleanup);
  });
  const cleanupThrow = aggregateThrows.find((statement) => {
    const names = identifierSet(statement.expression);
    return !names.has(derivedRoles.primaryFailure) && names.has(derivedRoles.cleanup);
  });
  const throwOwner = (statement) => {
    const owner = ts.isBlock(statement?.parent) ? statement.parent.parent : statement?.parent;
    return owner && ts.isIfStatement(owner) && nodeIsWithin(statement, owner.thenStatement)
      ? owner
      : undefined;
  };
  const primaryCondition = (expression) => id(expression, derivedRoles.primaryFailure);
  const cleanupCondition = (expression) => {
    const candidate = unparenthesizedExpression(expression);
    const cleanupLength = (node) => {
      const value = unparenthesizedExpression(node);
      return Boolean(
        value &&
          ts.isPropertyAccessExpression(value) &&
          id(value.expression, derivedRoles.cleanup) &&
          value.name.text === "length",
      );
    };
    if (cleanupLength(candidate)) return true;
    if (!candidate || !ts.isBinaryExpression(candidate)) return false;
    const leftLength = cleanupLength(candidate.left);
    const rightLength = cleanupLength(candidate.right);
    const leftZero = numericLiteralValue(candidate.left) === 0;
    const rightZero = numericLiteralValue(candidate.right) === 0;
    return Boolean(
      (leftLength &&
        rightZero &&
        [
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.GreaterThanToken,
        ].includes(candidate.operatorToken.kind)) ||
        (leftZero && rightLength && candidate.operatorToken.kind === ts.SyntaxKind.LessThanToken),
    );
  };
  const combinedCondition = (expression) => {
    const candidate = unparenthesizedExpression(expression);
    if (
      !candidate ||
      !ts.isBinaryExpression(candidate) ||
      candidate.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return false;
    }
    return Boolean(
      (primaryCondition(candidate.left) && cleanupCondition(candidate.right)) ||
        (cleanupCondition(candidate.left) && primaryCondition(candidate.right)),
    );
  };
  const exactCombinedAggregate = (statement) => {
    const expression = unparenthesizedExpression(statement?.expression);
    const errors =
      expression && ts.isNewExpression(expression)
        ? unparenthesizedExpression(expression.arguments?.[0])
        : undefined;
    return Boolean(
      errors &&
        ts.isArrayLiteralExpression(errors) &&
        errors.elements.length === 2 &&
        id(errors.elements[0], derivedRoles.primaryFailure) &&
        ts.isSpreadElement(errors.elements[1]) &&
        id(errors.elements[1].expression, derivedRoles.cleanup),
    );
  };
  const exactCleanupAggregate = (statement) => {
    const expression = unparenthesizedExpression(statement?.expression);
    return Boolean(
      expression &&
        ts.isNewExpression(expression) &&
        expression.arguments?.length >= 1 &&
        id(expression.arguments[0], derivedRoles.cleanup),
    );
  };
  const combinedOwner = throwOwner(combinedThrow);
  const primaryOwner = throwOwner(primaryThrow);
  const cleanupOwner = throwOwner(cleanupThrow);
  const exactFailurePropagation = Boolean(
    combinedThrow &&
      primaryThrow &&
      cleanupThrow &&
      combinedOwner &&
      primaryOwner &&
      cleanupOwner &&
      combinedOwner.parent === body &&
      primaryOwner.parent === body &&
      cleanupOwner.parent === body &&
      combinedCondition(combinedOwner.expression) &&
      primaryCondition(primaryOwner.expression) &&
      cleanupCondition(cleanupOwner.expression) &&
      exactCombinedAggregate(combinedThrow) &&
      exactCleanupAggregate(cleanupThrow) &&
      body.statements.indexOf(combinedOwner) > body.statements.indexOf(outerTry) &&
      body.statements.indexOf(primaryOwner) > body.statements.indexOf(combinedOwner) &&
      body.statements.indexOf(cleanupOwner) > body.statements.indexOf(primaryOwner),
  );

  let prematureControlFlow = false;
  const visitCallbackControl = (node) => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      prematureControlFlow = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ["process.exit", "process.abort"].includes(
        staticAuthorityPath(node.expression, testFile)?.join("."),
      )
    ) {
      prematureControlFlow = true;
      return;
    }
    ts.forEachChild(node, visitCallbackControl);
  };
  visitCallbackControl(callback);

  const protectedState = new Set([
    derivedRoles.wrapper,
    derivedRoles.leaderIdentity,
    derivedRoles.grandchildIdentity,
    derivedRoles.grandchildProof,
    derivedRoles.leaderProof,
    derivedRoles.unacquiredProof,
    derivedRoles.wrapperProof,
    derivedRoles.primaryFailure,
    derivedRoles.cleanup,
    derivedRoles.rootCapability,
  ]);
  let reflectiveStateMutation = false;
  visitNode(callback, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = propertyChain(node.expression).join(".");
    if (
      [
        "Object.assign",
        "Object.defineProperties",
        "Object.defineProperty",
        "Object.setPrototypeOf",
        "Reflect.defineProperty",
        "Reflect.deleteProperty",
        "Reflect.set",
        "Reflect.setPrototypeOf",
      ].includes(callee) &&
      protectedState.has(staticAuthorityPath(node.arguments[0], testFile)?.[0])
    ) {
      reflectiveStateMutation = true;
    }
  });
  const protectedHelperNames = [
    "AggregateError",
    "Error",
    "Object",
    "Promise",
    "assert",
    "assertNoOwnedResidue",
    "captureOwnedDirectory",
    "readdir",
    "rm",
    "rmdir",
    "waitForExactProcessExit",
    "writePrivateStop",
  ];
  const exactHelperBindings = protectedHelperNames.every(
    (name) => !containsLocalBinding(callback, name),
  );
  const cleanupFailureSinkClosed =
    authorityAliasEscapeNodes(
      callback,
      testFile,
      new Set([derivedRoles.cleanup]),
      new Set([derivedRoles.cleanup]),
      [combinedThrow, cleanupThrow].filter(Boolean),
    ).length === 0;
  let cleanupSinkMethodsClosed = true;
  visitNode(callback, (node) => {
    if (ts.isCallExpression(node)) {
      const path = staticAuthorityPath(node.expression, testFile) ?? [];
      if (path[0] === derivedRoles.cleanup && path.join(".") !== `${derivedRoles.cleanup}.push`) {
        cleanupSinkMethodsClosed = false;
      }
    }
    if (ts.isDeleteExpression(node) && identifierSet(node.expression).has(derivedRoles.cleanup)) {
      cleanupSinkMethodsClosed = false;
    }
  });

  const stopCalls = callsWithPath(finalBlock, "writePrivateStop").filter(
    (call) => call.arguments.length === 1 && id(call.arguments[0], derivedRoles.stopPath),
  );
  const exactWaitCalls = callsWithPath(callback, "waitForExactProcessExit");
  const finalLeaderWaits = exactWaitCalls.filter(
    (call) =>
      nodeIsWithin(call, finalBlock) &&
      call.arguments.length >= 1 &&
      id(call.arguments[0], derivedRoles.leaderIdentity),
  );
  const finalGrandchildWaits = exactWaitCalls.filter(
    (call) =>
      nodeIsWithin(call, finalBlock) &&
      call.arguments.length >= 1 &&
      id(call.arguments[0], derivedRoles.grandchildIdentity),
  );
  const wrapperFinishCalls = callsWithPath(finalBlock, `${derivedRoles.wrapper}.finish`);
  const wrapperIdentityWaits = exactWaitCalls.filter((call) => {
    const argument = unparenthesizedExpression(call.arguments[0]);
    return (
      nodeIsWithin(call, finalBlock) &&
      ts.isPropertyAccessExpression(argument) &&
      id(argument.expression, derivedRoles.wrapper) &&
      argument.name.text === "identity"
    );
  });
  const noResidueCalls = callsWithPath(finalBlock, "assertNoOwnedResidue");
  const rootCleanupCalls = callsWithPath(finalBlock, "rmdir").filter(
    (call) => call.arguments.length === 1 && id(call.arguments[0], derivedRoles.root),
  );

  const stopTry = owningTry(stopCalls[0], finalBlock);
  const grandchildTry = owningTry(finalGrandchildWaits[0], finalBlock);
  const wrapperTry = owningTry(wrapperFinishCalls[0], finalBlock);
  const leaderTry = owningTry(finalLeaderWaits[0], finalBlock);
  const noResidueTry = owningTry(noResidueCalls[0], finalBlock);
  const rootTry = owningTry(rootCleanupCalls[0], finalBlock);
  const cleanupTries = [stopTry, grandchildTry, wrapperTry, leaderTry, noResidueTry, rootTry];
  const independentCleanupAttempts = Boolean(
    cleanupTries.every(Boolean) &&
      new Set(cleanupTries).size === cleanupTries.length &&
      cleanupTries.every((tryStatement) =>
        catchAppendsCleanupFailure(tryStatement, derivedRoles.cleanup),
      ),
  );

  const captureCallsIn = (root) =>
    callsWithPath(root, "captureOwnedDirectory").filter(
      (call) =>
        call.arguments.length === 2 &&
        id(call.arguments[0], derivedRoles.root) &&
        resolvedStaticStringValue(call.arguments[1], testFile) === rootLabel,
    );
  const exactRootRevalidationStatement = (statement) => {
    if (!statement || !ts.isExpressionStatement(statement)) return false;
    const captures = captureCallsIn(statement);
    const assertions = callsWithPath(statement, "assert.deepEqual");
    return Boolean(
      captures.length === 1 &&
        assertions.length === 1 &&
        assertions[0].arguments.length === 2 &&
        unparenthesizedExpression(assertions[0].arguments[0]) === captures[0] &&
        id(assertions[0].arguments[1], derivedRoles.rootCapability),
    );
  };
  const stopStatement = stopTry
    ? directAwaitedExpressionStatement(stopCalls[0], stopTry.tryBlock)
    : undefined;
  const stopIndex = stopTry?.tryBlock.statements.indexOf(stopStatement) ?? -1;
  const stopCaptureStatements = stopTry
    ? stopTry.tryBlock.statements.filter(
        (statement, index) => index < stopIndex && exactRootRevalidationStatement(statement),
      )
    : [];
  const stopCaptureStatement =
    stopCaptureStatements.length === 1 ? stopCaptureStatements[0] : undefined;
  const exactStopPublication = Boolean(
    stopCalls.length === 1 &&
      stopTry &&
      exactRootRevalidationStatement(stopCaptureStatement) &&
      precedesWithoutInterveningEffect(stopTry.tryBlock, stopCaptureStatement, stopStatement),
  );

  const canonicalGateFile = ts.createSourceFile(
    "canonical-double-signal-gates",
    [
      `if (((!${derivedRoles.wrapper} || ${derivedRoles.wrapperProof}) && ${derivedRoles.leaderProof} && ${derivedRoles.grandchildProof}) || ${derivedRoles.unacquiredProof}) {}`,
      `if ((!${derivedRoles.wrapper} || ${derivedRoles.wrapperProof}) && !${derivedRoles.leaderIdentity} && !${derivedRoles.grandchildIdentity}) {}`,
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const expectedRootGate = canonicalGateFile.statements[0];
  const expectedUnacquiredGate = canonicalGateFile.statements[1];
  const normalizedBooleanRole = (expression, containingFile = testFile) => {
    const candidate = unparenthesizedExpression(expression);
    if (
      ts.isBinaryExpression(candidate) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(
        candidate.operatorToken.kind,
      )
    ) {
      const operator = candidate.operatorToken.kind;
      const terms = [];
      const collectTerms = (term) => {
        const value = unparenthesizedExpression(term);
        if (ts.isBinaryExpression(value) && value.operatorToken.kind === operator) {
          collectTerms(value.left);
          collectTerms(value.right);
        } else {
          terms.push(normalizedBooleanRole(value, containingFile));
        }
      };
      collectTerms(candidate);
      return `${operator}(${terms.sort().join(",")})`;
    }
    if (
      ts.isPrefixUnaryExpression(candidate) &&
      candidate.operator === ts.SyntaxKind.ExclamationToken
    ) {
      return `!${normalizedBooleanRole(candidate.operand, containingFile)}`;
    }
    return astFingerprint(candidate, containingFile);
  };
  const rootGateIf = rootTry?.parent?.parent;
  const unacquiredGateIf = noResidueTry?.parent?.parent;
  const exactGateConditions = Boolean(
    rootGateIf &&
      ts.isIfStatement(rootGateIf) &&
      rootGateIf.thenStatement === rootTry.parent &&
      normalizedBooleanRole(rootGateIf.expression) ===
        normalizedBooleanRole(expectedRootGate.expression, canonicalGateFile) &&
      unacquiredGateIf &&
      ts.isIfStatement(unacquiredGateIf) &&
      unacquiredGateIf.thenStatement === noResidueTry.parent &&
      normalizedBooleanRole(unacquiredGateIf.expression) ===
        normalizedBooleanRole(expectedUnacquiredGate.expression, canonicalGateFile),
  );
  const falseGateFailure = Boolean(
    rootGateIf &&
      ts.isIfStatement(rootGateIf) &&
      rootGateIf.elseStatement &&
      ts.isBlock(rootGateIf.elseStatement) &&
      rootGateIf.elseStatement.statements.length === 1 &&
      callsWithPath(rootGateIf.elseStatement, `${derivedRoles.cleanup}.push`).length === 1 &&
      (() => {
        const push = callsWithPath(rootGateIf.elseStatement, `${derivedRoles.cleanup}.push`)[0];
        const statement = directStatementInBlock(push, rootGateIf.elseStatement);
        const failure = unparenthesizedExpression(push.arguments[0]);
        return Boolean(
          push.arguments.length === 1 &&
            statement &&
            rootGateIf.elseStatement.statements[0] === statement &&
            ts.isExpressionStatement(statement) &&
            unparenthesizedExpression(statement.expression) === push &&
            failure &&
            ts.isNewExpression(failure) &&
            ts.isIdentifier(failure.expression) &&
            failure.expression.text === "Error",
        );
      })(),
  );

  const rootRemovalCalls = rootTry
    ? callsWithPath(rootTry.tryBlock, "rm").filter(
        (call) => !id(call.arguments[0], derivedRoles.root),
      )
    : [];
  const exactLeafRemoval = (call, name, block) => {
    if (!call || !block) return false;
    const options = call.arguments[1];
    const properties = ts.isObjectLiteralExpression(options)
      ? options.properties.filter(ts.isPropertyAssignment)
      : [];
    const propertyMap = new Map(
      properties.map((property) => [
        propertyNameStaticValue(property.name, testFile),
        property.initializer.kind,
      ]),
    );
    return (
      call.arguments.length === 2 &&
      properties.length === 2 &&
      options.properties.length === 2 &&
      directAwaitedExpressionStatement(call, block) &&
      id(call.arguments[0], name) &&
      propertyMap.get("force") === ts.SyntaxKind.FalseKeyword &&
      propertyMap.get("recursive") === ts.SyntaxKind.FalseKeyword
    );
  };
  const exactRootDirectoryRemoval = (call, block) =>
    Boolean(
      call &&
        block &&
        call.arguments.length === 1 &&
        id(call.arguments[0], derivedRoles.root) &&
        directAwaitedExpressionStatement(call, block),
    );
  const filterCallbacks = [];
  if (rootTry) {
    visitNode(rootTry.tryBlock, (node) => {
      if (
        ts.isCallExpression(node) &&
        staticAuthorityPath(node.expression, testFile)?.at(-1) === "filter"
      ) {
        filterCallbacks.push(node.arguments[0]);
      }
    });
  }
  const exactRootEntryFilter = (callbackNode) => {
    if (
      !callbackNode ||
      (!ts.isArrowFunction(callbackNode) && !ts.isFunctionExpression(callbackNode)) ||
      callbackNode.parameters.length !== 1 ||
      !ts.isIdentifier(callbackNode.parameters[0].name)
    ) {
      return false;
    }
    const parameterName = callbackNode.parameters[0].name.text;
    const bodyExpression = unparenthesizedExpression(callbackNode.body);
    if (
      !ts.isPrefixUnaryExpression(bodyExpression) ||
      bodyExpression.operator !== ts.SyntaxKind.ExclamationToken
    ) {
      return false;
    }
    const includesCall = unparenthesizedExpression(bodyExpression.operand);
    const member = ts.isCallExpression(includesCall)
      ? unparenthesizedExpression(includesCall.expression)
      : undefined;
    if (
      !ts.isCallExpression(includesCall) ||
      !ts.isPropertyAccessExpression(member) ||
      member.name.text !== "includes" ||
      includesCall.arguments.length !== 1 ||
      !id(includesCall.arguments[0], parameterName)
    ) {
      return false;
    }
    const allowedEntries = unparenthesizedExpression(member.expression);
    return Boolean(
      ts.isArrayLiteralExpression(allowedEntries) &&
        allowedEntries.elements.length === 2 &&
        JSON.stringify(
          allowedEntries.elements.map((entry) => resolvedStaticStringValue(entry, testFile)).sort(),
        ) === JSON.stringify(["grandchild.stop", "ready.json"]),
    );
  };
  const rootEntryDeclarations = rootTry
    ? directDeclarations(rootTry.tryBlock).filter((declaration) =>
        callsWithPath(declaration.initializer, "readdir").some(
          (call) => call.arguments.length === 1 && id(call.arguments[0], derivedRoles.root),
        ),
      )
    : [];
  const rootEntriesName =
    rootEntryDeclarations.length === 1 ? declarationName(rootEntryDeclarations[0]) : undefined;
  const leafRemovalContract = (pathName, entryName) => {
    if (!rootTry) return undefined;
    const removal = rootRemovalCalls.find((call) => id(call.arguments[0], pathName));
    let leafBlock = removal?.parent;
    while (leafBlock && !ts.isBlock(leafBlock)) leafBlock = leafBlock.parent;
    const leafIf = leafBlock?.parent;
    if (!leafBlock || !ts.isBlock(leafBlock) || !leafIf || !ts.isIfStatement(leafIf)) {
      return undefined;
    }
    const expectedConditionFile = ts.createSourceFile(
      `canonical-${pathName}-condition`,
      `if(${rootEntriesName}.includes(${JSON.stringify(entryName)})){}`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const expectedCondition = expectedConditionFile.statements[0];
    const revalidations = leafBlock.statements.filter(exactRootRevalidationStatement);
    const revalidation = revalidations.length === 1 ? revalidations[0] : undefined;
    const removalStatement = directAwaitedExpressionStatement(removal, leafBlock);
    if (
      leafIf.parent !== rootTry.tryBlock ||
      leafIf.thenStatement !== leafBlock ||
      leafIf.elseStatement ||
      revalidations.length !== 1 ||
      !exactRootRevalidationStatement(revalidation) ||
      !precedesWithoutInterveningEffect(leafBlock, revalidation, removalStatement) ||
      !exactLeafRemoval(removal, pathName, leafBlock) ||
      !ts.isIfStatement(expectedCondition) ||
      astFingerprint(leafIf.expression, testFile) !==
        astFingerprint(expectedCondition.expression, expectedConditionFile)
    ) {
      return undefined;
    }
    return { leafIf, removal, revalidation };
  };
  const readyRemoval = leafRemovalContract(derivedRoles.readyPath, "ready.json");
  const stopRemoval = leafRemovalContract(derivedRoles.stopPath, "grandchild.stop");
  const rootReaddirCalls = rootTry
    ? callsWithPath(rootTry.tryBlock, "readdir").filter(
        (call) => call.arguments.length === 1 && id(call.arguments[0], derivedRoles.root),
      )
    : [];
  const rootEntryStatement = rootEntryDeclarations[0]
    ? directStatementInBlock(rootEntryDeclarations[0], rootTry.tryBlock)
    : undefined;
  const initialReaddir = rootReaddirCalls.find(
    (call) => directStatementInBlock(call, rootTry?.tryBlock) === rootEntryStatement,
  );
  const rootEntryInitializer = unparenthesizedExpression(rootEntryDeclarations[0]?.initializer);
  const rootEntrySortMember =
    rootEntryInitializer && ts.isCallExpression(rootEntryInitializer)
      ? unparenthesizedExpression(rootEntryInitializer.expression)
      : undefined;
  const rootEntryAwait =
    rootEntrySortMember && ts.isPropertyAccessExpression(rootEntrySortMember)
      ? unparenthesizedExpression(rootEntrySortMember.expression)
      : undefined;
  const exactRootInventory = Boolean(
    rootEntryInitializer &&
      ts.isCallExpression(rootEntryInitializer) &&
      rootEntryInitializer.arguments.length === 0 &&
      ts.isPropertyAccessExpression(rootEntrySortMember) &&
      rootEntrySortMember.name.text === "sort" &&
      ts.isAwaitExpression(rootEntryAwait) &&
      unparenthesizedExpression(rootEntryAwait.expression) === initialReaddir,
  );
  const finalEmptyCandidates = rootReaddirCalls
    .map((call) => {
      const statement = rootTry ? directStatementInBlock(call, rootTry.tryBlock) : undefined;
      const assertions = statement ? callsWithPath(statement, "assert.deepEqual") : [];
      const assertion = assertions.length === 1 ? assertions[0] : undefined;
      const firstArgument = unparenthesizedExpression(assertion?.arguments[0]);
      return assertion &&
        assertion.arguments.length === 2 &&
        ts.isAwaitExpression(firstArgument) &&
        unparenthesizedExpression(firstArgument.expression) === call &&
        ts.isArrayLiteralExpression(assertion.arguments[1]) &&
        assertion.arguments[1].elements.length === 0
        ? { assertion, call, statement }
        : undefined;
    })
    .filter(Boolean);
  const finalEmpty = finalEmptyCandidates[0];
  const finalReaddir = finalEmpty?.call;
  const finalReaddirStatement = finalEmpty?.statement;
  const finalEmptyAssertion = finalEmpty?.assertion;
  const rootCleanupStatement = rootTry
    ? directAwaitedExpressionStatement(rootCleanupCalls[0], rootTry.tryBlock)
    : undefined;
  const rootCleanupIndex = rootTry?.tryBlock.statements.indexOf(rootCleanupStatement) ?? -1;
  const rootEntryIndex = rootTry?.tryBlock.statements.indexOf(rootEntryStatement) ?? -1;
  const directRootRevalidationStatements = rootTry
    ? rootTry.tryBlock.statements.filter(
        (statement, index) => index < rootEntryIndex && exactRootRevalidationStatement(statement),
      )
    : [];
  const directRootRevalidationStatement =
    directRootRevalidationStatements.length === 1 ? directRootRevalidationStatements[0] : undefined;
  const finalReaddirIndex = rootTry?.tryBlock.statements.indexOf(finalReaddirStatement) ?? -1;
  const finalRootRevalidationStatements = rootTry
    ? rootTry.tryBlock.statements.filter(
        (statement, index) =>
          index > finalReaddirIndex &&
          index < rootCleanupIndex &&
          exactRootRevalidationStatement(statement),
      )
    : [];
  const finalRootRevalidationStatement =
    finalRootRevalidationStatements.length === 1 ? finalRootRevalidationStatements[0] : undefined;
  const filterStatement =
    rootTry && filterCallbacks[0]
      ? directStatementInBlock(filterCallbacks[0], rootTry.tryBlock)
      : undefined;
  const exactRootCleanup = Boolean(
    rootCleanupCalls.length === 1 &&
      rootTry &&
      exactRootDirectoryRemoval(rootCleanupCalls[0], rootTry.tryBlock) &&
      rootRemovalCalls.length === 2 &&
      readyRemoval &&
      stopRemoval &&
      rootEntryDeclarations.length === 1 &&
      isConstVariableDeclaration(rootEntryDeclarations[0]) &&
      rootEntryDeclarations[0].parent.declarations.length === 1 &&
      initialReaddir &&
      isAwaited(initialReaddir) &&
      nodeIsWithin(initialReaddir, rootEntryDeclarations[0].initializer) &&
      exactRootInventory &&
      finalReaddir &&
      isAwaited(finalReaddir) &&
      finalEmptyCandidates.length === 1 &&
      finalEmptyAssertion &&
      filterCallbacks.length === 1 &&
      exactRootEntryFilter(filterCallbacks[0]) &&
      exactRootRevalidationStatement(directRootRevalidationStatement) &&
      precedesWithoutInterveningEffect(
        rootTry.tryBlock,
        directRootRevalidationStatement,
        rootEntryStatement,
      ) &&
      rootTry.tryBlock.statements.indexOf(filterStatement) >
        rootTry.tryBlock.statements.indexOf(rootEntryStatement) &&
      rootTry.tryBlock.statements.indexOf(readyRemoval.leafIf) >
        rootTry.tryBlock.statements.indexOf(filterStatement) &&
      rootTry.tryBlock.statements.indexOf(stopRemoval.leafIf) >
        rootTry.tryBlock.statements.indexOf(filterStatement) &&
      rootTry.tryBlock.statements.indexOf(finalReaddirStatement) >
        rootTry.tryBlock.statements.indexOf(readyRemoval.leafIf) &&
      rootTry.tryBlock.statements.indexOf(finalReaddirStatement) >
        rootTry.tryBlock.statements.indexOf(stopRemoval.leafIf) &&
      precedesWithoutInterveningEffect(
        rootTry.tryBlock,
        finalReaddirStatement,
        finalRootRevalidationStatement,
      ) &&
      exactRootRevalidationStatement(finalRootRevalidationStatement) &&
      precedesWithoutInterveningEffect(
        rootTry.tryBlock,
        finalRootRevalidationStatement,
        rootCleanupStatement,
      ),
  );

  const primaryJoinCalls = callsWithPath(outerTry.tryBlock, "Promise.all");
  const primaryJoin = primaryJoinCalls[0];
  const primaryJoinElements =
    primaryJoin && ts.isArrayLiteralExpression(primaryJoin.arguments[0])
      ? primaryJoin.arguments[0].elements.map(unparenthesizedExpression)
      : [];
  const exactIdentityWait = (call, identityName) =>
    Boolean(
      call &&
        ts.isCallExpression(call) &&
        isCallNamed(call, "waitForExactProcessExit") &&
        call.arguments.length === 2 &&
        id(call.arguments[0], identityName) &&
        Number.isSafeInteger(numericLiteralValue(call.arguments[1])) &&
        numericLiteralValue(call.arguments[1]) >= 5_000 &&
        numericLiteralValue(call.arguments[1]) <= 20_000,
    );
  const primaryLeaderWait = primaryJoinElements.find((call) =>
    exactIdentityWait(call, derivedRoles.leaderIdentity),
  );
  const primaryGrandchildWait = primaryJoinElements.find((call) =>
    exactIdentityWait(call, derivedRoles.grandchildIdentity),
  );
  const primaryJoinStatement = directAwaitedExpressionStatement(primaryJoin, outerTry.tryBlock);
  const exactPrimaryJoin = Boolean(
    primaryJoinCalls.length === 1 &&
      primaryJoin?.arguments.length === 1 &&
      primaryJoinElements.length === 2 &&
      primaryLeaderWait &&
      primaryGrandchildWait &&
      primaryJoinStatement,
  );

  const trueAssignments = (name) =>
    identifierMutationNodes(callback, name).filter(
      (mutation) =>
        ts.isBinaryExpression(mutation) &&
        mutation.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        id(mutation.left, name) &&
        mutation.right.kind === ts.SyntaxKind.TrueKeyword,
    );
  const leaderProofWrites = trueAssignments(derivedRoles.leaderProof);
  const grandchildProofWrites = trueAssignments(derivedRoles.grandchildProof);
  const wrapperProofWrites = identifierMutationNodes(callback, derivedRoles.wrapperProof);
  const unacquiredProofWrites = trueAssignments(derivedRoles.unacquiredProof);
  const directAssignmentStatement = (assignment, block) => {
    const statement = directStatementInBlock(assignment, block);
    return statement &&
      ts.isExpressionStatement(statement) &&
      unparenthesizedExpression(statement.expression) === assignment
      ? statement
      : undefined;
  };
  const primaryLeaderWrite = leaderProofWrites.find((assignment) =>
    directAssignmentStatement(assignment, outerTry.tryBlock),
  );
  const primaryGrandchildWrite = grandchildProofWrites.find((assignment) =>
    directAssignmentStatement(assignment, outerTry.tryBlock),
  );
  const finalLeaderWrite = leaderProofWrites.find((assignment) =>
    directAssignmentStatement(assignment, leaderTry?.tryBlock),
  );
  const finalGrandchildWrite = grandchildProofWrites.find((assignment) =>
    directAssignmentStatement(assignment, grandchildTry?.tryBlock),
  );
  const primaryJoinIndex = outerTry.tryBlock.statements.indexOf(primaryJoinStatement);
  const primaryWriteStatements = new Set([
    directAssignmentStatement(primaryLeaderWrite, outerTry.tryBlock),
    directAssignmentStatement(primaryGrandchildWrite, outerTry.tryBlock),
  ]);
  const finalLeaderWaitStatement = directAwaitedExpressionStatement(
    finalLeaderWaits[0],
    leaderTry?.tryBlock,
  );
  const finalGrandchildWaitStatement = directAwaitedExpressionStatement(
    finalGrandchildWaits[0],
    grandchildTry?.tryBlock,
  );
  const finalLeaderWriteStatement = directAssignmentStatement(
    finalLeaderWrite,
    leaderTry?.tryBlock,
  );
  const finalGrandchildWriteStatement = directAssignmentStatement(
    finalGrandchildWrite,
    grandchildTry?.tryBlock,
  );
  const wrapperFinishStatement = directAwaitedExpressionStatement(
    wrapperFinishCalls[0],
    wrapperTry?.tryBlock,
  );
  const wrapperIdentityWaitStatement = awaitedExpressionStatement(wrapperIdentityWaits[0]);
  const wrapperIdentityGuard = wrapperIdentityWaitStatement?.parent;
  const wrapperWriteStatement = directAssignmentStatement(
    wrapperProofWrites[0],
    wrapperTry?.tryBlock,
  );
  const expectedWrapperProofFile = ts.createSourceFile(
    "canonical-wrapper-close-proof",
    `const proof=${derivedRoles.wrapper}.settled&&${derivedRoles.wrapper}.phase==="finalized";`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const expectedWrapperProof = directVariableDeclarations(expectedWrapperProofFile, "proof")[0]
    ?.initializer;
  const unacquiredProofStatement = directAssignmentStatement(
    unacquiredProofWrites[0],
    noResidueTry?.tryBlock,
  );
  const noResidueStatement = directAwaitedExpressionStatement(
    noResidueCalls[0],
    noResidueTry?.tryBlock,
  );
  const exactProofDominance = Boolean(
    leaderProofWrites.length === 2 &&
      grandchildProofWrites.length === 2 &&
      primaryWriteStatements.size === 2 &&
      primaryJoinIndex >= 0 &&
      [...primaryWriteStatements].every((statement) =>
        precedesWithoutInterveningEffect(
          outerTry.tryBlock,
          primaryJoinStatement,
          statement,
          primaryWriteStatements,
        ),
      ) &&
      precedesWithoutInterveningEffect(
        leaderTry?.tryBlock,
        finalLeaderWaitStatement,
        finalLeaderWriteStatement,
      ) &&
      precedesWithoutInterveningEffect(
        grandchildTry?.tryBlock,
        finalGrandchildWaitStatement,
        finalGrandchildWriteStatement,
      ) &&
      wrapperProofWrites.length === 1 &&
      wrapperIdentityGuard &&
      ts.isIfStatement(wrapperIdentityGuard) &&
      wrapperIdentityGuard.parent === wrapperTry.tryBlock &&
      precedesWithoutInterveningEffect(
        wrapperTry.tryBlock,
        wrapperFinishStatement,
        wrapperIdentityGuard,
      ) &&
      ts.isPropertyAccessExpression(unparenthesizedExpression(wrapperIdentityGuard.expression)) &&
      id(
        unparenthesizedExpression(wrapperIdentityGuard.expression).expression,
        derivedRoles.wrapper,
      ) &&
      unparenthesizedExpression(wrapperIdentityGuard.expression).name.text === "identity" &&
      wrapperIdentityGuard.thenStatement === wrapperIdentityWaitStatement &&
      precedesWithoutInterveningEffect(
        wrapperTry.tryBlock,
        wrapperIdentityGuard,
        wrapperWriteStatement,
      ) &&
      expectedWrapperProof &&
      astFingerprint(wrapperProofWrites[0].right, testFile) ===
        astFingerprint(expectedWrapperProof, expectedWrapperProofFile) &&
      unacquiredProofWrites.length === 1 &&
      precedesWithoutInterveningEffect(
        noResidueTry?.tryBlock,
        noResidueStatement,
        unacquiredProofStatement,
      ),
  );
  const exactAcquisitionWrites = [
    derivedRoles.wrapper,
    derivedRoles.leaderIdentity,
    derivedRoles.grandchildIdentity,
  ].every((name) => {
    const mutations = identifierMutationNodes(callback, name);
    return (
      mutations.length === 1 &&
      ts.isBinaryExpression(mutations[0]) &&
      mutations[0].operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      id(mutations[0].left, name) &&
      nodeIsWithin(mutations[0], outerTry.tryBlock)
    );
  });
  const noDirectSinkMutation = identifierMutationNodes(callback, derivedRoles.cleanup).length === 0;

  const cooperativeStop = Boolean(
    exactRegistrationEnvelope &&
      stateDeclarationsExact &&
      exactPrimaryFailureCapture &&
      exactFailurePropagation &&
      exactStopPublication &&
      exactPrimaryJoin &&
      independentCleanupAttempts &&
      exactProofDominance &&
      exactAcquisitionWrites &&
      noDirectSinkMutation &&
      cleanupSinkMethodsClosed &&
      !prematureControlFlow &&
      !reflectiveStateMutation &&
      exactHelperBindings &&
      cleanupFailureSinkClosed,
  );
  return {
    cooperativeStop,
    rootGate: Boolean(
      cooperativeStop &&
        exactRootCapture &&
        exactGateConditions &&
        falseGateFailure &&
        exactRootCleanup,
    ),
  };
}

function collectManagedChildLifecycleDiagnostics(harnessSource, testSource, label) {
  const diagnostics = [];
  const harnessFile = ts.createSourceFile(
    `${label}-harness`,
    harnessSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const testFile = ts.createSourceFile(
    `${label}-test`,
    testSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const canonicalFile = ts.createSourceFile(
    "canonical-managed-child-lifecycle",
    canonicalManagedChildLifecycleSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (
    harnessFile.parseDiagnostics.length ||
    testFile.parseDiagnostics.length ||
    canonicalFile.parseDiagnostics.length
  ) {
    return [`${label}:parse-error`];
  }

  const exactFunction = (name, category) => {
    const actual = uniqueTopLevelFunctionDeclaration(harnessFile, name);
    const canonical = uniqueTopLevelFunctionDeclaration(canonicalFile, name);
    const exact = Boolean(
      actual &&
        canonical &&
        sourceLevelBindingNodes(harnessFile, name).length === 1 &&
        namedBindingNodes(harnessFile, name).length === 1 &&
        !hasAuthorityMutation(harnessFile, name) &&
        astFingerprint(actual, harnessFile) === astFingerprint(canonical, canonicalFile),
    );
    if (!exact) diagnostics.push(`${label}:${category}`);
    return exact ? actual : undefined;
  };
  const actualReceiptDeclarations = directVariableDeclarations(
    harnessFile,
    "managedChildCloseReceipts",
  );
  const canonicalReceiptDeclarations = directVariableDeclarations(
    canonicalFile,
    "managedChildCloseReceipts",
  );
  if (
    actualReceiptDeclarations.length !== 1 ||
    canonicalReceiptDeclarations.length !== 1 ||
    !isConstVariableDeclaration(actualReceiptDeclarations[0]) ||
    sourceLevelBindingNodes(harnessFile, "managedChildCloseReceipts").length !== 1 ||
    hasAuthorityMutation(harnessFile, "managedChildCloseReceipts") ||
    astFingerprint(actualReceiptDeclarations[0], harnessFile) !==
      astFingerprint(canonicalReceiptDeclarations[0], canonicalFile)
  ) {
    diagnostics.push(`${label}:managed-child-receipt-contract`);
  }
  exactFunction("managedChildCloseReceipt", "managed-child-receipt-contract");
  exactFunction("registerManagedChild", "managed-child-registration-contract");
  exactFunction("stopChild", "managed-child-stop-contract");
  exactFunction("readProcessGroupMembers", "managed-child-group-contract");
  exactFunction("stopManagedChildren", "managed-child-join-contract");
  exactFunction("captureTemporaryRoot", "temporary-root-capture-contract");
  exactFunction("assertTemporaryRootOwned", "temporary-root-identity-contract");

  const actualRunHarness = uniqueTopLevelFunctionDeclaration(harnessFile, "runHarness");
  const canonicalRunHarness = uniqueTopLevelFunctionDeclaration(canonicalFile, "runHarness");
  const actualChildCleanup = actualRunHarness
    ? cleanupStepByName(actualRunHarness, harnessFile, "child-processes")
    : undefined;
  const actualTemporaryCleanup = actualRunHarness
    ? cleanupStepByName(actualRunHarness, harnessFile, "temporary-state")
    : undefined;
  const canonicalChildCleanup = cleanupStepByName(
    canonicalRunHarness,
    canonicalFile,
    "child-processes",
  );
  const canonicalTemporaryCleanup = cleanupStepByName(
    canonicalRunHarness,
    canonicalFile,
    "temporary-state",
  );
  if (
    !actualChildCleanup ||
    !canonicalChildCleanup ||
    astFingerprint(actualChildCleanup, harnessFile) !==
      astFingerprint(canonicalChildCleanup, canonicalFile)
  ) {
    diagnostics.push(`${label}:managed-child-cleanup-receipt-contract`);
  }
  if (
    !actualTemporaryCleanup ||
    !canonicalTemporaryCleanup ||
    astFingerprint(actualTemporaryCleanup, harnessFile) !==
      astFingerprint(canonicalTemporaryCleanup, canonicalFile)
  ) {
    diagnostics.push(`${label}:temporary-root-removal-contract`);
  }

  const exactRunHarnessStatement = (leftName) => {
    const statements = [];
    for (const functionNode of [actualRunHarness, canonicalRunHarness]) {
      const matches = [];
      if (functionNode) {
        visitNode(functionNode, (node) => {
          if (
            ts.isExpressionStatement(node) &&
            ts.isBinaryExpression(node.expression) &&
            node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.expression.left) &&
            node.expression.left.text === leftName
          ) {
            matches.push(node);
          }
        });
      }
      statements.push(matches);
    }
    return (
      statements[0].length === 1 &&
      statements[1].length === 1 &&
      astFingerprint(statements[0][0], harnessFile) ===
        astFingerprint(statements[1][0], canonicalFile)
    );
  };
  if (
    !actualRunHarness ||
    sourceLevelBindingNodes(harnessFile, "runHarness").length !== 1 ||
    !exactRunHarnessStatement("temporaryRoot") ||
    !exactRunHarnessStatement("temporaryRootOwned")
  ) {
    diagnostics.push(`${label}:temporary-root-capture-order-contract`);
  }
  const actualManagedDeclarations = directVariableDeclarations(
    actualRunHarness?.body,
    "managedChildrenClosed",
  );
  const canonicalManagedDeclarations = directVariableDeclarations(
    canonicalRunHarness?.body,
    "managedChildrenClosed",
  );
  const actualOwnedDeclarations = directVariableDeclarations(
    actualRunHarness?.body,
    "temporaryRootOwned",
  );
  const canonicalOwnedDeclarations = directVariableDeclarations(
    canonicalRunHarness?.body,
    "temporaryRootOwned",
  );
  if (
    actualManagedDeclarations.length !== 1 ||
    canonicalManagedDeclarations.length !== 1 ||
    actualOwnedDeclarations.length !== 1 ||
    canonicalOwnedDeclarations.length !== 1 ||
    astFingerprint(actualManagedDeclarations[0], harnessFile) !==
      astFingerprint(canonicalManagedDeclarations[0], canonicalFile) ||
    astFingerprint(actualOwnedDeclarations[0], harnessFile) !==
      astFingerprint(canonicalOwnedDeclarations[0], canonicalFile) ||
    identifierMutationNodes(actualRunHarness, "managedChildrenClosed").length !== 1 ||
    identifierMutationNodes(actualRunHarness, "temporaryRootOwned").length !== 1
  ) {
    diagnostics.push(`${label}:temporary-root-authority-state-contract`);
  }

  const selfHeal = directNamedTestRegistration(
    testFile,
    "a second signal immediately escalates a resistant child group",
    "HR browser harness contracts",
  );
  const selfHealContract = doubleSignalCleanupContract(testFile, selfHeal);
  if (!selfHealContract.cooperativeStop) {
    diagnostics.push(`${label}:double-signal-cooperative-stop`);
  }
  if (!selfHealContract.rootGate) {
    diagnostics.push(`${label}:double-signal-root-gate`);
  }

  return [...new Set(diagnostics)].sort();
}

function canonicalRetainedOwnerAuthoritySource() {
  return `
function signalRetainedBrowser(signal) {
  retainRegistrationWithoutAck();
  if (!activeBrowserIdentity) return;
  const allowParentDrift = exactHarnessExitWasObserved(activeBrowserIdentity);
  const liveIdentity = readProcessIdentity(activeBrowserIdentity.pid);
  const leaderState = classifyRetainedLeader(
    activeBrowserIdentity,
    liveIdentity,
    liveIdentity ? true : processGroupExists(activeBrowserIdentity.pgid),
    allowParentDrift,
  );
  if (leaderState === "absent") return;
  if (leaderState !== "owned") throw new Error("Retained browser leader identity is ambiguous");
  if (
    !sameRetainedBrowserIdentity(activeBrowserIdentity, liveIdentity, allowParentDrift) ||
    !ownsRetainedBrowserOwnership(activeBrowserIdentity) ||
    !commandUsesRetainedBrowser(liveIdentity, browserControl)
  ) {
    throw new Error("Retained browser identity changed before signaling");
  }
  const finalIdentity = readProcessIdentity(activeBrowserIdentity.pid);
  if (
    !sameProcessIdentity(liveIdentity, finalIdentity) ||
    !sameRetainedBrowserIdentity(activeBrowserIdentity, finalIdentity, allowParentDrift) ||
    !ownsRetainedBrowserOwnership(activeBrowserIdentity) ||
    !commandUsesRetainedBrowser(finalIdentity, browserControl)
  ) {
    throw new Error("Retained browser identity changed at the signal boundary");
  }
  signalProcessGroup(activeBrowserIdentity.pgid, signal);
}

async function drainRetainedBrowserGroup() {
  if (!superviseBrowser || !browserControl) return;
  if (!activeBrowserIdentity) retainRegistrationWithoutAck();
  if (!activeBrowserIdentity) return;
  const allowParentDrift = exactHarnessExitWasObserved(activeBrowserIdentity);
  let liveIdentity = readProcessIdentity(activeBrowserIdentity.pid);
  const leaderState = classifyRetainedLeader(
    activeBrowserIdentity,
    liveIdentity,
    liveIdentity ? true : processGroupExists(activeBrowserIdentity.pgid),
    allowParentDrift,
  );
  if (leaderState === "absent") return;
  if (leaderState !== "owned") throw new Error("Browser group ownership is ambiguous");
  if (
    !sameRetainedBrowserIdentity(activeBrowserIdentity, liveIdentity, allowParentDrift) ||
    !ownsRetainedBrowserOwnership(activeBrowserIdentity) ||
    !commandUsesRetainedBrowser(liveIdentity, browserControl)
  ) {
    throw new Error("Retained browser identity changed before cleanup");
  }
  const termIdentity = readProcessIdentity(activeBrowserIdentity.pid);
  if (
    !sameProcessIdentity(liveIdentity, termIdentity) ||
    !sameRetainedBrowserIdentity(activeBrowserIdentity, termIdentity, allowParentDrift) ||
    !ownsRetainedBrowserOwnership(activeBrowserIdentity) ||
    !commandUsesRetainedBrowser(termIdentity, browserControl)
  ) {
    throw new Error("Retained browser identity changed at the TERM boundary");
  }
  signalProcessGroup(activeBrowserIdentity.pgid, "SIGTERM");
  if (await waitForProcessGroupExit(activeBrowserIdentity.pgid, processGroupGraceMs)) return;
  liveIdentity = readProcessIdentity(activeBrowserIdentity.pid);
  if (
    !liveIdentity ||
    !sameRetainedBrowserIdentity(activeBrowserIdentity, liveIdentity, allowParentDrift) ||
    !ownsRetainedBrowserOwnership(activeBrowserIdentity) ||
    !commandUsesRetainedBrowser(liveIdentity, browserControl)
  ) {
    throw new Error("Retained browser identity became ambiguous before SIGKILL");
  }
  const killIdentity = readProcessIdentity(activeBrowserIdentity.pid);
  if (
    !sameProcessIdentity(liveIdentity, killIdentity) ||
    !sameRetainedBrowserIdentity(activeBrowserIdentity, killIdentity, allowParentDrift) ||
    !ownsRetainedBrowserOwnership(activeBrowserIdentity) ||
    !commandUsesRetainedBrowser(killIdentity, browserControl)
  ) {
    throw new Error("Retained browser identity changed at the SIGKILL boundary");
  }
  signalProcessGroup(activeBrowserIdentity.pgid, "SIGKILL");
  if (!(await waitForProcessGroupExit(activeBrowserIdentity.pgid, processGroupKillMs))) {
    throw new Error("Retained browser process group survived SIGKILL");
  }
}

function signalRetainedHarness(
  signal,
  expectedChild = activeChild,
  expectedIdentity = activeHarnessIdentity,
) {
  const child = activeChild;
  const identity = activeHarnessIdentity;
  if (child !== expectedChild || identity !== expectedIdentity) {
    throw new Error("Retained harness references changed before group signaling");
  }
  if (!child && !identity) return "absent";
  if (!child || !identity) {
    throw new Error("Retained harness child and identity state do not match");
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    if (processGroupExists(identity.pgid)) {
      throw new Error("Harness leader exited while its process group still exists");
    }
    return "absent";
  }
  const liveIdentity = readProcessIdentity(identity.pid);
  if (
    !sameOwnedProcessIdentity(identity, liveIdentity) ||
    liveIdentity.pgid !== identity.pid ||
    !processOwnsExactDescriptor(identity.pid, harnessOwnershipDescriptor, identity.ownership)
  ) {
    throw new Error("Retained harness identity changed before group signaling");
  }
  const finalIdentity = readProcessIdentity(identity.pid);
  if (
    !sameProcessIdentity(liveIdentity, finalIdentity) ||
    !sameOwnedProcessIdentity(identity, finalIdentity) ||
    !processOwnsExactDescriptor(identity.pid, harnessOwnershipDescriptor, identity.ownership)
  ) {
    throw new Error("Retained harness identity changed at the signal boundary");
  }
  signalProcessGroup(identity.pgid, signal);
  return "signaled";
}
`;
}

function canonicalProcessGroupAuthoritySource() {
  return [
    'const supportedProcessGroupSignals = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);',
    "function assertPositiveProcessGroupId(processGroupId) {",
    "  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {",
    '    throw new Error("Process-group identifier is invalid");',
    "  }",
    "}",
    "function signalProcessGroup(processGroupId, signal) {",
    "  assertPositiveProcessGroupId(processGroupId);",
    "  if (!supportedProcessGroupSignals.has(signal)) {",
    '    throw new Error("Process-group signal is unsupported");',
    "  }",
    '  if (process.platform === "win32") {',
    '    throw new Error("POSIX process-group cleanup is required by the test harness");',
    "  }",
    "  try {",
    "    process.kill(-processGroupId, signal);",
    "  } catch (error) {",
    '    if (error?.code !== "ESRCH") throw error;',
    "  }",
    "}",
    "function processGroupExists(processGroupId) {",
    "  assertPositiveProcessGroupId(processGroupId);",
    '  if (process.platform === "win32") return false;',
    "  try {",
    "    process.kill(-processGroupId, 0);",
    "    return true;",
    "  } catch (error) {",
    "    return classifyProcessGroupProbeError(error);",
    "  }",
    "}",
    canonicalRetainedOwnerAuthoritySource(),
    "if (isMain && superviseBrowser) {",
    "  if (receivedSignal) {",
    "    if (failure) process.stderr.write(`${sanitizeSupervisedFailure(failure)}\\n`);",
    "    process.kill(process.pid, receivedSignal);",
    "  }",
    "}",
  ].join("\n");
}

function hasExactMonitorBrowserAckSequence(sourceFile) {
  const monitor = uniqueTopLevelFunctionDeclaration(sourceFile, "monitorBrowserRegistration");
  if (
    !monitor ||
    sourceLevelBindingNodes(sourceFile, "monitorBrowserRegistration").length !== 1 ||
    namedBindingNodes(sourceFile, "monitorBrowserRegistration").length !== 1 ||
    hasAuthorityMutation(sourceFile, "monitorBrowserRegistration")
  ) {
    return false;
  }
  const ackCalls = [];
  visitNode(monitor.body, (node) => {
    if (ts.isCallExpression(node) && isCallNamed(node, "publishBrowserAck")) {
      ackCalls.push(node);
    }
  });
  if (ackCalls.length !== 1) return false;
  const ackCall = ackCalls[0];
  let ackStatement = ackCall;
  while (ackStatement.parent && !ts.isBlock(ackStatement.parent)) {
    ackStatement = ackStatement.parent;
  }
  const block = ackStatement.parent;
  if (!ts.isBlock(block) || !ts.isExpressionStatement(ackStatement)) return false;
  const index = block.statements.indexOf(ackStatement);
  if (index < 3 || index + 1 >= block.statements.length) return false;
  const identityDeclarationStatement = block.statements[index - 3];
  const identityAssignmentStatement = block.statements[index - 2];
  const cancellationGuard = block.statements[index - 1];
  const identityReturn = block.statements[index + 1];
  const identityDeclarations = directVariableDeclarations(
    ts.factory.createBlock([identityDeclarationStatement], true),
    "identity",
  );
  const identityDeclaration = identityDeclarations[0];
  const identityInitializer = unparenthesizedExpression(identityDeclaration?.initializer);
  const assignment = ts.isExpressionStatement(identityAssignmentStatement)
    ? unparenthesizedExpression(identityAssignmentStatement.expression)
    : undefined;
  const exactCancellationGuard = Boolean(
    cancellationGuard &&
      ts.isIfStatement(cancellationGuard) &&
      ts.isBinaryExpression(unparenthesizedExpression(cancellationGuard.expression)) &&
      unparenthesizedExpression(cancellationGuard.expression).operatorToken.kind ===
        ts.SyntaxKind.BarBarToken &&
      ((ts.isIdentifier(unparenthesizedExpression(cancellationGuard.expression).left) &&
        unparenthesizedExpression(cancellationGuard.expression).left.text === "receivedSignal" &&
        ts.isIdentifier(unparenthesizedExpression(cancellationGuard.expression).right) &&
        unparenthesizedExpression(cancellationGuard.expression).right.text ===
          "cancellationPublishedAt") ||
        (ts.isIdentifier(unparenthesizedExpression(cancellationGuard.expression).right) &&
          unparenthesizedExpression(cancellationGuard.expression).right.text === "receivedSignal" &&
          ts.isIdentifier(unparenthesizedExpression(cancellationGuard.expression).left) &&
          unparenthesizedExpression(cancellationGuard.expression).left.text ===
            "cancellationPublishedAt")),
  );
  return Boolean(
    identityDeclarations.length === 1 &&
      identityDeclaration &&
      isConstVariableDeclaration(identityDeclaration) &&
      ts.isCallExpression(identityInitializer) &&
      isCallNamed(identityInitializer, "validateBrowserRegistration") &&
      identityInitializer.arguments.length === 2 &&
      ts.isIdentifier(identityInitializer.arguments[0]) &&
      identityInitializer.arguments[0].text === "browserControl" &&
      ts.isIdentifier(identityInitializer.arguments[1]) &&
      identityInitializer.arguments[1].text === "activeHarnessIdentity" &&
      ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(assignment.left) &&
      assignment.left.text === "activeBrowserIdentity" &&
      ts.isIdentifier(assignment.right) &&
      assignment.right.text === "identity" &&
      cancellationGuard &&
      ts.isIfStatement(cancellationGuard) &&
      exactCancellationGuard &&
      ts.isReturnStatement(cancellationGuard.thenStatement) &&
      ts.isIdentifier(cancellationGuard.thenStatement.expression) &&
      cancellationGuard.thenStatement.expression.text === "identity" &&
      ackCall.arguments.length === 2 &&
      ts.isIdentifier(ackCall.arguments[0]) &&
      ackCall.arguments[0].text === "browserControl" &&
      ts.isIdentifier(ackCall.arguments[1]) &&
      ackCall.arguments[1].text === "identity" &&
      ts.isReturnStatement(identityReturn) &&
      ts.isIdentifier(identityReturn.expression) &&
      identityReturn.expression.text === "identity",
  );
}

function topLevelFunctionOwnerName(node, sourceFile) {
  for (let current = node?.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.parent === sourceFile && current.name) {
      return current.name.text;
    }
  }
  return "top-level";
}

function hasExactCriticalWithPostgresBoundaries(sourceFile) {
  const expected = new Map([
    [
      "captureOwnershipCapability",
      "40b3cc1a9b27a4d373760e2b7514b475c1a01624810a4f51947185a9106ffd11",
    ],
    ["classifyRetainedLeader", "7bf7bc235bf2c11e43b589eb9159f3f2a537caa0e750d5044e5ffeda6cbc02c1"],
    ["cleanupBrowserRoots", "d7950ba960d5ce59be2cae392be7f66b9087cbd35d59bf10bc864ab0b54329ce"],
    ["commandUsesExactShim", "499dc003d20dfe4ca687c93827e8bbccb845b126c7257f63d8b329cd5a1f6b16"],
    [
      "commandUsesRetainedBrowser",
      "45882daa079578a33edb2eef9b366b5ed7d019ec520858c721028635653e975e",
    ],
    [
      "exactHarnessExitWasObserved",
      "779e75a8dad402822f5ed7f53e9c69110b5070179d26d0f4bb2fd0f98cfe3b4b",
    ],
    [
      "isExactHarnessExitReceipt",
      "966eae17f51517d801c9229e3cd2bdf197052bcc661ba528f654617b34899006",
    ],
    [
      "ownsRetainedBrowserOwnership",
      "03963002920a0dc0081ba555aaab2c35224421954fc5014b8e48f3d688afcdd7",
    ],
    [
      "processOwnsExactDescriptor",
      "9df6260a8a0341366decaa441e9240943bec93e38ad80fef30a0dbc5952c5533",
    ],
    ["publishBrowserAck", "148831634cb975783ceba9efe42ea98b43ce32d42a74c471630ded1e2101d4d2"],
    [
      "readProcessDescriptorIdentity",
      "8fccbc2e379944d0446c2f8807b988f98107c5654478bf4ef30e5e4ab5f21b14",
    ],
    ["readProcessIdentity", "06e16354dd8c8f5e56acbda62b9e80c516b3eced036c2618520c560921b70eae"],
    [
      "sameOwnedProcessIdentity",
      "5e6a0522dc39416ce6b70f94e9c0c2dd30c6fd8693b454bf946a7d368a7addff",
    ],
    ["sameProcessIdentity", "ca97158a8e1d71eebdbbdd78acf8e9b6954e5bb70c320c8bb687627e72a4da9f"],
    [
      "sameRetainedBrowserIdentity",
      "c997d04ecac79a00af5710d12ce5f9e1ae2e5c47fd9e6f4039b7b29340e3ade8",
    ],
    [
      "sanitizeSupervisedFailure",
      "e0e91b8e5806cfacc5a248355ed587204d2477773a42b7f69d9aebe3e30c025d",
    ],
    [
      "validateBrowserRegistration",
      "1f919fb51aef84018a36fe4d4984d5559696ae3952f818815efa427eb051b25e",
    ],
  ]);
  return [...expected].every(([name, hash]) => {
    const declaration = uniqueTopLevelFunctionDeclaration(sourceFile, name);
    return Boolean(
      declaration &&
        sourceLevelBindingNodes(sourceFile, name).length === 1 &&
        namedBindingNodes(sourceFile, name).length === 1 &&
        !hasAuthorityMutation(sourceFile, name) &&
        ts.sys.createHash(astFingerprint(declaration, sourceFile)) === hash,
    );
  });
}

function hasClosedWithPostgresExecutionAuthority(
  sourceFile,
  allowedSourceSha256 = Object.freeze([]),
) {
  const executionNames = new Set(["createRequire", "playwrightRequire", "spawn", "spawnSync"]);
  const fullExecutionSurface = sourceLevelBindingNodes(sourceFile, "spawn").length > 0;
  const callNodes = [];
  let closed =
    allowedSourceSha256.length === 0 ||
    allowedSourceSha256.includes(ts.sys.createHash(sourceFile.text));
  visitNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const path = staticAuthorityPath(node.expression, sourceFile) ?? [];
    if (!executionNames.has(path[0])) return;
    if (!ts.isIdentifier(node.expression) || path.length !== 1 || node.questionDotToken) {
      closed = false;
      return;
    }
    callNodes.push(node);
  });

  if (fullExecutionSurface) {
    if (
      !hasExactMonitorBrowserAckSequence(sourceFile) ||
      !hasExactCriticalWithPostgresBoundaries(sourceFile)
    ) {
      closed = false;
    }
    const criticalImportContracts = [
      ["node:crypto", "randomBytes"],
      ["node:fs", "linkSync"],
      ["node:fs", "lstatSync"],
      ["node:fs", "readFileSync"],
      ["node:fs", "unlinkSync"],
      ["node:fs", "writeFileSync"],
      ["node:fs/promises", "writeFile"],
    ];
    if (
      criticalImportContracts.some(
        ([moduleName, importedName]) =>
          !hasExactUnaliasedNamedImport(sourceFile, moduleName, importedName) ||
          new Set([
            ...sourceLevelBindingNodes(sourceFile, importedName),
            ...namedBindingNodes(sourceFile, importedName),
          ]).size !== 1 ||
          hasAuthorityMutation(sourceFile, importedName),
      )
    ) {
      closed = false;
    }
    const closedImportedCalls = (name) => {
      const bindingNodes = new Set([
        ...sourceLevelBindingNodes(sourceFile, name),
        ...namedBindingNodes(sourceFile, name),
      ]);
      const calls = [];
      visitNode(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name || bindingNodes.has(node)) return;
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.expression === node && !parent.questionDotToken) {
          calls.push(parent);
        } else {
          closed = false;
        }
      });
      return calls;
    };
    const writeFileCalls = closedImportedCalls("writeFileSync");
    const asynchronousWriteFileCalls = closedImportedCalls("writeFile");
    const linkCalls = closedImportedCalls("linkSync");
    const callsByOwner = (calls, ownerName) =>
      calls.filter((call) => topLevelFunctionOwnerName(call, sourceFile) === ownerName);
    const cancellationWrites = callsByOwner(writeFileCalls, "publishBrowserCancellation");
    const ackTemporaryWrites = callsByOwner(writeFileCalls, "publishBrowserAck");
    const harnessRetentionWrites = callsByOwner(writeFileCalls, "runChild");
    const ackLinks = callsByOwner(linkCalls, "publishBrowserAck");
    const browserControlSetupWrites = callsByOwner(
      asynchronousWriteFileCalls,
      "createBrowserControl",
    ).sort((left, right) => left.pos - right.pos);
    const browserControlSetupWriteTargets = browserControlSetupWrites.map((call) => {
      const target = unparenthesizedExpression(call.arguments[0]);
      return ts.isIdentifier(target) ? target.text : undefined;
    });
    if (
      writeFileCalls.length !== 3 ||
      asynchronousWriteFileCalls.length !== 3 ||
      browserControlSetupWrites.length !== 3 ||
      JSON.stringify(browserControlSetupWriteTargets) !==
        JSON.stringify(["browserOwnershipPath", "harnessOwnershipPath", "launcherPath"]) ||
      linkCalls.length !== 1 ||
      cancellationWrites.length !== 1 ||
      staticAuthorityPath(cancellationWrites[0].arguments[0], sourceFile)?.join(".") !==
        "browserControl.cancellationPath" ||
      ackTemporaryWrites.length !== 1 ||
      !ts.isIdentifier(unparenthesizedExpression(ackTemporaryWrites[0].arguments[0])) ||
      unparenthesizedExpression(ackTemporaryWrites[0].arguments[0]).text !== "temporaryPath" ||
      harnessRetentionWrites.length !== 1 ||
      staticAuthorityPath(harnessRetentionWrites[0].arguments[0], sourceFile)?.join(".") !==
        "browserControl.harnessRetentionPath" ||
      ackLinks.length !== 1 ||
      !ts.isIdentifier(unparenthesizedExpression(ackLinks[0].arguments[0])) ||
      unparenthesizedExpression(ackLinks[0].arguments[0]).text !== "temporaryPath" ||
      staticAuthorityPath(ackLinks[0].arguments[1], sourceFile)?.join(".") !== "control.ackPath"
    ) {
      closed = false;
    }
    const ackPropertyAssignments = [];
    const ackBindingElements = [];
    const ackPropertyReads = [];
    const stderrMembers = [];
    const stdoutMembers = [];
    const stderrWriteCalls = [];
    let consoleReference = false;
    visitNode(sourceFile, (node) => {
      if (ts.isIdentifier(node) && node.text === "console") consoleReference = true;
      if (
        ts.isPropertyAssignment(node) &&
        propertyNameStaticValue(node.name, sourceFile) === "ackPath"
      ) {
        ackPropertyAssignments.push(node);
      }
      if (
        ts.isBindingElement(node) &&
        propertyNameStaticValue(node.propertyName ?? node.name, sourceFile) === "ackPath"
      ) {
        ackBindingElements.push(node);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const path = staticAuthorityPath(node, sourceFile)?.join(".");
        if (path?.endsWith(".ackPath")) ackPropertyReads.push(node);
        if (path === "process.stderr") stderrMembers.push(node);
        if (path === "process.stdout") stdoutMembers.push(node);
      }
      if (
        ts.isCallExpression(node) &&
        staticAuthorityPath(node.expression, sourceFile)?.join(".") === "process.stderr.write"
      ) {
        stderrWriteCalls.push(node);
      }
    });
    const ackAssignment = ackPropertyAssignments[0];
    const ackInitializer = unparenthesizedExpression(ackAssignment?.initializer);
    const canonicalStderrFile = ts.createSourceFile(
      "canonical-sanitized-stderr",
      "process.stderr.write(`${sanitizeSupervisedFailure(failure)}\\n`);",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const canonicalStderrCall = canonicalStderrFile.statements[0]?.expression;
    if (
      ackPropertyAssignments.length !== 1 ||
      ackBindingElements.length !== 0 ||
      topLevelFunctionOwnerName(ackAssignment, sourceFile) !== "createBrowserControl" ||
      !ackInitializer ||
      !ts.isCallExpression(ackInitializer) ||
      !isCallNamed(ackInitializer, "join") ||
      ackInitializer.arguments.length !== 2 ||
      !ts.isIdentifier(unparenthesizedExpression(ackInitializer.arguments[0])) ||
      unparenthesizedExpression(ackInitializer.arguments[0]).text !== "root" ||
      resolvedStaticStringValue(ackInitializer.arguments[1], sourceFile) !== "browser.ack" ||
      ackPropertyReads.length !== 1 ||
      topLevelFunctionOwnerName(ackPropertyReads[0], sourceFile) !== "publishBrowserAck" ||
      stderrMembers.length !== 1 ||
      stdoutMembers.length !== 0 ||
      consoleReference ||
      stderrWriteCalls.length !== 1 ||
      topLevelFunctionOwnerName(stderrWriteCalls[0], sourceFile) !== "top-level" ||
      !canonicalStderrCall ||
      astFingerprint(stderrWriteCalls[0], sourceFile) !==
        astFingerprint(canonicalStderrCall, canonicalStderrFile)
    ) {
      closed = false;
    }
    const canonicalLstatFile = ts.createSourceFile(
      "canonical-lstat-if-exists",
      'function lstatIfExists(path){try{return lstatSync(path)}catch(error){if(error?.code==="ENOENT")return undefined;throw error;}}',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const actualLstatIfExists = uniqueTopLevelFunctionDeclaration(sourceFile, "lstatIfExists");
    const canonicalLstatIfExists = uniqueTopLevelFunctionDeclaration(
      canonicalLstatFile,
      "lstatIfExists",
    );
    if (
      !actualLstatIfExists ||
      !canonicalLstatIfExists ||
      sourceLevelBindingNodes(sourceFile, "lstatIfExists").length !== 1 ||
      namedBindingNodes(sourceFile, "lstatIfExists").length !== 1 ||
      hasAuthorityMutation(sourceFile, "lstatIfExists") ||
      astFingerprint(actualLstatIfExists, sourceFile) !==
        astFingerprint(canonicalLstatIfExists, canonicalLstatFile)
    ) {
      closed = false;
    }
    const signalHandler = uniqueTopLevelFunctionDeclaration(sourceFile, "handleSignal");
    const signalParameter = signalHandler?.parameters[0]?.name;
    const receivedSignalWrites = identifierMutationNodes(sourceFile, "receivedSignal");
    if (
      !signalHandler ||
      !signalParameter ||
      !ts.isIdentifier(signalParameter) ||
      receivedSignalWrites.length !== 1 ||
      !ts.isBinaryExpression(receivedSignalWrites[0]) ||
      receivedSignalWrites[0].operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(receivedSignalWrites[0].left) ||
      receivedSignalWrites[0].left.text !== "receivedSignal" ||
      !ts.isIdentifier(receivedSignalWrites[0].right) ||
      receivedSignalWrites[0].right.text !== signalParameter.text ||
      topLevelFunctionOwnerName(receivedSignalWrites[0], sourceFile) !== "handleSignal"
    ) {
      closed = false;
    }
    const acquisitions = staticModuleAcquisitionStatements(sourceFile);
    const exactNamedAcquisition = (statement, moduleName, expectedBindings) => {
      if (
        !statement ||
        !ts.isImportDeclaration(statement) ||
        normalizedModuleIdentity(staticModuleSpecifierText(statement)) !==
          normalizedModuleIdentity(moduleName)
      ) {
        return false;
      }
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      if (
        !clause ||
        clause.name ||
        clause.isTypeOnly ||
        !bindings ||
        !ts.isNamedImports(bindings) ||
        bindings.elements.length !== expectedBindings.length
      ) {
        return false;
      }
      const observed = bindings.elements.map((element) => ({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
        typeOnly: element.isTypeOnly,
      }));
      return expectedBindings.every(([imported, local]) =>
        observed.some(
          (binding) =>
            binding.imported === imported && binding.local === local && binding.typeOnly === false,
        ),
      );
    };
    const expectedAcquisitions = new Map([
      [
        "node:child_process",
        [
          ["spawn", "spawn"],
          ["spawnSync", "spawnSync"],
        ],
      ],
      ["node:crypto", [["randomBytes", "randomBytes"]]],
      [
        "node:fs",
        [
          ["accessSync", "accessSync"],
          ["chmodSync", "chmodSync"],
          ["closeSync", "closeSync"],
          ["constants", "fsConstants"],
          ["fstatSync", "fstatSync"],
          ["linkSync", "linkSync"],
          ["lstatSync", "lstatSync"],
          ["openSync", "openSync"],
          ["readFileSync", "readFileSync"],
          ["realpathSync", "realpathSync"],
          ["statSync", "statSync"],
          ["unlinkSync", "unlinkSync"],
          ["writeFileSync", "writeFileSync"],
        ],
      ],
      [
        "node:fs/promises",
        [
          ["mkdir", "mkdir"],
          ["mkdtemp", "mkdtemp"],
          ["rm", "rm"],
          ["writeFile", "writeFile"],
        ],
      ],
      ["node:module", [["createRequire", "createRequire"]]],
      ["node:net", [["createServer", "createServer"]]],
      ["node:os", [["tmpdir", "tmpdir"]]],
      [
        "node:path",
        [
          ["isAbsolute", "isAbsolute"],
          ["join", "join"],
          ["resolve", "resolve"],
        ],
      ],
      ["node:url", [["fileURLToPath", "fileURLToPath"]]],
    ]);
    const acquisitionByModule = new Map(
      acquisitions.map((statement) => [
        normalizedModuleIdentity(staticModuleSpecifierText(statement)),
        statement,
      ]),
    );
    if (
      acquisitions.length !== expectedAcquisitions.size ||
      acquisitionByModule.size !== expectedAcquisitions.size ||
      [...expectedAcquisitions].some(
        ([moduleName, bindings]) =>
          !exactNamedAcquisition(
            acquisitionByModule.get(normalizedModuleIdentity(moduleName)),
            moduleName,
            bindings,
          ),
      )
    ) {
      closed = false;
    }
    const acquisitionFingerprints = (moduleName) =>
      acquisitions
        .filter(
          (statement) =>
            normalizedModuleIdentity(staticModuleSpecifierText(statement)) ===
            normalizedModuleIdentity(moduleName),
        )
        .map((statement) => astFingerprint(statement, sourceFile));
    const childProcessImports = acquisitionFingerprints("node:child_process");
    const moduleImports = acquisitionFingerprints("node:module");
    const processImports = acquisitionFingerprints("node:process");
    if (
      childProcessImports.length !== 1 ||
      childProcessImports[0] !==
        exactStaticImportFingerprint('import {spawn,spawnSync} from "node:child_process";') ||
      moduleImports.length !== 1 ||
      moduleImports[0] !==
        exactStaticImportFingerprint('import {createRequire} from "node:module";') ||
      processImports.length !== 0
    ) {
      closed = false;
    }
    for (const acquisition of acquisitions) {
      if (!ts.isImportDeclaration(acquisition)) {
        closed = false;
        continue;
      }
      const moduleName = staticModuleSpecifierText(acquisition);
      if (isEvaluatorModuleIdentity(moduleName)) closed = false;
      if (normalizedStaticSpecifierText(moduleName)?.endsWith("/hr-browser-harness.mjs")) {
        closed = false;
      }
    }

    const executionBindingNodes = (name) => [
      ...new Set([
        ...sourceLevelBindingNodes(sourceFile, name),
        ...namedBindingNodes(sourceFile, name),
      ]),
    ];
    for (const name of executionNames) {
      if (executionBindingNodes(name).length !== 1 || hasAuthorityMutation(sourceFile, name)) {
        closed = false;
      }
    }
    const declarationNames = new Set(
      [...executionNames].flatMap((name) => executionBindingNodes(name)),
    );
    visitNode(sourceFile, (node) => {
      if (!ts.isIdentifier(node) || !executionNames.has(node.text)) return;
      if (declarationNames.has(node)) return;
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node && !parent.questionDotToken) {
        return;
      }
      closed = false;
    });

    const expectedCallOwners = new Map([
      ["createBrowserControl\u0000createRequire", 1],
      ["createBrowserControl\u0000playwrightRequire", 1],
      ["exactUnregisteredShimProcesses\u0000spawnSync", 1],
      ["postgresIsRunning\u0000spawnSync", 1],
      ["readProcessDescriptorIdentity\u0000spawnSync", 2],
      ["readProcessIdentity\u0000spawnSync", 1],
      ["run\u0000spawnSync", 1],
      ["runChild\u0000spawn", 1],
      ["runOrdinaryChild\u0000spawn", 1],
      ["runOrdinarySync\u0000spawnSync", 1],
    ]);
    const actualCallOwners = new Map();
    for (const call of callNodes) {
      const key = `${topLevelFunctionOwnerName(call, sourceFile)}\u0000${call.expression.text}`;
      actualCallOwners.set(key, (actualCallOwners.get(key) ?? 0) + 1);
    }
    if (
      actualCallOwners.size !== expectedCallOwners.size ||
      [...expectedCallOwners].some(([key, count]) => actualCallOwners.get(key) !== count)
    ) {
      closed = false;
    }
    const identifiersNamed = (root, name) => {
      const identifiers = [];
      visitNode(root, (node) => {
        if (ts.isIdentifier(node) && node.text === name) identifiers.push(node);
      });
      return identifiers;
    };
    const executionVariableDeclarationsNamed = (root, name) => [
      ...new Set(
        namedBindingNodes(root, name)
          .map((binding) => {
            for (let current = binding.parent; current; current = current.parent) {
              if (ts.isVariableDeclaration(current)) return current;
              if (ts.isStatement(current) || ts.isFunctionLike(current)) return undefined;
            }
            return undefined;
          })
          .filter(Boolean),
      ),
    ];
    const createBrowserControlFunction = uniqueTopLevelFunctionDeclaration(
      sourceFile,
      "createBrowserControl",
    );
    const createRequireCalls = callNodes.filter(
      (call) =>
        call.expression.text === "createRequire" &&
        topLevelFunctionOwnerName(call, sourceFile) === "createBrowserControl",
    );
    const playwrightRequireCalls = callNodes.filter(
      (call) =>
        call.expression.text === "playwrightRequire" &&
        topLevelFunctionOwnerName(call, sourceFile) === "createBrowserControl",
    );
    const playwrightRequireDeclarations = executionVariableDeclarationsNamed(
      createBrowserControlFunction,
      "playwrightRequire",
    );
    const chromiumDeclarations = executionVariableDeclarationsNamed(
      createBrowserControlFunction,
      "chromium",
    );
    const repositoryRootDeclarations = directVariableDeclarations(sourceFile, "repositoryRoot");
    const canonicalRepositoryRootFile = ts.createSourceFile(
      "canonical-repository-root",
      'const repositoryRoot=resolve(fileURLToPath(new URL("../..",import.meta.url)));',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const canonicalRepositoryRoot = directVariableDeclarations(
      canonicalRepositoryRootFile,
      "repositoryRoot",
    )[0];
    const repositoryRootDeclaration = repositoryRootDeclarations[0];
    const playwrightRequireDeclaration = playwrightRequireDeclarations[0];
    const playwrightFactory = unparenthesizedExpression(playwrightRequireDeclaration?.initializer);
    const playwrightBase = unparenthesizedExpression(playwrightFactory?.arguments?.[0]);
    const chromiumDeclaration = chromiumDeclarations[0];
    const chromiumBinding = chromiumDeclaration?.name;
    const chromiumElement =
      chromiumBinding && ts.isObjectBindingPattern(chromiumBinding)
        ? chromiumBinding.elements[0]
        : undefined;
    const playwrightLoad = unparenthesizedExpression(chromiumDeclaration?.initializer);
    const chromiumReferences = createBrowserControlFunction
      ? identifiersNamed(createBrowserControlFunction, "chromium")
      : [];
    const chromiumExecutableReference = chromiumReferences.find((identifier) => {
      const member = identifier.parent;
      const call = member?.parent;
      return Boolean(
        ts.isPropertyAccessExpression(member) &&
          member.expression === identifier &&
          member.name.text === "executablePath" &&
          ts.isCallExpression(call) &&
          call.expression === member &&
          !member.questionDotToken &&
          !call.questionDotToken &&
          call.arguments.length === 0,
      );
    });
    const chromiumExecutableCall = chromiumExecutableReference?.parent?.parent;
    const expectedExecutableDeclarations = executionVariableDeclarationsNamed(
      createBrowserControlFunction,
      "expectedRealExecutable",
    );
    const expectedExecutableDeclaration = expectedExecutableDeclarations[0];
    const expectedExecutableInitializer = unparenthesizedExpression(
      expectedExecutableDeclaration?.initializer,
    );
    const accessCalls = [];
    if (createBrowserControlFunction) {
      visitNode(createBrowserControlFunction, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "accessSync"
        ) {
          accessCalls.push(node);
        }
      });
    }
    const expectedExecutableReferences = createBrowserControlFunction
      ? identifiersNamed(createBrowserControlFunction, "expectedRealExecutable")
      : [];
    const expectedSensitiveReferences = expectedExecutableReferences.filter((identifier) => {
      const values = identifier.parent;
      const loop = values?.parent;
      if (
        !ts.isArrayLiteralExpression(values) ||
        !values.elements.includes(identifier) ||
        !ts.isForOfStatement(loop) ||
        loop.expression !== values ||
        !ts.isVariableDeclarationList(loop.initializer) ||
        (loop.initializer.flags & ts.NodeFlags.Const) === 0 ||
        loop.initializer.declarations.length !== 1 ||
        !ts.isIdentifier(loop.initializer.declarations[0].name) ||
        loop.initializer.declarations[0].name.text !== "value" ||
        loop.initializer.declarations[0].initializer ||
        !ts.isBlock(loop.statement) ||
        loop.statement.statements.length !== 1
      ) {
        return false;
      }
      const publicationStatement = loop.statement.statements[0];
      const publicationCall = ts.isExpressionStatement(publicationStatement)
        ? unparenthesizedExpression(publicationStatement.expression)
        : undefined;
      return Boolean(
        publicationCall &&
          ts.isCallExpression(publicationCall) &&
          !publicationCall.questionDotToken &&
          staticAuthorityPath(publicationCall.expression, sourceFile)?.join(".") ===
            "supervisedSensitiveValues.add" &&
          publicationCall.arguments.length === 1 &&
          ts.isIdentifier(unparenthesizedExpression(publicationCall.arguments[0])) &&
          unparenthesizedExpression(publicationCall.arguments[0]).text === "value",
      );
    });
    const expectedReturnReferences = expectedExecutableReferences.filter((identifier) => {
      const property = identifier.parent;
      const object = property?.parent;
      const statement = object?.parent;
      return Boolean(
        ts.isShorthandPropertyAssignment(property) &&
          property.name === identifier &&
          !property.objectAssignmentInitializer &&
          ts.isObjectLiteralExpression(object) &&
          ts.isReturnStatement(statement) &&
          statement.expression === object,
      );
    });
    const playwrightRequireLocation = statementListLocation(playwrightRequireDeclaration);
    const chromiumLocation = statementListLocation(chromiumDeclaration);
    const expectedExecutableLocation = statementListLocation(expectedExecutableDeclaration);
    const accessLocation = statementListLocation(accessCalls[0]);
    const createBrowserControlTries = createBrowserControlFunction?.body?.statements.filter(
      ts.isTryStatement,
    );
    const createBrowserControlTry = createBrowserControlTries?.[0];
    const exactLoaderStatementChain = Boolean(
      createBrowserControlTries?.length === 1 &&
        createBrowserControlTry &&
        playwrightRequireLocation &&
        chromiumLocation &&
        expectedExecutableLocation &&
        accessLocation &&
        playwrightRequireLocation.statements === chromiumLocation.statements &&
        chromiumLocation.statements === expectedExecutableLocation.statements &&
        expectedExecutableLocation.statements === accessLocation.statements &&
        accessLocation.statements === createBrowserControlTry.tryBlock.statements &&
        playwrightRequireLocation.index + 1 === chromiumLocation.index &&
        chromiumLocation.index + 1 === expectedExecutableLocation.index &&
        expectedExecutableLocation.index + 1 === accessLocation.index &&
        ts.isExpressionStatement(accessLocation.statement) &&
        unparenthesizedExpression(accessLocation.statement.expression) === accessCalls[0],
    );
    const sanitizeSupervisedFailureDeclaration = uniqueTopLevelFunctionDeclaration(
      sourceFile,
      "sanitizeSupervisedFailure",
    );
    const sensitiveValueAliasEscapes = authorityAliasEscapeNodes(
      sourceFile,
      sourceFile,
      new Set(["supervisedSensitiveValues"]),
      new Set(["supervisedSensitiveValues"]),
      [sanitizeSupervisedFailureDeclaration, createRequireCalls[0]].filter(Boolean),
    );
    const supervisedSensitiveDeclarations = directVariableDeclarations(
      sourceFile,
      "supervisedSensitiveValues",
    );
    const supervisedSensitiveDeclaration = supervisedSensitiveDeclarations[0];
    const supervisedSensitiveInitializer = unparenthesizedExpression(
      supervisedSensitiveDeclaration?.initializer,
    );
    const supervisedSensitiveBindingNodes = new Set([
      ...sourceLevelBindingNodes(sourceFile, "supervisedSensitiveValues"),
      ...namedBindingNodes(sourceFile, "supervisedSensitiveValues"),
    ]);
    const supervisedSensitiveAddCalls = new Map();
    const supervisedSensitiveIterations = [];
    let exactSupervisedSensitiveReferenceSurface = true;
    for (const reference of identifiersNamed(sourceFile, "supervisedSensitiveValues")) {
      if (supervisedSensitiveBindingNodes.has(reference)) continue;
      const member = reference.parent;
      const call = member?.parent;
      if (
        ts.isPropertyAccessExpression(member) &&
        member.expression === reference &&
        member.name.text === "add" &&
        ts.isCallExpression(call) &&
        call.expression === member &&
        !member.questionDotToken &&
        !call.questionDotToken &&
        call.arguments.length === 1 &&
        ts.isIdentifier(unparenthesizedExpression(call.arguments[0]))
      ) {
        const key = `${topLevelFunctionOwnerName(call, sourceFile)}\u0000${unparenthesizedExpression(call.arguments[0]).text}`;
        supervisedSensitiveAddCalls.set(key, (supervisedSensitiveAddCalls.get(key) ?? 0) + 1);
        continue;
      }
      if (
        ts.isForOfStatement(member) &&
        member.expression === reference &&
        topLevelFunctionOwnerName(member, sourceFile) === "sanitizeSupervisedFailure"
      ) {
        supervisedSensitiveIterations.push(member);
        continue;
      }
      exactSupervisedSensitiveReferenceSurface = false;
    }
    const expectedSupervisedSensitiveAddCalls = new Map([
      ["captureOwnedDirectory\u0000path", 1],
      ["captureOwnershipCapability\u0000path", 1],
      ["createBrowserControl\u0000profileRoot", 1],
      ["createBrowserControl\u0000root", 1],
      ["createBrowserControl\u0000value", 1],
    ]);
    const exactSupervisedSensitiveAddMultiset = Boolean(
      supervisedSensitiveAddCalls.size === expectedSupervisedSensitiveAddCalls.size &&
        [...expectedSupervisedSensitiveAddCalls].every(
          ([key, count]) => supervisedSensitiveAddCalls.get(key) === count,
        ),
    );
    const exactRootHelpers =
      ["accessSync", "fileURLToPath", "realpathSync", "resolve", "fsConstants"].every(
        (name) =>
          sourceLevelBindingNodes(sourceFile, name).length === 1 &&
          !hasAuthorityMutation(sourceFile, name),
      ) &&
      ["accessSync", "realpathSync", "fsConstants"].every(
        (name) => namedBindingNodes(createBrowserControlFunction, name).length === 0,
      );
    const exactJoinAuthority =
      new Set([
        ...sourceLevelBindingNodes(sourceFile, "join"),
        ...namedBindingNodes(sourceFile, "join"),
      ]).size === 1 && !hasAuthorityMutation(sourceFile, "join");
    if (
      !createBrowserControlFunction ||
      createRequireCalls.length !== 1 ||
      playwrightRequireCalls.length !== 1 ||
      playwrightRequireDeclarations.length !== 1 ||
      chromiumDeclarations.length !== 1 ||
      repositoryRootDeclarations.length !== 1 ||
      !canonicalRepositoryRoot ||
      !repositoryRootDeclaration ||
      !isConstVariableDeclaration(repositoryRootDeclaration) ||
      astFingerprint(repositoryRootDeclaration, sourceFile) !==
        astFingerprint(canonicalRepositoryRoot, canonicalRepositoryRootFile) ||
      namedBindingNodes(sourceFile, "repositoryRoot").length !== 1 ||
      hasAuthorityMutation(sourceFile, "repositoryRoot") ||
      identifiersNamed(sourceFile, "repositoryRoot").length !== 2 ||
      sourceLevelBindingNodes(sourceFile, "URL").length !== 0 ||
      namedBindingNodes(sourceFile, "URL").length !== 0 ||
      identifiersNamed(sourceFile, "URL").length !== 1 ||
      hasAuthorityMutation(sourceFile, "URL") ||
      !exactRootHelpers ||
      !exactJoinAuthority ||
      !playwrightRequireDeclaration ||
      !isConstVariableDeclaration(playwrightRequireDeclaration) ||
      playwrightRequireDeclaration.parent.declarations.length !== 1 ||
      playwrightFactory !== createRequireCalls[0] ||
      !playwrightFactory ||
      !ts.isCallExpression(playwrightFactory) ||
      playwrightFactory.arguments.length !== 1 ||
      !playwrightBase ||
      !ts.isCallExpression(playwrightBase) ||
      !ts.isIdentifier(playwrightBase.expression) ||
      playwrightBase.expression.text !== "join" ||
      playwrightBase.questionDotToken ||
      playwrightBase.arguments.length !== 2 ||
      !ts.isIdentifier(unparenthesizedExpression(playwrightBase.arguments[0])) ||
      unparenthesizedExpression(playwrightBase.arguments[0]).text !== "repositoryRoot" ||
      resolvedStaticStringValue(playwrightBase.arguments[1], sourceFile) !==
        "scripts/test/browser-tooling/package.json" ||
      identifiersNamed(createBrowserControlFunction, "playwrightRequire").length !== 2 ||
      !chromiumDeclaration ||
      !isConstVariableDeclaration(chromiumDeclaration) ||
      chromiumDeclaration.parent.declarations.length !== 1 ||
      !chromiumBinding ||
      !ts.isObjectBindingPattern(chromiumBinding) ||
      chromiumBinding.elements.length !== 1 ||
      !chromiumElement ||
      chromiumElement.dotDotDotToken ||
      chromiumElement.propertyName ||
      chromiumElement.initializer ||
      !ts.isIdentifier(chromiumElement.name) ||
      chromiumElement.name.text !== "chromium" ||
      playwrightLoad !== playwrightRequireCalls[0] ||
      !playwrightLoad ||
      !ts.isCallExpression(playwrightLoad) ||
      playwrightLoad.arguments.length !== 1 ||
      resolvedStaticStringValue(playwrightLoad.arguments[0], sourceFile) !== "@playwright/test" ||
      hasAuthorityMutation(createBrowserControlFunction, "chromium") ||
      chromiumReferences.length !== 2 ||
      !chromiumExecutableReference ||
      !chromiumExecutableCall ||
      expectedExecutableDeclarations.length !== 1 ||
      !expectedExecutableDeclaration ||
      !isConstVariableDeclaration(expectedExecutableDeclaration) ||
      expectedExecutableDeclaration.parent.declarations.length !== 1 ||
      !expectedExecutableInitializer ||
      !ts.isCallExpression(expectedExecutableInitializer) ||
      !ts.isIdentifier(expectedExecutableInitializer.expression) ||
      expectedExecutableInitializer.expression.text !== "realpathSync" ||
      expectedExecutableInitializer.questionDotToken ||
      expectedExecutableInitializer.arguments.length !== 1 ||
      unparenthesizedExpression(expectedExecutableInitializer.arguments[0]) !==
        chromiumExecutableCall ||
      hasAuthorityMutation(createBrowserControlFunction, "expectedRealExecutable") ||
      sourceLevelBindingNodes(sourceFile, "supervisedSensitiveValues").length !== 1 ||
      namedBindingNodes(createBrowserControlFunction, "supervisedSensitiveValues").length !== 0 ||
      hasAuthorityMutation(sourceFile, "supervisedSensitiveValues") ||
      sensitiveValueAliasEscapes.length !== 0 ||
      supervisedSensitiveDeclarations.length !== 1 ||
      !supervisedSensitiveDeclaration ||
      !isConstVariableDeclaration(supervisedSensitiveDeclaration) ||
      !supervisedSensitiveInitializer ||
      !ts.isNewExpression(supervisedSensitiveInitializer) ||
      !ts.isIdentifier(supervisedSensitiveInitializer.expression) ||
      supervisedSensitiveInitializer.expression.text !== "Set" ||
      (supervisedSensitiveInitializer.arguments?.length ?? 0) !== 0 ||
      !exactSupervisedSensitiveReferenceSurface ||
      !exactSupervisedSensitiveAddMultiset ||
      supervisedSensitiveIterations.length !== 1 ||
      expectedExecutableReferences.length !== 4 ||
      expectedSensitiveReferences.length !== 1 ||
      expectedReturnReferences.length !== 1 ||
      accessCalls.length !== 1 ||
      accessCalls[0].questionDotToken ||
      accessCalls[0].arguments.length !== 2 ||
      !ts.isIdentifier(unparenthesizedExpression(accessCalls[0].arguments[0])) ||
      unparenthesizedExpression(accessCalls[0].arguments[0]).text !== "expectedRealExecutable" ||
      staticAuthorityPath(accessCalls[0].arguments[1], sourceFile)?.join(".") !==
        "fsConstants.X_OK" ||
      !exactLoaderStatementChain ||
      playwrightRequireDeclaration.pos >= chromiumDeclaration.pos ||
      chromiumDeclaration.pos >= expectedExecutableDeclaration.pos ||
      expectedExecutableDeclaration.pos >= accessCalls[0].pos
    ) {
      closed = false;
    }
    const executableBindings = namedBindingNodes(sourceFile, "executable");
    const executableDeclarations = executableBindings
      .map((binding) => binding.parent)
      .filter(ts.isVariableDeclaration);
    const exactExecutableDeclaration = (declaration) => {
      const initializer = unparenthesizedExpression(declaration?.initializer);
      if (
        !declaration ||
        !isConstVariableDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "executable" ||
        !ts.isArrowFunction(initializer) ||
        initializer.parameters.length !== 1 ||
        !ts.isIdentifier(initializer.parameters[0].name)
      ) {
        return false;
      }
      const parameterName = initializer.parameters[0].name.text;
      const expression = unparenthesizedExpression(initializer.body);
      return Boolean(
        ts.isCallExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === "join" &&
          !expression.questionDotToken &&
          expression.arguments.length === 2 &&
          ts.isIdentifier(unparenthesizedExpression(expression.arguments[0])) &&
          unparenthesizedExpression(expression.arguments[0]).text === "pgBin" &&
          ts.isIdentifier(unparenthesizedExpression(expression.arguments[1])) &&
          unparenthesizedExpression(expression.arguments[1]).text === parameterName &&
          identifierMutationNodes(initializer, parameterName).length === 0,
      );
    };
    const pathImports = acquisitionFingerprints("node:path");
    if (
      executableDeclarations.length !== 2 ||
      !executableDeclarations.every(exactExecutableDeclaration) ||
      hasAuthorityMutation(sourceFile, "executable") ||
      pathImports.length !== 1 ||
      pathImports[0] !==
        exactStaticImportFingerprint('import {isAbsolute,join,resolve} from "node:path";')
    ) {
      closed = false;
    }

    const executionHelperNames = new Set([
      "postgresIsRunning",
      "run",
      "runChild",
      "runOrdinaryChild",
      "runOrdinarySync",
    ]);
    const executionHelperBindings = new Set(
      [...executionHelperNames].flatMap((name) => [
        ...sourceLevelBindingNodes(sourceFile, name),
        ...namedBindingNodes(sourceFile, name),
      ]),
    );
    const executionHelperCalls = [];
    visitNode(sourceFile, (node) => {
      if (!ts.isIdentifier(node) || !executionHelperNames.has(node.text)) return;
      if (executionHelperBindings.has(node)) return;
      const parent = node.parent;
      if (!ts.isCallExpression(parent) || parent.expression !== node || parent.questionDotToken) {
        closed = false;
        return;
      }
      executionHelperCalls.push(parent);
    });
    const approvedPostgresExecutables = new Set([
      "createdb",
      "createuser",
      "initdb",
      "pg_ctl",
      "psql",
    ]);
    const postgresToolName = (expression) => {
      const commandExpression = unparenthesizedExpression(expression);
      if (!commandExpression) return undefined;
      if (
        (ts.isStringLiteral(commandExpression) ||
          ts.isNoSubstitutionTemplateLiteral(commandExpression)) &&
        commandExpression.text === "pg_config"
      ) {
        return "pg_config";
      }
      return ts.isCallExpression(commandExpression) &&
        ts.isIdentifier(commandExpression.expression) &&
        commandExpression.expression.text === "executable" &&
        !commandExpression.questionDotToken &&
        commandExpression.arguments.length === 1 &&
        (ts.isStringLiteral(commandExpression.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(commandExpression.arguments[0])) &&
        approvedPostgresExecutables.has(commandExpression.arguments[0].text)
        ? commandExpression.arguments[0].text
        : undefined;
    };
    const exactStringArray = (expression, expected) => {
      const array = unparenthesizedExpression(expression);
      return Boolean(
        array &&
          ts.isArrayLiteralExpression(array) &&
          array.elements.length === expected.length &&
          array.elements.every(
            (element, index) => resolvedStaticStringValue(element, sourceFile) === expected[index],
          ),
      );
    };
    const exactCaptureOption = (expression) => {
      const options = unparenthesizedExpression(expression);
      return Boolean(
        options &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.length === 1 &&
          ts.isPropertyAssignment(options.properties[0]) &&
          propertyNameStaticValue(options.properties[0].name, sourceFile) === "capture" &&
          options.properties[0].initializer.kind === ts.SyntaxKind.TrueKeyword,
      );
    };
    const exactSafeRunOptions = (expression) => {
      if (expression === undefined) return true;
      const options = unparenthesizedExpression(expression);
      if (!options || !ts.isObjectLiteralExpression(options)) return false;
      return options.properties.every((property) => {
        if (!ts.isPropertyAssignment(property)) return false;
        const name = propertyNameStaticValue(property.name, sourceFile);
        if (name === "capture") return property.initializer.kind === ts.SyntaxKind.TrueKeyword;
        if (name === "timeout") {
          const timeout = numericLiteralValue(property.initializer);
          return timeout !== undefined && timeout > 0 && timeout <= 30_000;
        }
        return false;
      });
    };
    const exactPgCtlArgs = (expression) => {
      const array = unparenthesizedExpression(expression);
      if (!array || !ts.isArrayLiteralExpression(array)) return false;
      const elements = [...array.elements];
      const subcommands = elements
        .map((element) => resolvedStaticStringValue(element, sourceFile))
        .filter((value) => ["kill", "start", "status", "stop"].includes(value));
      const allowedLiterals = new Set([
        "-D",
        "-l",
        "-m",
        "-o",
        "-t",
        "-w",
        "15",
        "4",
        "8",
        "fast",
        "immediate",
        "start",
        "stop",
      ]);
      const exactServerOptions = (element) => {
        const candidate = unparenthesizedExpression(element);
        return Boolean(
          candidate &&
            ts.isTemplateExpression(candidate) &&
            candidate.head.text === "-h 127.0.0.1 -p " &&
            candidate.templateSpans.length === 2 &&
            ts.isIdentifier(candidate.templateSpans[0].expression) &&
            candidate.templateSpans[0].expression.text === "port" &&
            candidate.templateSpans[0].literal.text === " -k " &&
            ts.isIdentifier(candidate.templateSpans[1].expression) &&
            candidate.templateSpans[1].expression.text === "socketDirectory" &&
            candidate.templateSpans[1].literal.text === "",
        );
      };
      const everyElementApproved = elements.every((element) => {
        const value = resolvedStaticStringValue(element, sourceFile);
        if (value !== undefined) return allowedLiterals.has(value);
        const candidate = unparenthesizedExpression(element);
        return Boolean(
          (ts.isIdentifier(candidate) && ["dataDirectory", "logPath"].includes(candidate.text)) ||
            exactServerOptions(candidate),
        );
      });
      return Boolean(
        resolvedStaticStringValue(elements[0], sourceFile) === "-D" &&
          ts.isIdentifier(unparenthesizedExpression(elements[1])) &&
          unparenthesizedExpression(elements[1]).text === "dataDirectory" &&
          subcommands.length === 1 &&
          ["start", "stop"].includes(subcommands[0]) &&
          resolvedStaticStringValue(elements.at(-1), sourceFile) === subcommands[0] &&
          everyElementApproved,
      );
    };
    const exactPsqlArgs = (expression) => {
      const array = unparenthesizedExpression(expression);
      if (!array || !ts.isArrayLiteralExpression(array)) return false;
      const command = unparenthesizedExpression(array.elements[6]);
      return Boolean(
        array.elements.length === 7 &&
          ts.isSpreadElement(array.elements[0]) &&
          ts.isIdentifier(array.elements[0].expression) &&
          array.elements[0].expression.text === "connectionArgs" &&
          resolvedStaticStringValue(array.elements[1], sourceFile) === "--dbname" &&
          ts.isIdentifier(unparenthesizedExpression(array.elements[2])) &&
          unparenthesizedExpression(array.elements[2]).text === "databaseName" &&
          resolvedStaticStringValue(array.elements[3], sourceFile) === "--set" &&
          resolvedStaticStringValue(array.elements[4], sourceFile) === "ON_ERROR_STOP=1" &&
          resolvedStaticStringValue(array.elements[5], sourceFile) === "--command" &&
          command &&
          ts.isTemplateExpression(command) &&
          command.head.text === "ALTER SCHEMA public OWNER TO " &&
          command.templateSpans.length === 1 &&
          ts.isIdentifier(command.templateSpans[0].expression) &&
          command.templateSpans[0].expression.text === "migrationRole" &&
          command.templateSpans[0].literal.text === "" &&
          !command.getText(sourceFile).includes("\\"),
      );
    };
    const approvedPostgresCommand = (expression) => Boolean(postgresToolName(expression));
    const exactExternalChildCall = (call) =>
      Boolean(
        call.arguments.length === 3 &&
          ts.isIdentifier(unparenthesizedExpression(call.arguments[0])) &&
          unparenthesizedExpression(call.arguments[0]).text === "command" &&
          ts.isIdentifier(unparenthesizedExpression(call.arguments[1])) &&
          unparenthesizedExpression(call.arguments[1]).text === "args",
      );
    const exactPostgresStatusCall = (call) =>
      Boolean(
        call.arguments.length === 2 &&
          postgresToolName(call.arguments[0]) === "pg_ctl" &&
          ts.isIdentifier(unparenthesizedExpression(call.arguments[1])) &&
          unparenthesizedExpression(call.arguments[1]).text === "dataDirectory",
      );
    const exactApprovedSyncCall = (call) => {
      const tool = postgresToolName(call.arguments[0]);
      if (!tool || !approvedPostgresCommand(call.arguments[0])) return false;
      if (tool === "pg_config") {
        return (
          call.arguments.length === 3 &&
          exactStringArray(call.arguments[1], ["--bindir"]) &&
          exactCaptureOption(call.arguments[2])
        );
      }
      if (tool === "pg_ctl") {
        return (
          call.arguments.length <= 3 &&
          exactPgCtlArgs(call.arguments[1]) &&
          exactSafeRunOptions(call.arguments[2])
        );
      }
      if (tool === "psql") {
        return call.arguments.length === 2 && exactPsqlArgs(call.arguments[1]);
      }
      return call.arguments.length === 2;
    };
    const rawCallForOwner = (ownerName, calleeName) =>
      callNodes.filter(
        (call) =>
          topLevelFunctionOwnerName(call, sourceFile) === ownerName &&
          call.expression.text === calleeName,
      );
    const exactRawOptions = (call, canonicalSource) => {
      const canonicalOptionsFile = ts.createSourceFile(
        "canonical-raw-execution-options",
        `const options=${canonicalSource};`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const expected = directVariableDeclarations(canonicalOptionsFile, "options")[0]?.initializer;
      const actual = unparenthesizedExpression(call?.arguments[2]);
      return Boolean(
        call &&
          call.arguments.length === 3 &&
          expected &&
          actual &&
          astFingerprint(actual, sourceFile) === astFingerprint(expected, canonicalOptionsFile),
      );
    };
    const rawOptionContracts = [
      ["exactUnregisteredShimProcesses", "spawnSync", '{encoding:"utf8",timeout:5_000}'],
      ["postgresIsRunning", "spawnSync", '{stdio:"ignore",timeout:5_000}'],
      [
        "run",
        "spawnSync",
        '{encoding:"utf8",stdio:capture?"pipe":"inherit",timeout:30_000,...spawnOptions}',
      ],
      [
        "runOrdinarySync",
        "spawnSync",
        '{encoding:"utf8",stdio:capture?"pipe":"inherit",...spawnOptions}',
      ],
      ["runOrdinaryChild", "spawn", '{env,stdio:"inherit"}'],
      [
        "runChild",
        "spawn",
        '{detached:process.platform!=="win32",env:childEnvironment,stdio:superviseBrowser?["inherit","inherit","inherit","ignore","ignore",browserControl.harnessOwnershipHandle]:"inherit"}',
      ],
    ];
    if (
      rawOptionContracts.some(([ownerName, calleeName, optionsSource]) => {
        const calls = rawCallForOwner(ownerName, calleeName);
        return calls.length !== 1 || !exactRawOptions(calls[0], optionsSource);
      })
    ) {
      closed = false;
    }
    const hasClosedRawOptionCarrier = (ownerName) => {
      const owner = uniqueTopLevelFunctionDeclaration(sourceFile, ownerName);
      const optionsParameter = owner?.parameters[2];
      const optionsDefault = unparenthesizedExpression(optionsParameter?.initializer);
      const captureDeclarations = directVariableDeclarations(owner?.body, "capture");
      const spawnOptionsDeclarations = directVariableDeclarations(owner?.body, "spawnOptions");
      const carrierDeclaration = captureDeclarations[0];
      const carrierBinding = carrierDeclaration?.name;
      const carrierElements =
        carrierBinding && ts.isObjectBindingPattern(carrierBinding)
          ? [...carrierBinding.elements]
          : [];
      const captureElement = carrierElements[0];
      const restElement = carrierElements[1];
      const rawCalls = rawCallForOwner(ownerName, "spawnSync");
      return Boolean(
        owner &&
          owner.parameters.length === 3 &&
          optionsParameter &&
          !optionsParameter.dotDotDotToken &&
          !optionsParameter.questionToken &&
          !optionsParameter.type &&
          ts.isIdentifier(optionsParameter.name) &&
          optionsParameter.name.text === "options" &&
          optionsDefault &&
          ts.isObjectLiteralExpression(optionsDefault) &&
          optionsDefault.properties.length === 0 &&
          captureDeclarations.length === 1 &&
          spawnOptionsDeclarations.length === 1 &&
          spawnOptionsDeclarations[0] === carrierDeclaration &&
          carrierDeclaration &&
          isConstVariableDeclaration(carrierDeclaration) &&
          carrierDeclaration.parent.declarations.length === 1 &&
          ts.isIdentifier(unparenthesizedExpression(carrierDeclaration.initializer)) &&
          unparenthesizedExpression(carrierDeclaration.initializer).text === "options" &&
          carrierBinding &&
          ts.isObjectBindingPattern(carrierBinding) &&
          carrierElements.length === 2 &&
          captureElement &&
          !captureElement.dotDotDotToken &&
          !captureElement.propertyName &&
          ts.isIdentifier(captureElement.name) &&
          captureElement.name.text === "capture" &&
          captureElement.initializer?.kind === ts.SyntaxKind.FalseKeyword &&
          restElement &&
          Boolean(restElement.dotDotDotToken) &&
          !restElement.propertyName &&
          !restElement.initializer &&
          ts.isIdentifier(restElement.name) &&
          restElement.name.text === "spawnOptions" &&
          namedBindingNodes(owner, "options").length === 1 &&
          namedBindingNodes(owner, "capture").length === 1 &&
          namedBindingNodes(owner, "spawnOptions").length === 1 &&
          identifiersNamed(owner, "arguments").length === 0 &&
          identifiersNamed(owner, "options").length === 2 &&
          identifiersNamed(owner, "capture").length === 2 &&
          identifiersNamed(owner, "spawnOptions").length === 2 &&
          !hasAuthorityMutation(owner, "options") &&
          !hasAuthorityMutation(owner, "capture") &&
          !hasAuthorityMutation(owner, "spawnOptions") &&
          rawCalls.length === 1 &&
          carrierDeclaration.pos < rawCalls[0].pos,
      );
    };
    if (!["run", "runOrdinarySync"].every(hasClosedRawOptionCarrier)) {
      closed = false;
    }
    const exactUnregisteredScanCalls = rawCallForOwner(
      "exactUnregisteredShimProcesses",
      "spawnSync",
    );
    if (
      exactUnregisteredScanCalls.length !== 1 ||
      resolvedStaticStringValue(exactUnregisteredScanCalls[0].arguments[0], sourceFile) !== "ps" ||
      !exactStringArray(exactUnregisteredScanCalls[0].arguments[1], [
        "-axo",
        "pid=,pgid=,uid=,command=",
      ])
    ) {
      closed = false;
    }
    for (const call of executionHelperCalls) {
      const helperName = call.expression.text;
      if (
        (["run", "runOrdinarySync"].includes(helperName) && !exactApprovedSyncCall(call)) ||
        (["runChild", "runOrdinaryChild"].includes(helperName) && !exactExternalChildCall(call)) ||
        (helperName === "postgresIsRunning" && !exactPostgresStatusCall(call))
      ) {
        closed = false;
      }
    }
    for (const ownerName of executionHelperNames) {
      const owner = uniqueTopLevelFunctionDeclaration(sourceFile, ownerName);
      const commandParameter = owner?.parameters[0]?.name;
      const argvParameter = owner?.parameters[1]?.name;
      const rawCallee = ["runChild", "runOrdinaryChild"].includes(ownerName)
        ? "spawn"
        : "spawnSync";
      const rawCalls = rawCallForOwner(ownerName, rawCallee);
      const rawArgv = unparenthesizedExpression(rawCalls[0]?.arguments[1]);
      const exactRawArgv =
        ownerName === "postgresIsRunning"
          ? Boolean(
              rawArgv &&
                ts.isArrayLiteralExpression(rawArgv) &&
                rawArgv.elements.length === 3 &&
                resolvedStaticStringValue(rawArgv.elements[0], sourceFile) === "-D" &&
                ts.isIdentifier(unparenthesizedExpression(rawArgv.elements[1])) &&
                argvParameter &&
                ts.isIdentifier(argvParameter) &&
                unparenthesizedExpression(rawArgv.elements[1]).text === argvParameter.text &&
                resolvedStaticStringValue(rawArgv.elements[2], sourceFile) === "status",
            )
          : Boolean(
              rawArgv &&
                ts.isIdentifier(rawArgv) &&
                argvParameter &&
                ts.isIdentifier(argvParameter) &&
                rawArgv.text === argvParameter.text,
            );
      if (
        !owner ||
        owner.parameters.length < 2 ||
        !ts.isIdentifier(commandParameter) ||
        !ts.isIdentifier(argvParameter) ||
        identifierMutationNodes(owner, commandParameter.text).length > 0 ||
        identifierMutationNodes(owner, argvParameter.text).length > 0 ||
        rawCalls.length !== 1 ||
        !ts.isIdentifier(unparenthesizedExpression(rawCalls[0].arguments[0])) ||
        unparenthesizedExpression(rawCalls[0].arguments[0]).text !== commandParameter.text ||
        !exactRawArgv
      ) {
        closed = false;
      }
    }
    if (
      [...executionHelperNames].some(
        (name) =>
          new Set([
            ...sourceLevelBindingNodes(sourceFile, name),
            ...namedBindingNodes(sourceFile, name),
          ]).size !== 1 || hasAuthorityMutation(sourceFile, name),
      )
    ) {
      closed = false;
    }

    const gatewayNames = new Set([
      "drainRetainedBrowserGroup",
      "handleSignal",
      "signalRetainedBrowser",
      "signalRetainedHarness",
    ]);
    const gatewayBindings = new Set(
      [...gatewayNames].flatMap((name) => [
        ...sourceLevelBindingNodes(sourceFile, name),
        ...namedBindingNodes(sourceFile, name),
      ]),
    );
    const expectedGatewayCalls = new Map([
      ["handleSignal\u0000signalRetainedBrowser", 3],
      ["handleSignal\u0000signalRetainedHarness", 3],
      ["installSignalHandlers\u0000handleSignal", 1],
      ["runChild\u0000drainRetainedBrowserGroup", 1],
      ["runChild\u0000signalRetainedHarness", 2],
    ]);
    const actualGatewayCalls = new Map();
    visitNode(sourceFile, (node) => {
      if (!ts.isIdentifier(node) || !gatewayNames.has(node.text)) return;
      if (gatewayBindings.has(node)) return;
      const parent = node.parent;
      if (!ts.isCallExpression(parent) || parent.expression !== node || parent.questionDotToken) {
        closed = false;
        return;
      }
      const key = `${topLevelFunctionOwnerName(parent, sourceFile)}\u0000${node.text}`;
      actualGatewayCalls.set(key, (actualGatewayCalls.get(key) ?? 0) + 1);
    });
    if (
      [...gatewayNames].some(
        (name) =>
          new Set([
            ...sourceLevelBindingNodes(sourceFile, name),
            ...namedBindingNodes(sourceFile, name),
          ]).size !== 1 || hasAuthorityMutation(sourceFile, name),
      ) ||
      actualGatewayCalls.size !== expectedGatewayCalls.size ||
      [...expectedGatewayCalls].some(([key, count]) => actualGatewayCalls.get(key) !== count)
    ) {
      closed = false;
    }
    const cleanupBrowserRootsBindings = new Set([
      ...sourceLevelBindingNodes(sourceFile, "cleanupBrowserRoots"),
      ...namedBindingNodes(sourceFile, "cleanupBrowserRoots"),
    ]);
    const cleanupBrowserRootsCalls = [];
    visitNode(sourceFile, (node) => {
      if (
        !ts.isIdentifier(node) ||
        node.text !== "cleanupBrowserRoots" ||
        cleanupBrowserRootsBindings.has(node)
      ) {
        return;
      }
      const call = node.parent;
      if (
        !ts.isCallExpression(call) ||
        call.expression !== node ||
        call.questionDotToken ||
        call.arguments.length !== 0
      ) {
        closed = false;
        return;
      }
      cleanupBrowserRootsCalls.push(call);
    });
    const enclosingTryStatement = (node) => {
      for (let current = node?.parent; current; current = current.parent) {
        if (ts.isTryStatement(current)) return current;
        if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return undefined;
      }
      return undefined;
    };
    const canonicalSetupCleanupFile = ts.createSourceFile(
      "canonical-setup-browser-cleanup",
      "try{await cleanupBrowserRoots()}catch(cleanupError){setupFailure=new AggregateError([setupFailure,cleanupError])}",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const canonicalFinalCleanupFile = ts.createSourceFile(
      "canonical-final-browser-cleanup",
      "try{await cleanupBrowserRoots()}catch(error){failure=failure?new AggregateError([failure,error]):error}",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const canonicalSetupCleanup = canonicalSetupCleanupFile.statements[0];
    const canonicalFinalCleanup = canonicalFinalCleanupFile.statements[0];
    const setupCleanupCalls = cleanupBrowserRootsCalls.filter((call) => {
      const owner = enclosingTryStatement(call);
      return Boolean(
        owner &&
          canonicalSetupCleanup &&
          astFingerprint(owner, sourceFile) ===
            astFingerprint(canonicalSetupCleanup, canonicalSetupCleanupFile),
      );
    });
    const finalCleanupCalls = cleanupBrowserRootsCalls.filter((call) => {
      const owner = enclosingTryStatement(call);
      return Boolean(
        owner &&
          canonicalFinalCleanup &&
          astFingerprint(owner, sourceFile) ===
            astFingerprint(canonicalFinalCleanup, canonicalFinalCleanupFile),
      );
    });
    const exactIdentifierCondition = (node, name) => {
      const condition = unparenthesizedExpression(node);
      return ts.isIdentifier(condition) && condition.text === name;
    };
    const exactMainBrowserGuard = (node) => {
      const condition = unparenthesizedExpression(node);
      return Boolean(
        condition &&
          ts.isBinaryExpression(condition) &&
          condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          exactIdentifierCondition(condition.left, "isMain") &&
          exactIdentifierCondition(condition.right, "superviseBrowser"),
      );
    };
    const exactSetupCleanupControl = (call) => {
      const cleanupTry = enclosingTryStatement(call);
      const browserBlock = cleanupTry?.parent;
      const browserGuard = browserBlock?.parent;
      const setupBlock = browserGuard?.parent;
      const setupGuard = setupBlock?.parent;
      const mainBlock = setupGuard?.parent;
      const mainGuard = mainBlock?.parent;
      return Boolean(
        cleanupTry &&
          ts.isBlock(browserBlock) &&
          ts.isIfStatement(browserGuard) &&
          browserGuard.thenStatement === browserBlock &&
          exactIdentifierCondition(browserGuard.expression, "browserControl") &&
          ts.isBlock(setupBlock) &&
          ts.isIfStatement(setupGuard) &&
          setupGuard.thenStatement === setupBlock &&
          exactIdentifierCondition(setupGuard.expression, "setupFailure") &&
          ts.isBlock(mainBlock) &&
          ts.isIfStatement(mainGuard) &&
          mainGuard.thenStatement === mainBlock &&
          exactMainBrowserGuard(mainGuard.expression) &&
          mainGuard.parent === sourceFile,
      );
    };
    const exactFinalCleanupControl = (call) => {
      const cleanupTry = enclosingTryStatement(call);
      const cleanupBlock = cleanupTry?.parent;
      const cleanupGuard = cleanupBlock?.parent;
      const finalBlock = cleanupGuard?.parent;
      const lifecycleTry = finalBlock?.parent;
      const mainBlock = lifecycleTry?.parent;
      const mainGuard = mainBlock?.parent;
      return Boolean(
        cleanupTry &&
          ts.isBlock(cleanupBlock) &&
          ts.isIfStatement(cleanupGuard) &&
          cleanupGuard.thenStatement === cleanupBlock &&
          exactIdentifierCondition(cleanupGuard.expression, "superviseBrowser") &&
          ts.isBlock(finalBlock) &&
          ts.isTryStatement(lifecycleTry) &&
          lifecycleTry.finallyBlock === finalBlock &&
          ts.isBlock(mainBlock) &&
          ts.isIfStatement(mainGuard) &&
          mainGuard.thenStatement === mainBlock &&
          exactMainBrowserGuard(mainGuard.expression) &&
          mainGuard.parent === sourceFile,
      );
    };
    if (
      cleanupBrowserRootsBindings.size !== 1 ||
      hasAuthorityMutation(sourceFile, "cleanupBrowserRoots") ||
      cleanupBrowserRootsCalls.length !== 2 ||
      setupCleanupCalls.length !== 1 ||
      finalCleanupCalls.length !== 1 ||
      !exactSetupCleanupControl(setupCleanupCalls[0]) ||
      !exactFinalCleanupControl(finalCleanupCalls[0])
    ) {
      closed = false;
    }
  } else if (callNodes.length > 0) {
    closed = false;
  }

  const allowedShellProbeLines = [
    'kill -0 "$ppid" 2>/dev/null',
    'kill -0 "$ppid" 9<&- 2>/dev/null',
    'kill -0 "$supervisor" 2>/dev/null',
    'kill -0 "$supervisor" 9<&- 2>/dev/null',
  ];
  const shellSignalLines = [];
  const dangerousCapabilityNames = new Set([
    "activeBrowserIdentity",
    "activeChild",
    "activeHarnessIdentity",
    "browserControl",
    "child",
    "cleanupBrowserRoots",
    "drainRetainedBrowserGroup",
    "handleSignal",
    "process",
    "run",
    "runChild",
    "runOrdinaryChild",
    "runOrdinarySync",
    "signalHandlers",
    "signalProcessGroup",
    "signalRetainedBrowser",
    "signalRetainedHarness",
    "spawn",
    "spawnSync",
    "wrapper",
  ]);
  const touchesDangerousCapability = (root) => {
    let touches = false;
    visitNode(root, (node) => {
      if (ts.isIdentifier(node) && dangerousCapabilityNames.has(node.text)) touches = true;
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        /(?:^|[^a-z])(?:_kill|child_process|eval|kill|pkill|process|signal|spawn)(?:[^a-z]|$)/i.test(
          node.text,
        )
      ) {
        touches = true;
      }
    });
    return touches;
  };
  const nearestVariableDeclaration = (node) => {
    for (let current = node?.parent; current; current = current.parent) {
      if (ts.isVariableDeclaration(current)) return current;
      if (ts.isStatement(current) || ts.isSourceFile(current)) return undefined;
    }
    return undefined;
  };
  visitNode(sourceFile, (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const raw = node.getText(sourceFile);
      const resolvedEmbeddedText = ts.isTemplateExpression(node)
        ? node.templateSpans.reduce(
            (value, span) =>
              `${value}${resolvedStaticStringValue(span.expression, sourceFile) ?? "[DYNAMIC]"}${span.literal.text}`,
            node.head.text,
          )
        : resolvedStaticStringValue(node, sourceFile);
      const commandPattern =
        /(?:^|[\s;|&(){}])((?:\/(?:usr\/)?bin\/)?(?:kill|pkill)\s+-[A-Za-z0-9]+\s+(?:"[^"]+"|'[^']+'|\$[A-Za-z_][A-Za-z0-9_]*|-?\d+)(?:\s+9<&-)?(?:\s+2>\/dev\/null)?)/g;
      for (const match of raw.matchAll(commandPattern)) {
        shellSignalLines.push(match[1].trim());
      }
      if (embeddedTextLooksSignalExecutable(resolvedEmbeddedText)) {
        closed = false;
      }
      if (/\/(?:bin|usr\/bin)\/(?:kill|pkill)\b|\bpkill\s/i.test(raw)) {
        closed = false;
      }
    }
    if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text)) closed = false;
    if (ts.isIdentifier(node) && ["global", "globalThis"].includes(node.text)) {
      const parentPath = propertyChain(node.parent).join(".");
      const safeStaticGlobal = ["global.Math", "globalThis.Math"].some(
        (prefix) => parentPath === prefix || parentPath.startsWith(`${prefix}.`),
      );
      if (!safeStaticGlobal) closed = false;
    }
    if (ts.isIdentifier(node) && node.text === "Reflect") {
      const member = node.parent;
      const call = ts.isPropertyAccessExpression(member) ? member.parent : undefined;
      if (
        !call ||
        !ts.isCallExpression(call) ||
        call.expression !== member ||
        touchesDangerousCapability(call)
      ) {
        closed = false;
      }
    }
    if (ts.isComputedPropertyName(node)) {
      const declaration = nearestVariableDeclaration(node);
      if (touchesDangerousCapability(declaration ?? node)) closed = false;
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ["__lookupGetter__", "__lookupSetter__", "__proto__", "constructor"].includes(
        propertyNameStaticValue(
          ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression,
          sourceFile,
        ),
      )
    ) {
      closed = false;
    }
    if (ts.isElementAccessExpression(node)) {
      const ownerName = topLevelFunctionOwnerName(node, sourceFile);
      const exactCleanupAccess = Boolean(
        ownerName === "cleanupBrowserRoots" &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "browserControl" &&
          ts.isIdentifier(node.argumentExpression) &&
          node.argumentExpression.text === "key",
      );
      const exactTopLevelArgumentAccess = Boolean(
        ownerName === "top-level" &&
          ((ts.isPropertyAccessExpression(node.expression) &&
            propertyChain(node.expression).join(".") === "process.argv" &&
            numericLiteralValue(node.argumentExpression) === 1) ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === "rawArgs" &&
              numericLiteralValue(node.argumentExpression) === 0)),
      );
      const exactEnvironmentAccess = Boolean(
        ownerName === "withoutBrowserControlEnvironment" &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "output" &&
          ts.isIdentifier(node.argumentExpression) &&
          node.argumentExpression.text === "key",
      );
      const numericIndex = numericLiteralValue(node.argumentExpression) !== undefined;
      const dangerousComputedAccess =
        touchesDangerousCapability(node.expression) ||
        touchesDangerousCapability(node.argumentExpression);
      if (
        !numericIndex &&
        !exactCleanupAccess &&
        !exactTopLevelArgumentAccess &&
        !exactEnvironmentAccess &&
        dangerousComputedAccess
      ) {
        closed = false;
      }
    }
    if (ts.isIdentifier(node) && node.text === "signalHandlers") {
      const owner = enclosingFunctionNode(node);
      const ownerName = owner ? functionLikeName(owner) : undefined;
      const declaration = sourceLevelBindingNodes(sourceFile, "signalHandlers")[0];
      if (
        node !== declaration &&
        !["installSignalHandlers", "removeSignalHandlers"].includes(ownerName)
      ) {
        closed = false;
      }
    }
    if (
      (ts.isImportSpecifier(node) || ts.isBindingElement(node)) &&
      ["_kill", "kill"].includes(
        propertyNameStaticValue(node.propertyName ?? node.name, sourceFile),
      )
    ) {
      closed = false;
    }
    if (!ts.isCallExpression(node)) return;
    const path = staticAuthorityPath(node.expression, sourceFile) ?? [];
    const loaderName = path.at(-1);
    if (
      [
        "Object.assign",
        "Object.defineProperties",
        "Object.defineProperty",
        "Object.setPrototypeOf",
        "Reflect.apply",
        "Reflect.construct",
        "Reflect.defineProperty",
        "Reflect.deleteProperty",
        "Reflect.get",
        "Reflect.set",
        "Reflect.setPrototypeOf",
      ].includes(path.join(".")) &&
      touchesDangerousCapability(node)
    ) {
      closed = false;
    }
    if (
      ["process.emit", "process.listeners", "process.rawListeners"].includes(path.join(".")) ||
      (path[0] === "signalHandlers" &&
        ["entries", "forEach", "get", "keys", "values"].includes(loaderName))
    ) {
      closed = false;
    }
    if (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ["_linkedBinding", "binding", "dlopen", "getBuiltinModule", "require"].includes(loaderName) ||
      (["createRequire", "playwrightRequire"].includes(loaderName) && !callNodes.includes(node))
    ) {
      closed = false;
    }
    if (
      ["exec", "execFile", "execFileSync", "fork", "spawn", "spawnSync"].includes(loaderName) &&
      !callNodes.includes(node)
    ) {
      closed = false;
    }
  });
  for (const member of killMemberNodes(sourceFile, sourceFile)) {
    const path = staticAuthorityPath(member, sourceFile) ?? [];
    const call = member.parent;
    if (
      path.join(".") !== "process.kill" ||
      !ts.isCallExpression(call) ||
      call.expression !== member ||
      call.questionDotToken ||
      member.questionDotToken
    ) {
      closed = false;
    }
  }
  if (
    fullExecutionSurface &&
    JSON.stringify(shellSignalLines.sort()) !== JSON.stringify(allowedShellProbeLines)
  ) {
    closed = false;
  }
  return closed;
}

function collectProcessGroupAuthorityDiagnostics(
  sourceText,
  label,
  { allowedSourceSha256 = Object.freeze([]) } = {},
) {
  const sourceFile = ts.createSourceFile(
    label,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const canonicalFile = ts.createSourceFile(
    "canonical-process-group-authority",
    canonicalProcessGroupAuthoritySource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0 || canonicalFile.parseDiagnostics.length > 0) {
    return [`${label}:parse-error`];
  }

  const diagnostics = [];
  const protectedNames = new Set([
    "assertPositiveProcessGroupId",
    "drainRetainedBrowserGroup",
    "processGroupExists",
    "signalRetainedBrowser",
    "signalRetainedHarness",
    "signalProcessGroup",
    "supportedProcessGroupSignals",
  ]);
  const actualFunctions = new Map();
  const canonicalFunctions = new Map();
  for (const name of ["assertPositiveProcessGroupId", "processGroupExists", "signalProcessGroup"]) {
    const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
    const canonical = uniqueTopLevelFunctionDeclaration(canonicalFile, name);
    actualFunctions.set(name, actual);
    canonicalFunctions.set(name, canonical);
    if (
      !actual ||
      !canonical ||
      sourceLevelBindingNodes(sourceFile, name).length !== 1 ||
      namedBindingNodes(sourceFile, name).length !== 1 ||
      hasAuthorityMutation(sourceFile, name) ||
      astFingerprint(actual, sourceFile) !== astFingerprint(canonical, canonicalFile)
    ) {
      diagnostics.push(`${label}:${name}-noncanonical`);
    }
  }

  const actualSignalSet = directVariableDeclarations(sourceFile, "supportedProcessGroupSignals");
  const canonicalSignalSet = directVariableDeclarations(
    canonicalFile,
    "supportedProcessGroupSignals",
  );
  if (
    actualSignalSet.length !== 1 ||
    canonicalSignalSet.length !== 1 ||
    !isConstVariableDeclaration(actualSignalSet[0]) ||
    sourceLevelBindingNodes(sourceFile, "supportedProcessGroupSignals").length !== 1 ||
    namedBindingNodes(sourceFile, "supportedProcessGroupSignals").length !== 1 ||
    hasAuthorityMutation(sourceFile, "supportedProcessGroupSignals") ||
    astFingerprint(actualSignalSet[0], sourceFile) !==
      astFingerprint(canonicalSignalSet[0], canonicalFile)
  ) {
    diagnostics.push(`${label}:closed-signal-set`);
  }

  const retainedOwnerDeclarations = [
    "signalRetainedBrowser",
    "drainRetainedBrowserGroup",
    "signalRetainedHarness",
  ]
    .map((name) => uniqueTopLevelFunctionDeclaration(sourceFile, name))
    .filter(Boolean);
  const declarationNames = new Set(
    [
      ...actualFunctions.values(),
      ...retainedOwnerDeclarations,
      ...(actualSignalSet.length === 1 ? [actualSignalSet[0]] : []),
    ]
      .filter(Boolean)
      .map((declaration) => declaration.name),
  );
  visitNode(sourceFile, (node) => {
    if (!ts.isIdentifier(node) || !protectedNames.has(node.text)) return;
    if (declarationNames.has(node)) return;
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node && !parent.questionDotToken) {
      return;
    }
    if (
      node.text === "supportedProcessGroupSignals" &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === "has" &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      !parent.parent.questionDotToken &&
      enclosingFunctionNode(parent.parent) === actualFunctions.get("signalProcessGroup")
    ) {
      return;
    }
    diagnostics.push(`${label}:protected-authority-reference-escape`);
  });

  for (const statement of sourceFile.statements) {
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      const names = [];
      if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of protectedNames) {
            if (bindingNameNodes(declaration.name, name).length > 0) names.push(name);
          }
        }
      }
      if (names.some((name) => protectedNames.has(name))) {
        diagnostics.push(`${label}:protected-authority-exported`);
      }
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
        diagnostics.push(`${label}:namespace-or-star-export`);
      } else {
        for (const element of statement.exportClause.elements) {
          const localName = element.propertyName?.text ?? element.name.text;
          if (protectedNames.has(localName)) {
            diagnostics.push(`${label}:protected-authority-exported`);
          }
        }
      }
    }
    if (ts.isExportAssignment(statement)) {
      let touchesProtected = false;
      visitNode(statement.expression, (node) => {
        if (ts.isIdentifier(node) && protectedNames.has(node.text)) touchesProtected = true;
      });
      if (touchesProtected) diagnostics.push(`${label}:protected-authority-exported`);
    }
  }

  let genericDrain = false;
  visitNode(sourceFile, (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === "drainProcessGroup"
    ) {
      genericDrain = true;
    }
    if (
      ts.isVariableDeclaration(node) &&
      bindingNameNodes(node.name, "drainProcessGroup").length > 0
    ) {
      genericDrain = true;
    }
  });
  if (genericDrain) diagnostics.push(`${label}:generic-drain-present`);
  if (!hasClosedWithPostgresExecutionAuthority(sourceFile, allowedSourceSha256)) {
    diagnostics.push(`${label}:alternate-signal-authority`);
  }

  const directKillCalls = [];
  const canonicalDirectKillCalls = [];
  let processKillEscape = false;
  for (const [file, output] of [
    [sourceFile, directKillCalls],
    [canonicalFile, canonicalDirectKillCalls],
  ]) {
    visitNode(file, (node) => {
      const path = staticAuthorityPath(node, file) ?? [];
      const processIndex = path.indexOf("process");
      if (
        file === sourceFile &&
        (processIndex > 0 ||
          (path[0] === "process" && path[1] === "*") ||
          (ts.isIdentifier(node) &&
            node.text === "process" &&
            !(
              (ts.isPropertyAccessExpression(node.parent) ||
                ts.isElementAccessExpression(node.parent)) &&
              node.parent.expression === node
            )))
      ) {
        processKillEscape = true;
      }
      if (path.join(".") !== "process.kill") return;
      const parent = node.parent;
      if (
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        !parent.questionDotToken &&
        !node.questionDotToken
      ) {
        const owner = enclosingFunctionNode(parent);
        const statement = ts.isExpressionStatement(parent.parent) ? parent.parent : undefined;
        const block = statement && ts.isBlock(statement.parent) ? statement.parent : undefined;
        const conditional = block && ts.isIfStatement(block.parent) ? block.parent : undefined;
        const outerBlock =
          conditional && ts.isBlock(conditional.parent) ? conditional.parent : undefined;
        const outerConditional =
          outerBlock && ts.isIfStatement(outerBlock.parent) ? outerBlock.parent : undefined;
        output.push({
          fingerprint: astFingerprint(parent, file),
          owner: owner ? functionLikeName(owner) : "top-level",
          selfSignalShape: Boolean(
            !owner &&
              conditional?.thenStatement === block &&
              block.statements.length === 2 &&
              block.statements[1] === statement &&
              ts.isIdentifier(conditional.expression) &&
              conditional.expression.text === "receivedSignal" &&
              outerBlock?.statements.includes(conditional) &&
              outerConditional?.thenStatement === outerBlock &&
              ts.isBinaryExpression(outerConditional.expression) &&
              outerConditional.expression.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken &&
              ts.isIdentifier(outerConditional.expression.left) &&
              outerConditional.expression.left.text === "isMain" &&
              ts.isIdentifier(outerConditional.expression.right) &&
              outerConditional.expression.right.text === "superviseBrowser" &&
              outerConditional.parent === file,
          ),
          selfSignalPrelude:
            block?.statements[1] === statement
              ? astFingerprint(block.statements[0], file)
              : undefined,
        });
        return;
      }
      if (file === sourceFile) processKillEscape = true;
    });
  }
  if (processKillEscape) diagnostics.push(`${label}:process-kill-reference-escape`);
  const normalizedDirectKills = (calls) =>
    calls
      .map(
        (call) =>
          `${call.owner}\u0000${call.fingerprint}\u0000${call.selfSignalShape}\u0000${call.selfSignalPrelude}`,
      )
      .sort();
  if (
    JSON.stringify(normalizedDirectKills(directKillCalls)) !==
    JSON.stringify(normalizedDirectKills(canonicalDirectKillCalls))
  ) {
    diagnostics.push(`${label}:direct-process-kill-multiset`);
  }

  const signalCalls = [];
  const canonicalSignalCalls = [];
  for (const [file, output] of [
    [sourceFile, signalCalls],
    [canonicalFile, canonicalSignalCalls],
  ]) {
    visitNode(file, (node) => {
      if (!isCallNamed(node, "signalProcessGroup")) return;
      const owner = enclosingFunctionNode(node);
      output.push({
        directOwnerStatement: Boolean(
          owner?.body &&
            ts.isExpressionStatement(node.parent) &&
            node.parent.expression === node &&
            node.parent.parent === owner.body,
        ),
        fingerprint: astFingerprint(node, file),
        owner: functionLikeName(owner) ?? "unknown",
      });
    });
  }
  const normalizedCalls = (calls) =>
    calls
      .map((call) => `${call.owner}\u0000${call.fingerprint}\u0000${call.directOwnerStatement}`)
      .sort();
  if (
    JSON.stringify(normalizedCalls(signalCalls)) !==
    JSON.stringify(normalizedCalls(canonicalSignalCalls))
  ) {
    diagnostics.push(`${label}:retained-owner-call-multiset`);
  }

  for (const ownerName of [
    "signalRetainedBrowser",
    "drainRetainedBrowserGroup",
    "signalRetainedHarness",
  ]) {
    const owner = uniqueTopLevelFunctionDeclaration(sourceFile, ownerName);
    const canonicalOwner = uniqueTopLevelFunctionDeclaration(canonicalFile, ownerName);
    if (
      !owner ||
      !canonicalOwner ||
      sourceLevelBindingNodes(sourceFile, ownerName).length !== 1 ||
      hasAuthorityMutation(sourceFile, ownerName) ||
      astFingerprint(owner, sourceFile) !== astFingerprint(canonicalOwner, canonicalFile)
    ) {
      diagnostics.push(`${label}:${ownerName}-leader-proof`);
    }
  }

  return [...new Set(diagnostics)].sort();
}

function collectSuiteFinalizerDiagnostics(sourceText, label) {
  const sourceFile = ts.createSourceFile(
    label,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) return [`${label}:1:parse-error`];

  const canonicalFile = ts.createSourceFile(
    "canonical-suite-finalizer",
    canonicalSuiteFinalizerSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const topLevelAfterCalls = (file) =>
    file.statements
      .filter(ts.isExpressionStatement)
      .map((statement) => statement.expression)
      .filter((expression) => isCallNamed(expression, "after"));
  const canonicalHarnessRegistrationFile = ts.createSourceFile(
    "canonical-harness-suite-finalizer-registration",
    canonicalHarnessSuiteFinalizerRegistrationSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const actualAfterCalls = topLevelAfterCalls(sourceFile);
  const canonicalAfterCalls = topLevelAfterCalls(canonicalFile);
  const canonicalHarnessAfterCalls = topLevelAfterCalls(canonicalHarnessRegistrationFile);
  if (
    actualAfterCalls.length !== 1 ||
    canonicalAfterCalls.length !== 1 ||
    canonicalHarnessAfterCalls.length !== 1 ||
    canonicalHarnessRegistrationFile.parseDiagnostics.length > 0
  ) {
    return [`${label}:1:exactly-one-suite-finalizer-required`];
  }

  const diagnostics = [];
  const actualAfter = actualAfterCalls[0];
  const canonicalAfter = canonicalAfterCalls[0];
  const actualCallback = actualAfter.arguments[0];
  const canonicalCallback = canonicalAfter.arguments[0];
  const topLevelPredecessorFingerprints = (file, call) => {
    const statement = call?.parent;
    if (!ts.isExpressionStatement(statement) || statement.parent !== file) return undefined;
    const index = file.statements.indexOf(statement);
    return index < 0
      ? undefined
      : file.statements.slice(0, index).map((predecessor) => astFingerprint(predecessor, file));
  };
  const actualPredecessors = topLevelPredecessorFingerprints(sourceFile, actualAfter);
  const canonicalPredecessorEnvelopes = [
    topLevelPredecessorFingerprints(canonicalFile, canonicalAfter),
    topLevelPredecessorFingerprints(
      canonicalHarnessRegistrationFile,
      canonicalHarnessAfterCalls[0],
    ),
  ];
  const exactRegistrationPredecessors = Boolean(
    actualPredecessors &&
      canonicalPredecessorEnvelopes.some(
        (expected) => expected && JSON.stringify(actualPredecessors) === JSON.stringify(expected),
      ),
  );
  const exactCallback =
    actualCallback &&
    canonicalCallback &&
    astFingerprint(actualCallback, sourceFile) === astFingerprint(canonicalCallback, canonicalFile)
      ? actualCallback
      : undefined;
  if (
    !hasClosedUnaliasedNamedImportSet(sourceFile, "node:test", ["after"]) ||
    authorityAliasEscapeNodes(sourceFile, sourceFile, new Set(["after"])).length > 0 ||
    actualAfter.arguments.length !== 1 ||
    !actualCallback ||
    !canonicalCallback ||
    !isAsyncFunctionLike(actualCallback) ||
    !exactRegistrationPredecessors
  ) {
    diagnostics.push(
      `${label}:${sourceLine(sourceFile, actualAfter)}:suite-finalizer-registration-provenance`,
    );
  } else if (
    astFingerprint(actualCallback, sourceFile) !== astFingerprint(canonicalCallback, canonicalFile)
  ) {
    diagnostics.push(
      `${label}:${sourceLine(sourceFile, actualAfter)}:suite-finalizer-noncanonical-shape`,
    );
  }

  const exactTopLevelDeclaration = (name) => {
    const actual = directVariableDeclarations(sourceFile, name);
    const canonical = directVariableDeclarations(canonicalFile, name);
    return (
      actual.length === 1 &&
      canonical.length === 1 &&
      isConstVariableDeclaration(actual[0]) &&
      sourceLevelBindingNodes(sourceFile, name).length === 1 &&
      !hasIdentifierReassignment(sourceFile, name) &&
      astFingerprint(actual[0], sourceFile) === astFingerprint(canonical[0], canonicalFile)
    );
  };
  if (
    ![
      "activeWrapperControllers",
      "completedWrapperControllers",
      "openWrapperOwnershipDescriptors",
      "recordedWrapperIdentities",
      "suiteFinalizerFinishTimeoutMs",
      "wrapperTemporaryRoot",
    ].every(exactTopLevelDeclaration)
  ) {
    diagnostics.push(`${label}:1:suite-finalizer-state-provenance`);
  }

  const exactHelper = (name) => {
    const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
    const canonical = uniqueTopLevelFunctionDeclaration(canonicalFile, name);
    return Boolean(
      actual &&
        canonical &&
        sourceLevelBindingNodes(sourceFile, name).length === 1 &&
        !hasIdentifierReassignment(sourceFile, name) &&
        astFingerprint(actual, sourceFile) === astFingerprint(canonical, canonicalFile),
    );
  };
  if (
    ![
      "browserTemporaryDirectories",
      "postgresTemporaryDirectories",
      "readProcessIdentity",
      "sameProcessIdentity",
    ].every(exactHelper) ||
    !hasExactDefaultImport(sourceFile, "node:assert/strict", "assert") ||
    !hasClosedChildProcessImportSet(sourceFile, ["spawnSync"]) ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:child_process", "spawnSync") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:fs", "closeSync") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:fs/promises", "readdir") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:fs/promises", "rmdir")
  ) {
    diagnostics.push(`${label}:1:suite-finalizer-helper-provenance`);
  }

  const mutableControllerStates = new Set([
    "activeWrapperControllers",
    "completedWrapperControllers",
    "openWrapperOwnershipDescriptors",
    "recordedWrapperIdentities",
  ]);
  const expectedStateMutations = protectedStateMutationMultiset(
    canonicalFile,
    mutableControllerStates,
  );
  if (uniqueTopLevelFunctionDeclaration(sourceFile, "spawnOwnedWrapperController")) {
    const canonicalControllerFile = ts.createSourceFile(
      "canonical-controller-for-suite-mutations",
      [
        canonicalOwnedControllerEnvironmentSource(),
        "const activeWrapperControllers=new Set();",
        "const completedWrapperControllers=[];",
        "const openWrapperOwnershipDescriptors=new Set();",
        "const recordedWrapperIdentities=[];",
        canonicalSignalHelperSemanticSource("captureStableProcessIdentity"),
        canonicalProbeSignalSource(),
        canonicalOwnedControllerLifecycleSource(),
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    expectedStateMutations.push(
      ...protectedStateMutationMultiset(canonicalControllerFile, mutableControllerStates),
    );
    expectedStateMutations.sort();
  }
  if (
    JSON.stringify(protectedStateMutationMultiset(sourceFile, mutableControllerStates)) !==
      JSON.stringify(expectedStateMutations) ||
    authorityAliasEscapeNodes(
      sourceFile,
      sourceFile,
      mutableControllerStates,
      mutableControllerStates,
      [exactCallback, exactControllerBaselineDeclaration(sourceFile)].filter(Boolean),
    ).length > 0
  ) {
    diagnostics.push(`${label}:1:suite-finalizer-state-mutation-multiset`);
  }

  return [...new Set(diagnostics)];
}

function collectMalformedFixtureCleanupDiagnostics(sourceText, label) {
  const sourceFile = ts.createSourceFile(
    label,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) return [`${label}:1:parse-error`];

  const canonicalFile = ts.createSourceFile(
    "canonical-malformed-fixture-cleanup",
    canonicalMalformedFixtureCleanupSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const canonicalSanitizerCarrierFile = ts.createSourceFile(
    "canonical-sanitizer-fixture-cleanup-carrier",
    canonicalSanitizerOrderingSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const target = uniqueTopLevelFunctionDeclaration(
    sourceFile,
    "runMalformedCancellationIsolationCase",
  );
  const canonicalTarget = uniqueTopLevelFunctionDeclaration(
    canonicalFile,
    "runMalformedCancellationIsolationCase",
  );
  if (
    namedFunctionDeclarations(sourceFile, "runMalformedCancellationIsolationCase").length !== 1 ||
    !target?.body ||
    !canonicalTarget?.body ||
    !isAsyncFunctionLike(target) ||
    target.parameters.length !== canonicalTarget.parameters.length ||
    !target.parameters.every(
      (parameter, index) =>
        astFingerprint(parameter, sourceFile) ===
        astFingerprint(canonicalTarget.parameters[index], canonicalFile),
    )
  ) {
    return [`${label}:1:fixture-cleanup-target-missing`];
  }

  const diagnostics = [];
  const targetTryStatements = target.body.statements.filter(ts.isTryStatement);
  const canonicalTryStatements = canonicalTarget.body.statements.filter(ts.isTryStatement);
  const targetTry = targetTryStatements.length === 1 ? targetTryStatements[0] : undefined;
  const canonicalTry = canonicalTryStatements.length === 1 ? canonicalTryStatements[0] : undefined;
  if (
    !targetTry?.catchClause ||
    !targetTry.finallyBlock ||
    !canonicalTry?.catchClause ||
    !canonicalTry.finallyBlock
  ) {
    return [`${label}:1:fixture-cleanup-all-settled-missing`];
  }

  if (
    astFingerprint(targetTry.catchClause, sourceFile) !==
    astFingerprint(canonicalTry.catchClause, canonicalFile)
  ) {
    diagnostics.push(
      `${label}:${sourceLine(sourceFile, targetTry.catchClause)}:fixture-cleanup-primary-error-invalid`,
    );
  }
  if (
    astFingerprint(targetTry.finallyBlock, sourceFile) !==
    astFingerprint(canonicalTry.finallyBlock, canonicalFile)
  ) {
    diagnostics.push(
      `${label}:${sourceLine(sourceFile, targetTry.finallyBlock)}:fixture-cleanup-all-settled-missing`,
    );
  }
  const targetTryIndex = target.body.statements.indexOf(targetTry);
  const canonicalTryIndex = canonicalTarget.body.statements.indexOf(canonicalTry);
  const targetPrefix = target.body.statements.slice(0, targetTryIndex);
  const canonicalPrefix = canonicalTarget.body.statements.slice(0, canonicalTryIndex);
  const targetTail = target.body.statements.slice(targetTryIndex + 1);
  const canonicalTail = canonicalTarget.body.statements.slice(canonicalTryIndex + 1);
  const sameStatementSequence = (actual, expected) =>
    actual.length === expected.length &&
    actual.every(
      (statement, index) =>
        astFingerprint(statement, sourceFile) === astFingerprint(expected[index], canonicalFile),
    );
  if (!sameStatementSequence(targetPrefix, canonicalPrefix)) {
    diagnostics.push(`${label}:1:fixture-cleanup-acquisition-state-invalid`);
  }
  if (!sameStatementSequence(targetTail, canonicalTail)) {
    diagnostics.push(`${label}:1:fixture-cleanup-aggregate-invalid`);
  }

  const acquisitions = [];
  visitNode(target, (node) => {
    if (
      ts.isCallExpression(node) &&
      ["mkdtemp", "spawnCooperativeFixture", "spawnOwnedWrapperController"].includes(
        propertyChain(node.expression).join("."),
      )
    ) {
      acquisitions.push(node);
    }
  });
  const insideProtectedTry = (node) => {
    for (let current = node; current && current !== target; current = current.parent) {
      if (current === targetTry.tryBlock) return true;
    }
    return false;
  };
  const acquisitionCounts = new Map(
    ["mkdtemp", "spawnCooperativeFixture", "spawnOwnedWrapperController"].map((name) => [
      name,
      acquisitions.filter((call) => propertyChain(call.expression).join(".") === name).length,
    ]),
  );
  const canonicalAcquisitions = [];
  visitNode(canonicalTarget, (node) => {
    if (
      ts.isCallExpression(node) &&
      ["mkdtemp", "spawnCooperativeFixture", "spawnOwnedWrapperController"].includes(
        propertyChain(node.expression).join("."),
      )
    ) {
      canonicalAcquisitions.push(node);
    }
  });
  const exactAcquisitionCalls = acquisitions.every((call) => {
    const name = propertyChain(call.expression).join(".");
    return canonicalAcquisitions.some(
      (canonicalCall) =>
        propertyChain(canonicalCall.expression).join(".") === name &&
        astFingerprint(call, sourceFile) === astFingerprint(canonicalCall, canonicalFile),
    );
  });
  const controllerCallWithin = (statement) => {
    let found = false;
    visitNode(statement, (node) => {
      if (
        ts.isCallExpression(node) &&
        propertyChain(node.expression).join(".") === "spawnOwnedWrapperController"
      ) {
        found = true;
      }
    });
    return found;
  };
  const canonicalControllerTries = canonicalTry.tryBlock.statements.filter(
    (statement) => ts.isTryStatement(statement) && controllerCallWithin(statement),
  );
  const targetControllerTries = targetTry.tryBlock.statements.filter(
    (statement) => ts.isTryStatement(statement) && controllerCallWithin(statement),
  );
  const canonicalControllerTry = canonicalControllerTries[0];
  const targetControllerTry = targetControllerTries[0];
  const canonicalControllerTryIndex = canonicalControllerTry
    ? canonicalTry.tryBlock.statements.indexOf(canonicalControllerTry)
    : -1;
  const targetControllerTryIndex = targetControllerTry
    ? targetTry.tryBlock.statements.indexOf(targetControllerTry)
    : -1;
  const canonicalAcquisitionSequence =
    canonicalControllerTryIndex >= 0
      ? canonicalTry.tryBlock.statements.slice(0, canonicalControllerTryIndex + 1)
      : [];
  const targetAcquisitionSequence =
    targetControllerTryIndex >= 0
      ? targetTry.tryBlock.statements.slice(0, targetControllerTryIndex + 1)
      : [];
  const exactControllerAcquisitionSequence = Boolean(
    canonicalControllerTries.length === 1 &&
      targetControllerTries.length === 1 &&
      canonicalControllerTryIndex > 0 &&
      targetControllerTryIndex > 0 &&
      targetAcquisitionSequence.length === canonicalAcquisitionSequence.length &&
      targetAcquisitionSequence.every(
        (statement, index) =>
          astFingerprint(statement, sourceFile) ===
          astFingerprint(canonicalAcquisitionSequence[index], canonicalFile),
      ),
  );
  const directlyReachableAcquisition = (call) => {
    const location = statementListLocation(call);
    if (!location || !ts.isExpressionStatement(location.statement)) return false;
    if (location.statements === targetTry.tryBlock.statements) return true;
    const container = location.statement.parent;
    return Boolean(
      ts.isBlock(container) &&
        ts.isTryStatement(container.parent) &&
        container.parent.tryBlock === container &&
        container.parent.parent === targetTry.tryBlock,
    );
  };
  if (
    acquisitions.some((call) => !insideProtectedTry(call)) ||
    acquisitions.some((call) => !directlyReachableAcquisition(call)) ||
    acquisitionCounts.get("mkdtemp") !== 1 ||
    acquisitionCounts.get("spawnCooperativeFixture") !== 2 ||
    acquisitionCounts.get("spawnOwnedWrapperController") !== 1 ||
    !exactAcquisitionCalls ||
    !exactMalformedProgramSourceDeclaration(target, sourceFile) ||
    !exactControllerAcquisitionSequence
  ) {
    diagnostics.push(`${label}:1:fixture-cleanup-acquisition-protocol-invalid`);
  }

  const exactHelper = (name) => {
    const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
    const canonical = uniqueTopLevelFunctionDeclaration(canonicalFile, name);
    return Boolean(
      actual &&
        canonical &&
        sourceLevelBindingNodes(sourceFile, name).length === 1 &&
        !hasIdentifierReassignment(sourceFile, name) &&
        !containsLocalBinding(target, name) &&
        astFingerprint(actual, sourceFile) === astFingerprint(canonical, canonicalFile),
    );
  };
  if (
    ![
      "assertNoOwnedResidue",
      "browserTemporaryDirectories",
      "captureStableProcessIdentity",
      "createCooperativeCloseState",
      "createCooperativeFixtureSlot",
      "isSemanticSessionLeader",
      "joinCooperativeFixture",
      "observeChildClose",
      "pathExists",
      "postgresTemporaryDirectories",
      "publishCooperativeClose",
      "publishCooperativeFixtureStop",
      "refreshCooperativeClose",
      "readProcessIdentity",
      "readSemanticSessionObservation",
      "retainCooperativeFixture",
      "retainCooperativeFixtureReceipt",
      "sameProcessIdentity",
      "spawnCooperativeFixture",
      "settleCooperativeClose",
      "waitForExactProcessExit",
      "waitForFile",
      "waitForPath",
      "writePrivateStop",
    ].every(exactHelper) ||
    (!exactOwnedControllerAuthority(sourceFile, canonicalFile).exact &&
      !exactOwnedControllerAuthority(sourceFile, canonicalSanitizerCarrierFile).exact) ||
    !hasClosedChildProcessImportSet(sourceFile, ["spawn", "spawnSync"]) ||
    !hasExactDefaultImport(sourceFile, "node:assert/strict", "assert") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:child_process", "spawn") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:fs/promises", "mkdtemp") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:fs/promises", "realpath") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:path", "join") ||
    !hasExactUnaliasedNamedImport(sourceFile, "./hr-browser-harness.mjs", "withTimeout") ||
    !hasExactUnaliasedNamedImport(sourceFile, "./with-postgres.mjs", "captureOwnedDirectory") ||
    !hasExactUnaliasedNamedImport(sourceFile, "./with-postgres.mjs", "cleanupExactOwnedDirectories")
  ) {
    diagnostics.push(`${label}:1:fixture-cleanup-helper-provenance`);
  }

  return [...new Set(diagnostics)];
}

function canonicalOwnedControllerSupportSource() {
  return [
    "function openOwnershipDescriptor() {",
    "  const tokenPath = join(",
    "    wrapperTemporaryRoot,",
    "    `.wrapper-ownership-${process.pid}-${randomUUID()}`,",
    "  );",
    "  let ownershipFd;",
    "  try {",
    '    ownershipFd = openSync(tokenPath, "wx+", 0o600);',
    "    openWrapperOwnershipDescriptors.add(ownershipFd);",
    "    const identity = exactFilesystemIdentity(fstatSync(ownershipFd, { bigint: true }));",
    "    unlinkSync(tokenPath);",
    "    return { fd: ownershipFd, identity };",
    "  } catch (error) {",
    "    const failures = [error];",
    "    if (ownershipFd !== undefined) {",
    "      try {",
    "        closeSync(ownershipFd);",
    "        openWrapperOwnershipDescriptors.delete(ownershipFd);",
    "      } catch (cleanupError) {",
    "        failures.push(cleanupError);",
    "      }",
    "      try {",
    "        unlinkSync(tokenPath);",
    "      } catch (cleanupError) {",
    '        if (cleanupError?.code !== "ENOENT") failures.push(cleanupError);',
    "      }",
    "    }",
    "    if (failures.length > 1) {",
    '      throw new AggregateError(failures, "wrapper ownership setup failed");',
    "    }",
    "    throw error;",
    "  }",
    "}",
    "function spawnOwnedChild(command, args, environment, ownershipFd, superviseBrowser) {",
    "  return spawn(",
    "    process.execPath,",
    '    [withPostgres, ...(superviseBrowser ? ["--supervise-browser"] : []), command, ...args],',
    "    {",
    "      cwd: repositoryRoot,",
    "      env: { ...process.env, ...environment, TMPDIR: wrapperTemporaryRoot },",
    '      stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", ownershipFd],',
    "    },",
    "  );",
    "}",
    "function createWrapperCloseDeadlineError() {",
    '  const error = new Error("wrapper close deadline exceeded");',
    '  error.code = "ERR_WRAPPER_CLOSE_DEADLINE";',
    '  Object.defineProperty(error, "stack", {',
    "    configurable: true,",
    "    enumerable: false,",
    '    value: "Error: wrapper close deadline exceeded",',
    "    writable: true,",
    "  });",
    "  return error;",
    "}",
    "async function settleControllerBefore(closeOutcome, deadline) {",
    "  const remaining = Math.max(0, deadline - Date.now());",
    "  let timer;",
    "  try {",
    "    return await Promise.race([",
    "      closeOutcome,",
    "      new Promise((_, reject) => {",
    "        timer = setTimeout(() => reject(createWrapperCloseDeadlineError()), remaining);",
    "      }),",
    "    ]);",
    "  } finally {",
    "    if (timer) clearTimeout(timer);",
    "  }",
    "}",
    "function retainExactWrapperIdentity(",
    "  childPid,",
    "  parentPid,",
    "  ownershipIdentity,",
    "  first,",
    "  second,",
    "  descriptorIdentity,",
    ") {",
    "  if (!first || !second || !descriptorIdentity) return undefined;",
    "  if (first.pid !== childPid || first.ppid !== parentPid) return undefined;",
    "  if (!sameProcessIdentity(first, second)) return undefined;",
    "  if (!sameFilesystemIdentity(descriptorIdentity, ownershipIdentity)) return undefined;",
    "  return first;",
    "}",
  ].join("\n");
}

function canonicalOrdinaryChildOutcomeSource() {
  return [
    "async function ordinaryChildOutcome(child, timeoutMs = 45_000) {",
    '  let stdout = "";',
    '  let stderr = "";',
    '  child.stdout?.on("data", (chunk) => {',
    "    stdout += String(chunk);",
    "  });",
    '  child.stderr?.on("data", (chunk) => {',
    "    stderr += String(chunk);",
    "  });",
    "  return await new Promise((resolveOutcome, rejectOutcome) => {",
    "    let settled = false;",
    "    let timer;",
    "    const settle = (callback) => {",
    "      if (settled) return;",
    "      settled = true;",
    "      if (timer) clearTimeout(timer);",
    "      callback();",
    "    };",
    "    timer = setTimeout(",
    "      () =>",
    "        settle(() =>",
    '          rejectOutcome(new Error(`Child ${child.pid ?? "unknown"} exceeded ${timeoutMs}ms`)),',
    "        ),",
    "      timeoutMs,",
    "    );",
    '    child.once("error", (error) => settle(() => rejectOutcome(error)));',
    '    child.once("exit", (code, signal) =>',
    "      settle(() => resolveOutcome({ code, signal, stderr, stdout })),",
    "    );",
    "  });",
    "}",
  ].join("\n");
}

function canonicalOwnedControllerEnvironmentSource() {
  return [
    'const repositoryRoot=resolve(fileURLToPath(new URL("../..",import.meta.url)));',
    'const withPostgres=join(repositoryRoot,"scripts/test/with-postgres.mjs");',
    'const wrapperTemporaryRoot=await mkdtemp(join("/tmp","ebw-"));',
    canonicalSignalHelperSemanticSource("exactFilesystemIdentity"),
    canonicalSignalHelperSemanticSource("readProcessDescriptorIdentity"),
    canonicalSignalHelperSemanticSource("readProcessIdentity"),
    canonicalSignalHelperSemanticSource("sameFilesystemIdentity"),
    canonicalSignalHelperSemanticSource("sameProcessIdentity"),
  ].join("\n");
}

function canonicalOwnedControllerLifecycleSource() {
  return [
    canonicalOwnedControllerSupportSource(),
    canonicalOrdinaryChildOutcomeSource(),
    "async function childOutcome(child, timeoutMs = 45_000) {",
    "  if (child?.ownedWrapperController) return await child.finish(timeoutMs);",
    "  return await ordinaryChildOutcome(child, timeoutMs);",
    "}",
    "function spawnOwnedWrapperController(",
    "  command,",
    "  args = [],",
    "  environment = {},",
    "  { operationTimeoutMs = 35_000, superviseBrowser = true } = {},",
    ") {",
    "  const startedAt = Date.now();",
    "  const absoluteControllerDeadline = startedAt + operationTimeoutMs + 38_000;",
    '  let acquisitionState = "not-attempted";',
    "  let ownershipFd;",
    "  let ownershipIdentity;",
    "  let ownershipTracked = false;",
    "  let exitObserved = false;",
    "  let closeObserved = false;",
    "  let closeObserverBound = false;",
    "  let finalized = false;",
    "  let finalizationError;",
    "  let finishAttempt;",
    "  let identityRecorded = false;",
    "  let retainedIdentity;",
    "  let retentionRounds = 0;",
    "  let setupFailure;",
    "  let setupTerminationRequested = false;",
    "  let child;",
    '  let stderr = "";',
    "  let processError;",
    '  let stdout = "";',
    "  let resolveCloseOutcome;",
    "  const controllerErrors = [];",
    "  const closeOutcome = new Promise((resolveClose) => { resolveCloseOutcome = resolveClose; });",
    "  const controller = {",
    "    controllerErrors,",
    "    get exitCode() { return child?.exitCode ?? null; },",
    "    get hardKillUsed() { return false; },",
    "    ownedWrapperController: true,",
    "    outcome: closeOutcome,",
    "    get phase() { return acquisitionState; },",
    "    get pid() { return child?.pid; },",
    "    get rescueUsed() { return false; },",
    "    get signalCode() { return child?.signalCode ?? null; },",
    "    get settled() { return closeObserved; },",
    "  };",
    "  const publishCloseOutcome = (code, signal) => {",
    "    if (closeObserved) return;",
    "    closeObserved = true;",
    "    resolveCloseOutcome({ code, error: processError, signal, stderr, stdout });",
    "  };",
    "  const childStdioClosed = () =>",
    "    [child?.stdin, child?.stdout, child?.stderr].every(",
    "      (stream) => !stream || stream.closed === true,",
    "    );",
    "  const refreshUnboundCloseOutcome = () => {",
    "    if (!child || closeObserved) return;",
    "    if ((child.exitCode !== null || child.signalCode !== null) && childStdioClosed()) {",
    "      exitObserved = true;",
    "      publishCloseOutcome(child.exitCode, child.signalCode);",
    "    }",
    "  };",
    "  const waitForControllerCloseBefore = async (deadline) => {",
    "    while (true) {",
    "      refreshUnboundCloseOutcome();",
    "      if (closeObserved) return await closeOutcome;",
    "      if (closeObserverBound) return await settleControllerBefore(closeOutcome, deadline);",
    "      const remaining = deadline - Date.now();",
    "      if (remaining <= 0) throw createWrapperCloseDeadlineError();",
    "      await new Promise((resolveWait) =>",
    "        setTimeout(resolveWait, Math.min(25, remaining)),",
    "      );",
    "    }",
    "  };",
    "  const retainOwnedWrapper = () => {",
    "    while (",
    "      retentionRounds < 3 &&",
    "      !retainedIdentity &&",
    "      !closeObserved &&",
    "      Date.now() < absoluteControllerDeadline",
    "    ) {",
    "      refreshUnboundCloseOutcome();",
    "      if (closeObserved || child.exitCode !== null || child.signalCode !== null) break;",
    "      retentionRounds += 1;",
    "      const first = readProcessIdentity(child.pid, 1_000);",
    "      const second = readProcessIdentity(child.pid, 1_000);",
    "      const descriptorIdentity = readProcessDescriptorIdentity(child.pid, 6);",
    "      retainedIdentity = retainExactWrapperIdentity(",
    "        child.pid,",
    "        process.pid,",
    "        ownershipIdentity,",
    "        first,",
    "        second,",
    "        descriptorIdentity,",
    "      );",
    "      if (",
    "        !retainedIdentity &&",
    "        !closeObserved &&",
    "        child.exitCode === null &&",
    "        child.signalCode === null",
    "      ) {",
    "        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
    "      }",
    "    }",
    "    refreshUnboundCloseOutcome();",
    "    if (",
    "      !retainedIdentity &&",
    "      !closeObserved &&",
    "      child.exitCode === null &&",
    "      child.signalCode === null",
    "    ) {",
    '      throw new Error("Unable to retain owned wrapper identity");',
    "    }",
    "    if (retainedIdentity && !identityRecorded) {",
    "      recordedWrapperIdentities.push(retainedIdentity);",
    "      identityRecorded = true;",
    '      acquisitionState = "identity-retained";',
    "    }",
    "    controller.identity = retainedIdentity;",
    "    return retainedIdentity;",
    "  };",
    "  const verifyOwnedWrapperImmediatelyBeforeSignal = () => {",
    '    if (exitObserved || closeObserved) throw new Error("wrapper already settled");',
    "    const first = readProcessIdentity(child.pid, 1_000);",
    "    const second = readProcessIdentity(child.pid, 1_000);",
    "    const firstDescriptorIdentity = readProcessDescriptorIdentity(child.pid, 6);",
    '    assert.ok(retainedIdentity, "wrapper identity was not retained");',
    '    assert.ok(first && second && firstDescriptorIdentity, "wrapper is not live");',
    '    assert.equal(child.pid, retainedIdentity.pid, "wrapper ChildProcess identity changed");',
    '    assert.ok(sameProcessIdentity(retainedIdentity, first), "wrapper identity changed");',
    '    assert.ok(sameProcessIdentity(first, second), "wrapper identity was unstable");',
    '    assert.equal(first.ppid, process.pid, "wrapper is no longer the direct child");',
    "    assert.ok(",
    "      sameFilesystemIdentity(",
    "        firstDescriptorIdentity,",
    "        exactFilesystemIdentity(fstatSync(ownershipFd, { bigint: true })),",
    "      ),",
    '      "wrapper FD-6 ownership capability changed",',
    "    );",
    "    const boundary = readProcessIdentity(child.pid, 1_000);",
    "    const boundaryDescriptorIdentity = readProcessDescriptorIdentity(child.pid, 6);",
    '    assert.ok(boundary && boundaryDescriptorIdentity, "wrapper changed at signal boundary");',
    '    assert.ok(sameProcessIdentity(second, boundary), "wrapper identity changed at signal boundary");',
    '    assert.ok(sameFilesystemIdentity(firstDescriptorIdentity, boundaryDescriptorIdentity), "wrapper FD-6 capability changed at signal boundary");',
    "    return boundary;",
    "  };",
    "  const signal = (signalName) => {",
    '    assert.ok(signalName === "SIGINT" || signalName === "SIGTERM", "unsupported wrapper signal");',
    "    if (exitObserved || closeObserved) return false;",
    "    verifyOwnedWrapperImmediatelyBeforeSignal();",
    "    const delivered = child.kill(signalName);",
    '    assert.equal(delivered, true, "wrapper signal was not delivered");',
    "    return true;",
    "  };",
    "  const outcomeWithin = async (timeoutMs) => {",
    "    try {",
    "      await waitForControllerCloseBefore(",
    "        Math.min(Date.now() + timeoutMs, absoluteControllerDeadline),",
    "      );",
    "      return true;",
    "    } catch (error) {",
    '      if (error?.code === "ERR_WRAPPER_CLOSE_DEADLINE") return false;',
    "      throw error;",
    "    }",
    "  };",
    "  const finish = (requestedTimeoutMs = Number.MAX_SAFE_INTEGER) => {",
    "    refreshUnboundCloseOutcome();",
    "    const requestedDeadline = Date.now() + requestedTimeoutMs;",
    "    const finishDeadline = Math.min(requestedDeadline, absoluteControllerDeadline);",
    "    if (finishAttempt) return finishAttempt;",
    "    finishAttempt = (async () => {",
    "      refreshUnboundCloseOutcome();",
    "      if (setupFailure && !closeObserved && !setupTerminationRequested) {",
    "        if (",
    "          !retainedIdentity &&",
    "          retentionRounds < 3 &&",
    "          child.exitCode === null &&",
    "          child.signalCode === null",
    "        ) {",
    "          try {",
    "            retainOwnedWrapper();",
    "          } catch (error) {",
    "            controllerErrors.push(error);",
    "          }",
    "        }",
    "        refreshUnboundCloseOutcome();",
    "        if (",
    "          retainedIdentity &&",
    "          !closeObserved &&",
    "          child.exitCode === null &&",
    "          child.signalCode === null",
    "        ) {",
    "          try {",
    '            setupTerminationRequested = signal("SIGTERM");',
    "          } catch (error) {",
    "            controllerErrors.push(error);",
    "          }",
    "        }",
    "      }",
    "      return await waitForControllerCloseBefore(finishDeadline);",
    "    })()",
    "      .then((result) => {",
    "        if (!closeObserved) throw createWrapperCloseDeadlineError();",
    "        if (!finalized) {",
    "          const failures = [];",
    "          if (ownershipTracked) {",
    "            try {",
    "              closeSync(ownershipFd);",
    "              openWrapperOwnershipDescriptors.delete(ownershipFd);",
    "              ownershipTracked = false;",
    "            } catch (error) {",
    "              failures.push(error);",
    "            }",
    "          }",
    "          activeWrapperControllers.delete(controller);",
    "          completedWrapperControllers.push(controller);",
    '          acquisitionState = "finalized";',
    "          finalized = true;",
    "          if (failures.length > 0) {",
    "            controllerErrors.push(...failures);",
    '            finalizationError = new AggregateError(failures, "wrapper controller finalization failed");',
    "          }",
    "        }",
    "        if (setupFailure) {",
    '          throw new AggregateError([...controllerErrors], "wrapper controller setup failed");',
    "        }",
    "        if (finalizationError) throw finalizationError;",
    "        return result;",
    "      })",
    "      .catch((error) => {",
    "        if (!finalized) {",
    "          finishAttempt = undefined;",
    "          if (setupFailure) {",
    "            throw new AggregateError(",
    "              controllerErrors.includes(error)",
    "                ? [...controllerErrors]",
    "                : [...controllerErrors, error],",
    '              "wrapper controller setup recovery failed",',
    "            );",
    "          }",
    "        }",
    "        throw error;",
    "      });",
    "    return finishAttempt;",
    "  };",
    "  controller.absoluteControllerDeadline = absoluteControllerDeadline;",
    "  controller.finish = finish;",
    "  controller.outcomeWithin = outcomeWithin;",
    "  controller.signal = signal;",
    "  controller.verifyOwnedWrapper = verifyOwnedWrapperImmediatelyBeforeSignal;",
    "  try {",
    "    const ownership = openOwnershipDescriptor();",
    "    ownershipFd = ownership.fd;",
    "    ownershipTracked = true;",
    "    ownershipIdentity = ownership.identity;",
    '    assert.equal(openWrapperOwnershipDescriptors.has(ownershipFd), true, "ownership descriptor was not tracked");',
    "    child = spawnOwnedChild(",
    "      command,",
    "      args,",
    "      environment,",
    "      ownershipFd,",
    "      superviseBrowser,",
    "    );",
    "    controller.child = child;",
    '    acquisitionState = "acquired";',
    "    activeWrapperControllers.add(controller);",
    '    child.once("close", (code, signalName) => publishCloseOutcome(code, signalName));',
    "    closeObserverBound = true;",
    '    acquisitionState = "close-bound";',
    '    child.once("exit", () => { exitObserved = true; });',
    '    child.once("error", (error) => { processError = error; });',
    '    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });',
    '    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });',
    "    retainOwnedWrapper();",
    "    if (retainedIdentity && !closeObserved) verifyOwnedWrapperImmediatelyBeforeSignal();",
    "    return controller;",
    "  } catch (error) {",
    "    if (child) {",
    "      setupFailure = error;",
    "      controllerErrors.push(error);",
    "      controller.identity = retainedIdentity;",
    "      return controller;",
    "    }",
    '    acquisitionState = "no-subject";',
    "    const failures = [error];",
    "    if (ownershipTracked && ownershipFd !== undefined) {",
    "      try {",
    "        closeSync(ownershipFd);",
    "        openWrapperOwnershipDescriptors.delete(ownershipFd);",
    "        ownershipTracked = false;",
    "      } catch (cleanupError) {",
    "        failures.push(cleanupError);",
    "      }",
    "    }",
    "    if (failures.length > 1) {",
    '      throw new AggregateError(failures, "wrapper controller setup failed");',
    "    }",
    "    throw error;",
    "  }",
    "}",
  ].join("\n");
}

function collectMaliciousDeadlineDiagnostics(sourceText, label) {
  const sourceFile = ts.createSourceFile(
    label,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) return [`${label}:1:parse-error`];

  const canonicalFile = ts.createSourceFile(
    "canonical-malicious-deadline",
    canonicalMaliciousDeadlineSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const diagnostics = [];
  const staticAuthorityAcquisitions = classifyStaticAuthorityAcquisitions(
    sourceFile,
    canonicalFile,
  );
  if (!staticAuthorityAcquisitions.exact) {
    diagnostics.push(label + ":1:malicious-static-authority-acquisition");
  }
  const sealedVariants = Object.freeze([
    "malformed",
    "multiply-linked",
    "wrong-nonce",
    "wrong-nonce-resistant-harness",
    "wrong-parent",
    "wrong-start",
    "wrong-record-uid",
    "wrong-pgid",
    "unrelated-process",
    "leader-gone",
    "changed-parent",
    "executable-substring",
    "wrong-mode",
    "symlink",
  ]);
  if (
    maliciousRegistrationVariantContract.length !== sealedVariants.length ||
    maliciousRegistrationVariantContract.some((variant, index) => variant !== sealedVariants[index])
  ) {
    diagnostics.push(`${label}:1:malicious-variant-contract-invalid`);
  }
  const actualManifest = directVariableDeclarations(sourceFile, "maliciousRegistrationVariants");
  const canonicalManifest = directVariableDeclarations(
    canonicalFile,
    "maliciousRegistrationVariants",
  );
  const manifestIdentifierNodes = [];
  visitNode(sourceFile, (node) => {
    if (ts.isIdentifier(node) && node.text === "maliciousRegistrationVariants") {
      manifestIdentifierNodes.push(node);
    }
  });
  if (
    actualManifest.length !== 1 ||
    canonicalManifest.length !== 1 ||
    manifestIdentifierNodes.length !== 1 ||
    manifestIdentifierNodes[0] !== actualManifest[0]?.name ||
    !isConstVariableDeclaration(actualManifest[0]) ||
    sourceLevelBindingNodes(sourceFile, "maliciousRegistrationVariants").length !== 1 ||
    hasIdentifierReassignment(sourceFile, "maliciousRegistrationVariants") ||
    astFingerprint(actualManifest[0], sourceFile) !==
      astFingerprint(canonicalManifest[0], canonicalFile)
  ) {
    diagnostics.push(`${label}:1:malicious-variant-manifest-invalid`);
  }

  const exactHelper = (name) => {
    const actual = uniqueTopLevelFunctionDeclaration(sourceFile, name);
    const canonical = uniqueTopLevelFunctionDeclaration(canonicalFile, name);
    return Boolean(
      actual &&
        canonical &&
        sourceLevelBindingNodes(sourceFile, name).length === 1 &&
        !hasIdentifierReassignment(sourceFile, name) &&
        astFingerprint(actual, sourceFile) === astFingerprint(canonical, canonicalFile),
    );
  };
  const rootedCallContracts = (containingFile, rootName) => {
    const entries = [];
    visitNode(containingFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const path = staticAuthorityPath(node.expression, containingFile) ?? [];
      if (path[0] !== rootName) return;
      const owner = enclosingFunctionNode(node);
      entries.push({
        node,
        contract: {
          call: astFingerprint(node, containingFile),
          owner: owner ? (functionLikeName(owner) ?? ts.SyntaxKind[owner.kind]) : "top-level",
          path,
        },
      });
    });
    return entries;
  };
  const audit002Registration = directNamedTestRegistration(
    sourceFile,
    "V1C3-AUDIT-002 retains roots for a no-intent detached exact launcher",
    "HR browser harness contracts",
  );
  const audit002Callback = audit002Registration?.arguments.at(-1);
  const audit002BrowserCalls = [];
  if (audit002Callback) {
    visitNode(audit002Callback, (node) => {
      if (
        ts.isCallExpression(node) &&
        staticAuthorityPath(node.expression, sourceFile)?.[0] === "browserToolingChromium"
      ) {
        audit002BrowserCalls.push(node);
      }
    });
  }
  const audit002BrowserCall = audit002BrowserCalls[0];
  const realpathCall = audit002BrowserCall?.parent;
  const sensitiveArray = realpathCall?.parent;
  const freezeCall = sensitiveArray?.parent;
  const sensitiveDeclaration = freezeCall?.parent;
  const exactAudit002SensitiveExecutableCall = Boolean(
    audit002BrowserCalls.length === 1 &&
      ts.isCallExpression(audit002BrowserCall) &&
      !audit002BrowserCall.questionDotToken &&
      audit002BrowserCall.arguments.length === 0 &&
      ts.isPropertyAccessExpression(audit002BrowserCall.expression) &&
      !audit002BrowserCall.expression.questionDotToken &&
      staticAuthorityPath(audit002BrowserCall.expression, sourceFile)?.join(".") ===
        "browserToolingChromium.executablePath" &&
      ts.isCallExpression(realpathCall) &&
      !realpathCall.questionDotToken &&
      realpathCall.arguments.length === 1 &&
      realpathCall.arguments[0] === audit002BrowserCall &&
      staticAuthorityPath(realpathCall.expression, sourceFile)?.join(".") === "realpathSync" &&
      ts.isArrayLiteralExpression(sensitiveArray) &&
      sensitiveArray.elements.includes(realpathCall) &&
      ts.isCallExpression(freezeCall) &&
      !freezeCall.questionDotToken &&
      freezeCall.arguments.length === 1 &&
      freezeCall.arguments[0] === sensitiveArray &&
      staticAuthorityPath(freezeCall.expression, sourceFile)?.join(".") === "Object.freeze" &&
      ts.isVariableDeclaration(sensitiveDeclaration) &&
      sensitiveDeclaration.initializer === freezeCall &&
      ts.isIdentifier(sensitiveDeclaration.name) &&
      sensitiveDeclaration.name.text === "sensitiveValues" &&
      isConstVariableDeclaration(sensitiveDeclaration) &&
      namedBindingNodes(audit002Callback, "sensitiveValues").length === 1 &&
      !hasIdentifierReassignment(audit002Callback, "sensitiveValues"),
  );
  const canonicalBrowserOnlyEnvelope = !audit002Registration && audit002BrowserCalls.length === 0;
  const actualBrowserCalls = rootedCallContracts(sourceFile, "browserToolingChromium")
    .filter(({ node }) => node !== audit002BrowserCall)
    .map(({ contract }) => contract);
  const canonicalBrowserCalls = rootedCallContracts(canonicalFile, "browserToolingChromium").map(
    ({ contract }) => contract,
  );
  if (
    (!canonicalBrowserOnlyEnvelope && !exactAudit002SensitiveExecutableCall) ||
    JSON.stringify(actualBrowserCalls) !== JSON.stringify(canonicalBrowserCalls)
  ) {
    diagnostics.push(`${label}:1:malicious-browser-call-contract-invalid`);
  }
  if (hasStaticEvaluatorModuleAcquisition(sourceFile)) {
    diagnostics.push(`${label}:1:malicious-evaluator-acquisition`);
  }
  const helperNames = [
    "assertNoOwnedResidue",
    "browserTemporaryDirectories",
    "captureStableProcessIdentity",
    "childOutcome",
    "createCooperativeCloseState",
    "createCooperativeFixtureSlot",
    "diagnosticsExcludeTrackedValues",
    "isSemanticSessionLeader",
    "joinCooperativeFixture",
    "observeChildClose",
    "openOwnershipDescriptor",
    "pathExists",
    "postgresTemporaryDirectories",
    "publishCooperativeClose",
    "publishCooperativeFixtureStop",
    "refreshCooperativeClose",
    "readProcessDescriptorIdentity",
    "readProcessIdentity",
    "readSemanticSessionObservation",
    "retainCooperativeFixture",
    "retainCooperativeFixtureReceipt",
    "runMaliciousRegistrationCase",
    "sameFilesystemIdentity",
    "sameProcessIdentity",
    "spawnCooperativeFixture",
    "settleCooperativeClose",
    "spawnOwnedWrapperController",
    "stopAndJoinCooperativeFixture",
    "waitForExactProcessExit",
    "waitForFile",
    "writePrivateStop",
  ];
  if (
    !helperNames.every(exactHelper) ||
    !exactOwnedControllerAuthority(sourceFile, canonicalFile).exact
  ) {
    diagnostics.push(`${label}:1:malicious-helper-lifecycle-missing`);
  }

  const exactRegistrations = sealedVariants.every((variant) => {
    const title = `denies malicious registration: ${variant}`;
    const actual = directNamedTestRegistration(
      sourceFile,
      title,
      "malicious registration contracts",
    );
    const canonical = directNamedTestRegistration(
      canonicalFile,
      title,
      "malicious registration contracts",
    );
    if (!actual || !canonical || actual.arguments.length !== 3) return false;
    return (
      astFingerprint(actual.arguments[1], sourceFile) ===
        astFingerprint(canonical.arguments[1], canonicalFile) &&
      astFingerprint(actual.arguments[2], sourceFile) ===
        astFingerprint(canonical.arguments[2], canonicalFile)
    );
  });
  const maliciousRegistrations = [];
  visitNode(sourceFile, (node) => {
    if (
      isCallNamed(node, "it") &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      node.arguments[0].text.startsWith("denies malicious registration:")
    ) {
      maliciousRegistrations.push(node);
    }
  });
  const directCaseCalls = [];
  visitNode(sourceFile, (node) => {
    if (isCallNamed(node, "runMaliciousRegistrationCase")) directCaseCalls.push(node);
  });
  const maliciousVariantConsumerRegistrations = [];
  visitNode(sourceFile, (node) => {
    if (!isCallNamed(node, "it")) return;
    const callback = node.arguments.at(-1);
    if (!callback) return;
    let consumesSealedVariant = false;
    let referencesSealedManifest = false;
    visitNode(callback, (candidate) => {
      if (ts.isIdentifier(candidate) && candidate.text === "maliciousRegistrationVariants") {
        referencesSealedManifest = true;
      }
      if (
        (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) &&
        sealedVariants.includes(candidate.text)
      ) {
        consumesSealedVariant = true;
      }
    });
    if (
      consumesSealedVariant ||
      (referencesSealedManifest && !containsLocalBinding(callback, "maliciousRegistrationVariants"))
    ) {
      maliciousVariantConsumerRegistrations.push(node);
    }
  });
  const directIdentifierCall = (expression, name) => {
    const call = unparenthesizedExpression(expression);
    const callee = ts.isCallExpression(call)
      ? unparenthesizedExpression(call.expression)
      : undefined;
    return ts.isCallExpression(call) &&
      !call.questionDotToken &&
      ts.isIdentifier(callee) &&
      callee.text === name
      ? call
      : undefined;
  };
  const topLevelCallsNamed = (file, name) =>
    file.statements
      .filter(ts.isExpressionStatement)
      .map((statement) => directIdentifierCall(statement.expression, name))
      .filter(Boolean);
  const exactDescribe = (call, title) =>
    Boolean(
      call &&
        call.arguments.length === 2 &&
        isStringLiteralValue(call.arguments[0], title) &&
        ts.isArrowFunction(call.arguments[1]) &&
        call.arguments[1].parameters.length === 0 &&
        !isAsyncFunctionLike(call.arguments[1]) &&
        ts.isBlock(call.arguments[1].body),
    );
  const dedicatedDescribe = topLevelCallsNamed(sourceFile, "describe").filter((call) =>
    exactDescribe(call, "malicious registration contracts"),
  );
  const hrDescribe = topLevelCallsNamed(sourceFile, "describe").filter((call) =>
    exactDescribe(call, "HR browser harness contracts"),
  );
  const canonicalDedicatedDescribe = canonicalFile.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => directIdentifierCall(statement.expression, "describe"))
    .find(
      (expression) =>
        expression &&
        isStringLiteralValue(expression.arguments[0], "malicious registration contracts"),
    );
  const dedicatedDescribeStatement = dedicatedDescribe[0]?.parent;
  const dedicatedDescribeIndex = dedicatedDescribeStatement
    ? sourceFile.statements.indexOf(dedicatedDescribeStatement)
    : -1;
  const hrDescribeStatement = hrDescribe[0]?.parent;
  const hrDescribeIndex = hrDescribeStatement
    ? sourceFile.statements.indexOf(hrDescribeStatement)
    : -1;

  const canonicalHarnessRegistrationFile = ts.createSourceFile(
    "canonical-malicious-registration-prefix",
    canonicalHarnessSuiteFinalizerRegistrationSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const actualAfterCalls = topLevelCallsNamed(sourceFile, "after");
  const canonicalHarnessAfterCalls = topLevelCallsNamed(canonicalHarnessRegistrationFile, "after");
  const actualAfterStatement = actualAfterCalls[0]?.parent;
  const canonicalHarnessAfterStatement = canonicalHarnessAfterCalls[0]?.parent;
  const actualAfterIndex = actualAfterStatement
    ? sourceFile.statements.indexOf(actualAfterStatement)
    : -1;
  const canonicalHarnessAfterIndex = canonicalHarnessAfterStatement
    ? canonicalHarnessRegistrationFile.statements.indexOf(canonicalHarnessAfterStatement)
    : -1;
  const exactTopLevelPrefix = Boolean(
    actualAfterCalls.length === 1 &&
      canonicalHarnessAfterCalls.length === 1 &&
      actualAfterIndex >= 0 &&
      canonicalHarnessAfterIndex >= 0 &&
      JSON.stringify(
        sourceFile.statements
          .slice(0, actualAfterIndex)
          .map((statement) => astFingerprint(statement, sourceFile)),
      ) ===
        JSON.stringify(
          canonicalHarnessRegistrationFile.statements
            .slice(0, canonicalHarnessAfterIndex)
            .map((statement) => astFingerprint(statement, canonicalHarnessRegistrationFile)),
        ) &&
      hasExactCanonicalSuiteFinalizer(sourceFile),
  );

  const canonicalHrDescribe = topLevelCallsNamed(canonicalFile, "describe").find((call) =>
    exactDescribe(call, "HR browser harness contracts"),
  );
  const canonicalAfterCalls = topLevelCallsNamed(canonicalFile, "after");
  const canonicalAfterStatement = canonicalAfterCalls[0]?.parent;
  const canonicalAfterIndex = canonicalAfterStatement
    ? canonicalFile.statements.indexOf(canonicalAfterStatement)
    : -1;
  const canonicalHrDescribeIndex = canonicalHrDescribe
    ? canonicalFile.statements.indexOf(canonicalHrDescribe.parent)
    : -1;
  const statementsBetweenAfterAndHr =
    actualAfterIndex >= 0 && hrDescribeIndex > actualAfterIndex
      ? sourceFile.statements.slice(actualAfterIndex + 1, hrDescribeIndex)
      : [];
  const canonicalVariablesBetweenAfterAndHr =
    canonicalAfterIndex >= 0 && canonicalHrDescribeIndex > canonicalAfterIndex
      ? canonicalFile.statements
          .slice(canonicalAfterIndex + 1, canonicalHrDescribeIndex)
          .filter(ts.isVariableStatement)
      : [];
  const variablesBetweenAfterAndHr = statementsBetweenAfterAndHr.filter(ts.isVariableStatement);
  const forbiddenInertFunctionNames = new Set([
    "NaN",
    "Infinity",
    "Object",
    "Promise",
    "Set",
    "URL",
    "WeakSet",
    "after",
    "describe",
    "fileURLToPath",
    "it",
    "join",
    "maliciousRegistrationVariants",
    "mkdtemp",
    "process",
    "resolve",
    "undefined",
  ]);
  const forbiddenRegistrationLoopBindings = new Set([
    ...forbiddenInertFunctionNames,
    "runAbruptHarnessCrashCase",
  ]);
  const inertFunctionDeclaration = (statement) =>
    Boolean(
      ts.isFunctionDeclaration(statement) &&
        statement.name &&
        !forbiddenInertFunctionNames.has(statement.name.text) &&
        sourceLevelBindingNodes(sourceFile, statement.name.text).length === 1,
    );
  const exactPostFinalizerDeclarations = Boolean(
    statementsBetweenAfterAndHr.length > 0 &&
      statementsBetweenAfterAndHr.every(
        (statement) => ts.isVariableStatement(statement) || inertFunctionDeclaration(statement),
      ) &&
      variablesBetweenAfterAndHr.length === canonicalVariablesBetweenAfterAndHr.length &&
      variablesBetweenAfterAndHr.every(
        (statement, index) =>
          astFingerprint(statement, sourceFile) ===
          astFingerprint(canonicalVariablesBetweenAfterAndHr[index], canonicalFile),
      ),
  );

  const literalLoopValue = (node) => {
    const expression = unparenthesizedExpression(node);
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression) ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword
    ) {
      return true;
    }
    return Boolean(
      ts.isArrayLiteralExpression(expression) &&
        expression.elements.length > 0 &&
        expression.elements.every(
          (element) => !ts.isSpreadElement(element) && literalLoopValue(element),
        ),
    );
  };
  const registrationTitleValue = (node, loopBindings) => {
    const expression = unparenthesizedExpression(node);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return true;
    }
    return Boolean(
      ts.isTemplateExpression(expression) &&
        expression.templateSpans.every(
          (span) =>
            ts.isIdentifier(unparenthesizedExpression(span.expression)) &&
            loopBindings.has(unparenthesizedExpression(span.expression).text),
        ),
    );
  };
  const registrationOptions = (node) => {
    const expression = unparenthesizedExpression(node);
    if (!ts.isObjectLiteralExpression(expression) || expression.properties.length !== 1) {
      return false;
    }
    const property = expression.properties[0];
    const timeout = ts.isPropertyAssignment(property)
      ? numericLiteralValue(property.initializer)
      : undefined;
    return Boolean(
      ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        propertyNameStaticValue(property.name, sourceFile) === "timeout" &&
        Number.isSafeInteger(timeout) &&
        timeout > 0 &&
        timeout <= 150_000,
    );
  };
  const registrationCallback = (node) => {
    const expression = unparenthesizedExpression(node);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      return expression.parameters.length === 0;
    }
    return Boolean(
      ts.isIdentifier(expression) &&
        expression.text === "runAbruptHarnessCrashCase" &&
        uniqueTopLevelFunctionDeclaration(sourceFile, expression.text) &&
        sourceLevelBindingNodes(sourceFile, expression.text).length === 1,
    );
  };
  const safeRegistrationStatement = (statement, loopBindings = new Set()) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const call = directIdentifierCall(statement.expression, "it");
    if (!call || (call.arguments.length !== 2 && call.arguments.length !== 3)) {
      return false;
    }
    if (!registrationTitleValue(call.arguments[0], loopBindings)) return false;
    if (call.arguments.length === 3 && !registrationOptions(call.arguments[1])) {
      return false;
    }
    return registrationCallback(call.arguments.at(-1));
  };
  const registrationLoopBindings = (name, names = []) => {
    if (ts.isIdentifier(name)) {
      if (forbiddenRegistrationLoopBindings.has(name.text) || names.includes(name.text)) {
        return undefined;
      }
      return [...names, name.text];
    }
    if (!ts.isArrayBindingPattern(name) || name.elements.length === 0) return undefined;
    let collected = [...names];
    for (const element of name.elements) {
      if (
        ts.isOmittedExpression(element) ||
        !ts.isBindingElement(element) ||
        element.dotDotDotToken ||
        element.propertyName ||
        element.initializer
      ) {
        return undefined;
      }
      const next = registrationLoopBindings(element.name, collected);
      if (!next) return undefined;
      collected = next;
    }
    return collected;
  };
  const safeRegistrationLoop = (statement) => {
    if (
      !ts.isForOfStatement(statement) ||
      statement.awaitModifier ||
      !ts.isVariableDeclarationList(statement.initializer) ||
      !(statement.initializer.flags & ts.NodeFlags.Const) ||
      statement.initializer.declarations.length !== 1 ||
      !ts.isArrayLiteralExpression(unparenthesizedExpression(statement.expression)) ||
      !literalLoopValue(statement.expression) ||
      !ts.isBlock(statement.statement) ||
      statement.statement.statements.length !== 1
    ) {
      return false;
    }
    const declaration = statement.initializer.declarations[0];
    if (declaration.initializer) return false;
    const bindings = registrationLoopBindings(declaration.name);
    return Boolean(
      bindings && safeRegistrationStatement(statement.statement.statements[0], new Set(bindings)),
    );
  };
  const hrRegistrationBody = hrDescribe[0]?.arguments[1]?.body;
  const exactHrRegistrationEnvelope = Boolean(
    hrDescribe.length === 1 &&
      hrRegistrationBody &&
      ts.isBlock(hrRegistrationBody) &&
      hrRegistrationBody.statements.length > 0 &&
      hrRegistrationBody.statements.every(
        (statement) => safeRegistrationStatement(statement) || safeRegistrationLoop(statement),
      ),
  );
  const exactTopLevelRegistrationEnvelope = Boolean(
    exactTopLevelPrefix &&
      exactPostFinalizerDeclarations &&
      exactHrRegistrationEnvelope &&
      hrDescribeIndex + 1 === dedicatedDescribeIndex &&
      dedicatedDescribeIndex === sourceFile.statements.length - 1,
  );
  const actualDedicatedBody = dedicatedDescribe[0]?.arguments[1].body;
  const canonicalDedicatedBody = canonicalDedicatedDescribe?.arguments[1]?.body;
  const dedicatedBodyExact = Boolean(
    dedicatedDescribe.length === 1 &&
      actualDedicatedBody &&
      canonicalDedicatedBody &&
      ts.isBlock(actualDedicatedBody) &&
      ts.isBlock(canonicalDedicatedBody) &&
      actualDedicatedBody.statements.length === sealedVariants.length &&
      canonicalDedicatedBody.statements.length === sealedVariants.length &&
      actualDedicatedBody.statements.every(
        (statement, index) =>
          astFingerprint(statement, sourceFile) ===
          astFingerprint(canonicalDedicatedBody.statements[index], canonicalFile),
      ),
  );
  if (
    !exactRegistrations ||
    !dedicatedBodyExact ||
    !exactTopLevelRegistrationEnvelope ||
    maliciousRegistrations.length !== sealedVariants.length ||
    directCaseCalls.length !== sealedVariants.length ||
    maliciousVariantConsumerRegistrations.length !== sealedVariants.length ||
    maliciousVariantConsumerRegistrations.some(
      (registration) => !maliciousRegistrations.includes(registration),
    ) ||
    !hasClosedUnaliasedNamedImportSet(sourceFile, "node:test", ["after", "describe", "it"]) ||
    authorityAliasEscapeNodes(
      sourceFile,
      sourceFile,
      new Set([
        "describe",
        "it",
        "maliciousRegistrationVariants",
        "runMaliciousRegistrationCase",
        "browserToolingChromium",
      ]),
    ).length > 0
  ) {
    diagnostics.push(`${label}:1:malicious-independent-deadlines-missing`);
  }

  if (
    !hasExactDefaultImport(sourceFile, "node:assert/strict", "assert") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:child_process", "spawn") ||
    !hasExactUnaliasedNamedImport(sourceFile, "node:child_process", "spawnSync") ||
    !hasExactAliasedNamedImport(
      sourceFile,
      "./browser-tooling/node_modules/@playwright/test/index.mjs",
      "chromium",
      "browserToolingChromium",
    ) ||
    !hasExactUnaliasedNamedImport(sourceFile, "./hr-browser-harness.mjs", "withTimeout") ||
    !hasExactUnaliasedNamedImport(sourceFile, "./with-postgres.mjs", "captureOwnedDirectory") ||
    !hasExactUnaliasedNamedImport(sourceFile, "./with-postgres.mjs", "cleanupExactOwnedDirectories")
  ) {
    diagnostics.push(`${label}:1:malicious-helper-imports-invalid`);
  }

  return [...new Set(diagnostics)];
}

function directNamedTestRegistration(sourceFile, title, describeTitle) {
  const registrations = [];
  visitNode(sourceFile, (node) => {
    const statement = node.parent;
    const block = statement?.parent;
    const callback = block?.parent;
    const describeCall = callback?.parent;
    const describeStatement = describeCall?.parent;
    if (
      isCallNamed(node, "it") &&
      isStringLiteralValue(node.arguments[0], title) &&
      ts.isExpressionStatement(statement) &&
      ts.isBlock(block) &&
      ts.isArrowFunction(callback) &&
      callback.body === block &&
      describeCall &&
      isCallNamed(describeCall, "describe") &&
      describeCall.arguments.length === 2 &&
      isStringLiteralValue(describeCall.arguments[0], describeTitle) &&
      describeCall.arguments[1] === callback &&
      callback.parameters.length === 0 &&
      !isAsyncFunctionLike(callback) &&
      !containsLocalBinding(callback, "describe") &&
      !containsLocalBinding(callback, "it") &&
      ts.isExpressionStatement(describeStatement) &&
      describeStatement.parent === sourceFile &&
      sourceLevelBindingNodes(sourceFile, "describe").length === 1 &&
      sourceLevelBindingNodes(sourceFile, "it").length === 1 &&
      hasClosedUnaliasedNamedImportSet(sourceFile, "node:test", ["describe", "it"]) &&
      !hasAuthorityMutation(sourceFile, "describe") &&
      !hasAuthorityMutation(sourceFile, "it") &&
      authorityAliasEscapesContainingNamedRoots(sourceFile, sourceFile, ["describe", "it"])
        .length === 0
    ) {
      registrations.push(node);
    }
  });
  return registrations.length === 1 ? registrations[0] : undefined;
}

function directResultMember(node, sourceFile, member) {
  const expression = unparenthesizedExpression(node);
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(unparenthesizedExpression(expression.expression)) &&
    unparenthesizedExpression(expression.expression).text === "result"
  ) {
    return expression.name.text === member;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(unparenthesizedExpression(expression.expression)) &&
    unparenthesizedExpression(expression.expression).text === "result"
  ) {
    return resolvedStaticStringValue(expression.argumentExpression, sourceFile) === member;
  }
  return false;
}

function canonicalMalformedProgramSourceDeclaration() {
  const elements = [
    JSON.stringify('const {existsSync,linkSync,unlinkSync,writeFileSync}=require("node:fs")'),
    JSON.stringify('const {spawnSync}=require("node:child_process")'),
    JSON.stringify('const {createRequire}=require("node:module")'),
    "`const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`",
    JSON.stringify('const {chromium}=requirePlaywright("@playwright/test")'),
    "`const claimed=${JSON.stringify(claimed.identity)}`",
    JSON.stringify(
      'const identity=(pid)=>{const p=spawnSync("/bin/ps",["-ww","-o","pid=,ppid=,pgid=,sess=,uid=,lstart=,command=","-p",String(pid)],{encoding:"utf8",timeout:1_000}).stdout.trim().split(/\\s+/);return{pid:Number(p[0]),ppid:Number(p[1]),pgid:Number(p[2]),session:Number(p[3]),uid:Number(p[4]),start:p.slice(5,10).join(" "),command:p.slice(10).join(" ")}}',
    ),
    JSON.stringify("const root=process.env.ESBLA_BROWSER_CONTROL_ROOT"),
    JSON.stringify("const profile=process.env.ESBLA_BROWSER_PROFILE_ROOT"),
    JSON.stringify("const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE"),
    JSON.stringify("const realExecutable=chromium.executablePath()"),
    JSON.stringify('const wrongNonce=(nonce[0]==="a"?"b":"a")+nonce.slice(1)'),
    '`process.on("SIGTERM",()=>{try{writeFileSync(${JSON.stringify(harnessTermMarker)},"SIGTERM\\\\n",{flag:"a",mode:0o600})}catch{}})`',
    JSON.stringify(
      'for(let attempt=0;attempt<400&&!existsSync(root+"/harness.retained");attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)',
    ),
    JSON.stringify(
      'if(!existsSync(root+"/harness.retained"))throw new Error("harness retention was not published")',
    ),
    JSON.stringify('const intentTmp=root+"/.intent."+process.pid'),
    JSON.stringify(
      'writeFileSync(intentTmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
    ),
    JSON.stringify('linkSync(intentTmp,root+"/browser.intent")'),
    JSON.stringify("unlinkSync(intentTmp)"),
    JSON.stringify(
      'writeFileSync(root+"/browser.cancelled","malformed\\n",{flag:"wx",mode:0o600})',
    ),
    JSON.stringify(
      'const record={version:"2",nonce:wrongNonce,pid:String(claimed.pid),ppid:String(process.pid),pgid:String(claimed.pgid),session:String(claimed.session),uid:String(claimed.uid),start:claimed.start,parent_start:identity(process.pid).start,fd3:"open",fd4:"open",fd9:"open",real:realExecutable}',
    ),
    JSON.stringify(
      'const body=["version","nonce","pid","ppid","pgid","session","uid","start","parent_start","fd3","fd4","fd9","real"].map((key)=>key+"="+record[key]).join("\\n")+"\\n"',
    ),
    JSON.stringify('writeFileSync(root+"/browser.registration",body,{flag:"wx",mode:0o600})'),
    "`const ready={harness:identity(process.pid),profile,root,nonce,wrongNonce,realExecutable}`",
    '`const readyTmp=${JSON.stringify(readyPath)}+".tmp."+process.pid`',
    JSON.stringify('writeFileSync(readyTmp,JSON.stringify(ready),{flag:"wx",mode:0o600})'),
    "`linkSync(readyTmp,${JSON.stringify(readyPath)})`",
    JSON.stringify("unlinkSync(readyTmp)"),
    JSON.stringify("setInterval(()=>{},1000)"),
  ];
  return `const source=[${elements.join(",")}].join(";");`;
}

function exactMalformedProgramSourceDeclaration(target, sourceFile) {
  const declarations = [];
  visitNode(target, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "source"
    ) {
      declarations.push(node);
    }
  });
  const canonicalFile = ts.createSourceFile(
    "canonical-malformed-program-source",
    `async function canonicalTarget(){${canonicalMalformedProgramSourceDeclaration()}}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const canonicalTarget = uniqueTopLevelFunctionDeclaration(canonicalFile, "canonicalTarget");
  const canonical = directVariableDeclarations(canonicalTarget?.body, "source");
  return Boolean(
    declarations.length === 1 &&
      canonical.length === 1 &&
      isConstVariableDeclaration(declarations[0]) &&
      astFingerprint(declarations[0], sourceFile) === astFingerprint(canonical[0], canonicalFile),
  );
}

function collectSanitizerOrderingDiagnostics(sourceText, label) {
  const sourceFile = ts.createSourceFile(
    label,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) return [`${label}:1:parse-error`];

  const diagnostics = [];
  const canonicalSource = canonicalSanitizerOrderingSource();
  const canonicalFile = ts.createSourceFile(
    "canonical-sanitizer-ordering",
    canonicalSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const shadowBoundary = "}catch(error){hasPrimaryFailure=true;primaryFailure=error}finally{";
  const shadowInsertion =
    `${shadowBoundary}\n` + "const syntheticShadow=({result})=>result.status;void syntheticShadow;";
  const canonicalShadowSource =
    canonicalSource.split(shadowBoundary).length === 2
      ? canonicalSource.replace(shadowBoundary, shadowInsertion)
      : "";
  const canonicalShadowCarrierFile = ts.createSourceFile(
    "canonical-sanitizer-inert-shadow-carrier",
    canonicalShadowSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const staticAuthorityAcquisitions = classifyStaticAuthorityAcquisitions(
    sourceFile,
    canonicalFile,
  );
  const target = uniqueTopLevelFunctionDeclaration(
    sourceFile,
    "runMalformedCancellationIsolationCase",
  );
  const canonicalTarget = uniqueTopLevelFunctionDeclaration(
    canonicalFile,
    "runMalformedCancellationIsolationCase",
  );
  if (
    namedFunctionDeclarations(sourceFile, "runMalformedCancellationIsolationCase").length !== 1 ||
    !target ||
    !target.body ||
    !canonicalTarget?.body ||
    !isAsyncFunctionLike(target) ||
    target.parameters.length !== canonicalTarget.parameters.length ||
    !target.parameters.every(
      (parameter, index) =>
        astFingerprint(parameter, sourceFile) ===
        astFingerprint(canonicalTarget.parameters[index], canonicalFile),
    )
  ) {
    return [`${label}:1:sanitizer-target-missing`];
  }
  const controllerAuthorityExact =
    exactOwnedControllerAuthority(sourceFile, canonicalFile).exact ||
    (canonicalShadowSource.length > 0 &&
      canonicalShadowCarrierFile.parseDiagnostics.length === 0 &&
      exactOwnedControllerAuthority(sourceFile, canonicalShadowCarrierFile).exact);

  const helper = uniqueTopLevelFunctionDeclaration(sourceFile, "diagnosticsExcludeTrackedValues");
  const canonicalHelper = uniqueTopLevelFunctionDeclaration(
    canonicalFile,
    "diagnosticsExcludeTrackedValues",
  );
  if (
    !helper ||
    !canonicalHelper ||
    namedFunctionDeclarations(sourceFile, "diagnosticsExcludeTrackedValues").length !== 1 ||
    sourceLevelBindingNodes(sourceFile, "diagnosticsExcludeTrackedValues").length !== 1 ||
    hasIdentifierReassignment(sourceFile, "diagnosticsExcludeTrackedValues") ||
    containsLocalBinding(target, "diagnosticsExcludeTrackedValues") ||
    astFingerprint(helper, sourceFile) !== astFingerprint(canonicalHelper, canonicalFile) ||
    !hasExactDefaultImport(sourceFile, "node:assert/strict", "assert")
  ) {
    diagnostics.push(`${label}:1:sanitizer-exclusion-binding-invalid`);
  }

  const variableDeclarationsNamed = (root, name) => {
    const declarations = [];
    visitNode(root, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        declarations.push(node);
      }
    });
    return declarations;
  };
  const canonicalControllerMutations = identifierMutationNodes(
    canonicalTarget,
    "controller",
  ).filter((mutation) => {
    const left = unparenthesizedExpression(mutation.left);
    const right = unparenthesizedExpression(mutation.right);
    return Boolean(
      ts.isIdentifier(left) &&
        left.text === "controller" &&
        ts.isCallExpression(right) &&
        propertyChain(right.expression).join(".") === "spawnOwnedWrapperController",
    );
  });
  const canonicalReadyDeclarations = variableDeclarationsNamed(canonicalTarget, "ready");
  const canonicalResultDeclarations = variableDeclarationsNamed(canonicalTarget, "result");
  const canonicalRuntimeStatements = [
    canonicalControllerMutations.length === 1
      ? statementListLocation(canonicalControllerMutations[0])?.statement
      : undefined,
    canonicalReadyDeclarations.length === 1
      ? statementListLocation(canonicalReadyDeclarations[0])?.statement
      : undefined,
    canonicalResultDeclarations.length === 1
      ? statementListLocation(canonicalResultDeclarations[0])?.statement
      : undefined,
  ];
  const actualRuntimeStatements = canonicalRuntimeStatements.map((canonicalStatement) => {
    if (!canonicalStatement) return undefined;
    const matches = [];
    visitNode(target, (statement) => {
      if (
        enclosingFunctionNode(statement) === target &&
        astFingerprint(statement, sourceFile) === astFingerprint(canonicalStatement, canonicalFile)
      ) {
        matches.push(statement);
      }
    });
    return matches.length === 1 ? matches[0] : undefined;
  });
  const uniqueMatchingTargetStatement = (canonicalStatement) => {
    if (!canonicalStatement) return undefined;
    const matches = [];
    visitNode(target, (statement) => {
      if (
        enclosingFunctionNode(statement) === target &&
        astFingerprint(statement, sourceFile) === astFingerprint(canonicalStatement, canonicalFile)
      ) {
        matches.push(statement);
      }
    });
    return matches.length === 1 ? matches[0] : undefined;
  };
  const canonicalControllerDeclaration = directVariableDeclarations(
    canonicalTarget.body,
    "controller",
  )[0];
  const canonicalProofDeclaration = directVariableDeclarations(canonicalTarget.body, "proof")[0];
  const canonicalControllerDeclarationStatement = canonicalControllerDeclaration
    ? statementListLocation(canonicalControllerDeclaration)?.statement
    : undefined;
  const canonicalProofDeclarationStatement = canonicalProofDeclaration
    ? statementListLocation(canonicalProofDeclaration)?.statement
    : undefined;
  const controllerDeclarationStatement = uniqueMatchingTargetStatement(
    canonicalControllerDeclarationStatement,
  );
  const proofDeclarationStatement = uniqueMatchingTargetStatement(
    canonicalProofDeclarationStatement,
  );
  const declarationLexicallyOwnsReferences = (declarationStatement, name) => {
    if (!declarationStatement?.parent) return false;
    const declarationBindings = namedBindingNodes(declarationStatement, name);
    if (declarationBindings.length !== 1) return false;
    const declarationBinding = declarationBindings[0];
    const declarationScope = declarationStatement.parent;
    const identifiers = [];
    visitNode(target, (node) => {
      if (ts.isIdentifier(node) && node.text === name) identifiers.push(node);
    });
    return identifiers.every(
      (identifier) =>
        identifier === declarationBinding ||
        (identifier.getStart(sourceFile) > declarationStatement.getEnd() &&
          nodeIsWithin(identifier, declarationScope)),
    );
  };
  const targetFunctionBindingNodes = (name) =>
    namedBindingNodes(target, name).filter((binding) => enclosingFunctionNode(binding) === target);
  const targetFunctionMutationNodes = (name) =>
    identifierMutationNodes(target, name).filter(
      (mutation) => enclosingFunctionNode(mutation) === target,
    );
  const runtimeBindingsExact =
    ["controller", "ready", "result", "proof"].every(
      (name) => targetFunctionBindingNodes(name).length === 1,
    ) &&
    targetFunctionMutationNodes("controller").length === 1 &&
    targetFunctionMutationNodes("proof").length === 1 &&
    targetFunctionMutationNodes("ready").length === 0 &&
    targetFunctionMutationNodes("result").length === 0 &&
    declarationLexicallyOwnsReferences(controllerDeclarationStatement, "controller") &&
    declarationLexicallyOwnsReferences(proofDeclarationStatement, "proof");
  const controllerContainer = actualRuntimeStatements[0]?.parent;
  const readyContainer = actualRuntimeStatements[1]?.parent;
  const resultContainer = actualRuntimeStatements[2]?.parent;
  const controllerLocation = actualRuntimeStatements[0]
    ? statementListLocation(actualRuntimeStatements[0])
    : undefined;
  const readyLocation = actualRuntimeStatements[1]
    ? statementListLocation(actualRuntimeStatements[1])
    : undefined;
  const resultLocation = actualRuntimeStatements[2]
    ? statementListLocation(actualRuntimeStatements[2])
    : undefined;
  const nestedControllerTry =
    controllerContainer &&
    ts.isBlock(controllerContainer) &&
    ts.isTryStatement(controllerContainer.parent) &&
    controllerContainer.parent.tryBlock === controllerContainer
      ? controllerContainer.parent
      : undefined;
  const nestedOuterTry =
    readyContainer &&
    ts.isBlock(readyContainer) &&
    ts.isTryStatement(readyContainer.parent) &&
    readyContainer.parent.tryBlock === readyContainer
      ? readyContainer.parent
      : undefined;
  const nestedControllerCatch = nestedControllerTry?.catchClause;
  const nestedControllerCatchBinding = nestedControllerCatch?.variableDeclaration?.name;
  const nestedControllerCatchStatements = nestedControllerCatch?.block.statements ?? [];
  const nestedControllerTryLocation = nestedControllerTry
    ? statementListLocation(nestedControllerTry)
    : undefined;
  const canonicalControllerContainer = canonicalRuntimeStatements[0]?.parent;
  const canonicalNestedControllerTry =
    canonicalControllerContainer &&
    ts.isBlock(canonicalControllerContainer) &&
    ts.isTryStatement(canonicalControllerContainer.parent) &&
    canonicalControllerContainer.parent.tryBlock === canonicalControllerContainer
      ? canonicalControllerContainer.parent
      : undefined;
  const canonicalNestedControllerCatch = canonicalNestedControllerTry?.catchClause;
  const canonicalNestedControllerCatchStatements =
    canonicalNestedControllerCatch?.block.statements ?? [];
  const nestedControllerRethrow = nestedControllerCatchStatements[1];
  const nestedControllerTryExact = Boolean(
    nestedControllerTry &&
      canonicalNestedControllerTry &&
      nestedControllerTry.tryBlock.statements.length === 2 &&
      canonicalNestedControllerTry.tryBlock.statements.length === 2 &&
      nestedControllerTry.tryBlock.statements[0] === actualRuntimeStatements[0] &&
      astFingerprint(nestedControllerTry.tryBlock.statements[1], sourceFile) ===
        astFingerprint(canonicalNestedControllerTry.tryBlock.statements[1], canonicalFile) &&
      nestedControllerCatch &&
      !nestedControllerTry.finallyBlock &&
      nestedControllerCatchBinding &&
      ts.isIdentifier(nestedControllerCatchBinding) &&
      nestedControllerCatchBinding.text === "error" &&
      canonicalNestedControllerCatch &&
      nestedControllerCatchStatements.length === 2 &&
      canonicalNestedControllerCatchStatements.length === 2 &&
      astFingerprint(nestedControllerCatchStatements[0], sourceFile) ===
        astFingerprint(canonicalNestedControllerCatchStatements[0], canonicalFile) &&
      ts.isThrowStatement(nestedControllerRethrow) &&
      ts.isIdentifier(nestedControllerRethrow.expression) &&
      nestedControllerRethrow.expression.text === nestedControllerCatchBinding.text,
  );
  const nestedRuntimeContainer = Boolean(
    nestedControllerTry &&
      nestedOuterTry &&
      nestedControllerTryExact &&
      nestedControllerTryLocation &&
      readyLocation &&
      resultLocation &&
      readyContainer === resultContainer &&
      nestedControllerTry.parent === readyContainer &&
      nestedOuterTry.parent === target.body &&
      nestedControllerTryLocation.statements === readyLocation.statements &&
      readyLocation.statements === resultLocation.statements &&
      nestedControllerTryLocation.index + 1 === readyLocation.index &&
      readyLocation.index < resultLocation.index,
  );
  const runtimeContainerExact = nestedRuntimeContainer;
  const sanitizerAuthorityExact =
    staticAuthorityAcquisitions.exact &&
    !hasStaticEvaluatorModuleAcquisition(sourceFile) &&
    capabilityAliasEscapeNodes(
      sourceFile,
      sourceFile,
      evaluatorCapabilityPathValues(),
      evaluatorCapabilityPathValues(),
    ).length === 0 &&
    !hasAuthorityMutation(sourceFile, "assert") &&
    !containsLocalBinding(target, "assert") &&
    hasExactDefaultImport(sourceFile, "node:assert/strict", "assert") &&
    ["Array", "Object", "RegExp", "Set", "String"].every(
      (name) =>
        sourceLevelBindingNodes(sourceFile, name).length === 0 &&
        namedBindingNodes(sourceFile, name).length === 0 &&
        !hasAuthorityMutation(sourceFile, name),
    ) &&
    authorityAliasEscapeNodes(
      sourceFile,
      sourceFile,
      new Set(["Array", "Object", "RegExp", "Set", "String", "assert"]),
    ).length === 0;
  if (
    canonicalRuntimeStatements.length !== 3 ||
    actualRuntimeStatements.some((statement) => !statement) ||
    actualRuntimeStatements.some(
      (statement, position) =>
        position > 0 &&
        statement.getStart(sourceFile) <=
          actualRuntimeStatements[position - 1].getStart(sourceFile),
    ) ||
    !runtimeContainerExact ||
    !runtimeBindingsExact ||
    !controllerAuthorityExact ||
    containsLocalBinding(target, "assert") ||
    containsLocalBinding(target, "diagnosticsExcludeTrackedValues") ||
    containsLocalBinding(target, "spawnOwnedWrapperController") ||
    containsLocalBinding(target, "waitForFile")
  ) {
    diagnostics.push(`${label}:1:sanitizer-runtime-subject-provenance`);
  }
  if (!sanitizerAuthorityExact) {
    diagnostics.push(`${label}:1:sanitizer-authority-provenance`);
  }

  const declarationsNamed = (root, name) => {
    const declarations = [];
    visitNode(root, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        declarations.push(node);
      }
    });
    return declarations;
  };
  const statementFor = (node) => statementListLocation(node)?.statement;
  const exactLocalDeclaration = (name) => {
    const actual = declarationsNamed(target, name);
    const canonical = declarationsNamed(canonicalTarget, name);
    return Boolean(
      actual.length === 1 &&
        canonical.length === 1 &&
        isConstVariableDeclaration(actual[0]) &&
        namedBindingNodes(target, name).length === 1 &&
        identifierMutationNodes(target, name).length === 0 &&
        astFingerprint(actual[0], sourceFile) === astFingerprint(canonical[0], canonicalFile) &&
        declarationLexicallyOwnsReferences(statementFor(actual[0]), name),
    );
  };
  const actualWaitForFile = uniqueTopLevelFunctionDeclaration(sourceFile, "waitForFile");
  const canonicalWaitForFile = uniqueTopLevelFunctionDeclaration(canonicalFile, "waitForFile");
  const waitForFileAuthorityExact = Boolean(
    actualWaitForFile &&
      canonicalWaitForFile &&
      sourceLevelBindingNodes(sourceFile, "waitForFile").length === 1 &&
      !hasAuthorityMutation(sourceFile, "waitForFile") &&
      !containsLocalBinding(target, "waitForFile") &&
      astFingerprint(actualWaitForFile, sourceFile) ===
        astFingerprint(canonicalWaitForFile, canonicalFile),
  );
  const actualWaitForPath = uniqueTopLevelFunctionDeclaration(sourceFile, "waitForPath");
  const canonicalWaitForPath = uniqueTopLevelFunctionDeclaration(canonicalFile, "waitForPath");
  const waitForPathAuthorityExact = Boolean(
    actualWaitForPath &&
      canonicalWaitForPath &&
      sourceLevelBindingNodes(sourceFile, "waitForPath").length === 1 &&
      !hasAuthorityMutation(sourceFile, "waitForPath") &&
      !containsLocalBinding(target, "waitForPath") &&
      astFingerprint(actualWaitForPath, sourceFile) ===
        astFingerprint(canonicalWaitForPath, canonicalFile),
  );
  const setupNames = ["readyPath", "harnessTermMarker", "playwrightPackage", "source"];
  const setupLocations = setupNames.map((name) => {
    const declaration = declarationsNamed(target, name);
    return declaration.length === 1
      ? statementListLocation(statementFor(declaration[0]))
      : undefined;
  });
  const canonicalControllerTryStatement = canonicalRuntimeStatements[0]
    ? statementListLocation(canonicalRuntimeStatements[0])?.statement?.parent?.parent
    : undefined;
  const canonicalControllerTryLocation =
    canonicalControllerTryStatement && ts.isTryStatement(canonicalControllerTryStatement)
      ? statementListLocation(canonicalControllerTryStatement)
      : undefined;
  const controllerAttemptStatement = nestedControllerTryLocation
    ? nestedControllerTryLocation.statements[nestedControllerTryLocation.index - 1]
    : undefined;
  const canonicalControllerAttemptStatement = canonicalControllerTryLocation
    ? canonicalControllerTryLocation.statements[canonicalControllerTryLocation.index - 1]
    : undefined;
  const controllerAttemptExact = Boolean(
    controllerAttemptStatement &&
      canonicalControllerAttemptStatement &&
      astFingerprint(controllerAttemptStatement, sourceFile) ===
        astFingerprint(canonicalControllerAttemptStatement, canonicalFile),
  );
  const setupPlacementExact = Boolean(
    nestedOuterTry &&
      nestedControllerTryLocation &&
      setupLocations.every(
        (location) => location && location.statements === nestedOuterTry.tryBlock.statements,
      ) &&
      setupLocations.every(
        (location, index) => index === 0 || setupLocations[index - 1].index + 1 === location.index,
      ) &&
      controllerAttemptExact &&
      setupLocations.at(-1).index + 2 === nestedControllerTryLocation.index,
  );
  if (
    !setupNames.every(exactLocalDeclaration) ||
    !setupPlacementExact ||
    !exactMalformedProgramSourceDeclaration(target, sourceFile) ||
    !waitForFileAuthorityExact ||
    !waitForPathAuthorityExact
  ) {
    diagnostics.push(`${label}:1:sanitizer-runtime-subject-provenance`);
  }
  const trackedDeclarations = declarationsNamed(target, "trackedValues");
  const canonicalTracked = declarationsNamed(canonicalTarget, "trackedValues")[0];
  const tracked = trackedDeclarations.length === 1 ? trackedDeclarations[0] : undefined;
  const trackedStatement = tracked ? statementFor(tracked) : undefined;
  const canonicalTrackedStatement = canonicalTracked ? statementFor(canonicalTracked) : undefined;
  const trackedLocation = trackedStatement ? statementListLocation(trackedStatement) : undefined;
  const canonicalTrackedLocation = canonicalTrackedStatement
    ? statementListLocation(canonicalTrackedStatement)
    : undefined;
  const actualEvidenceStatements =
    trackedLocation?.statements.slice(trackedLocation.index, trackedLocation.index + 5) ?? [];
  const canonicalEvidenceStatements =
    canonicalTrackedLocation?.statements.slice(
      canonicalTrackedLocation.index,
      canonicalTrackedLocation.index + 5,
    ) ?? [];
  const exactEvidenceStatement = (index) =>
    Boolean(
      actualEvidenceStatements[index] &&
        canonicalEvidenceStatements[index] &&
        astFingerprint(actualEvidenceStatements[index], sourceFile) ===
          astFingerprint(canonicalEvidenceStatements[index], canonicalFile),
    );
  const canonicalReadyLocation = canonicalRuntimeStatements[1]
    ? statementListLocation(canonicalRuntimeStatements[1])
    : undefined;
  const runtimeEnvelope =
    readyLocation && trackedLocation
      ? readyLocation.statements.slice(readyLocation.index, trackedLocation.index + 5)
      : [];
  const canonicalRuntimeEnvelope =
    canonicalReadyLocation && canonicalTrackedLocation
      ? canonicalReadyLocation.statements.slice(
          canonicalReadyLocation.index,
          canonicalTrackedLocation.index + 5,
        )
      : [];
  const runtimeEnvelopeExact = Boolean(
    runtimeEnvelope.length > 0 &&
      runtimeEnvelope.length === canonicalRuntimeEnvelope.length &&
      runtimeEnvelope.every(
        (statement, index) =>
          astFingerprint(statement, sourceFile) ===
          astFingerprint(canonicalRuntimeEnvelope[index], canonicalFile),
      ),
  );
  const evidenceScopeAndDominanceExact = Boolean(
    readyLocation &&
      resultLocation &&
      trackedLocation &&
      readyLocation.statements === resultLocation.statements &&
      resultLocation.statements === trackedLocation.statements &&
      readyLocation.index < resultLocation.index &&
      resultLocation.index < trackedLocation.index &&
      runtimeEnvelopeExact &&
      actualEvidenceStatements.length === 5 &&
      actualEvidenceStatements.every(
        (statement, index) =>
          trackedLocation.statements[trackedLocation.index + index] === statement &&
          statement.parent === trackedStatement?.parent,
      ),
  );

  if (!evidenceScopeAndDominanceExact) {
    diagnostics.push(`${label}:1:sanitizer-runtime-subject-provenance`);
  }

  if (
    !tracked ||
    !trackedStatement ||
    !canonicalTrackedStatement ||
    !isConstVariableDeclaration(tracked) ||
    !exactEvidenceStatement(0) ||
    hasIdentifierReassignment(target, "trackedValues")
  ) {
    diagnostics.push(`${label}:1:sanitizer-five-value-set-missing`);
  }
  if (!exactEvidenceStatement(1)) {
    diagnostics.push(`${label}:1:sanitizer-exclusion-missing`);
  }
  if (!exactEvidenceStatement(2) || !exactEvidenceStatement(3)) {
    diagnostics.push(`${label}:1:sanitizer-diagnostic-predicates-missing`);
  }
  const sanitizerProofStatementExact = (() => {
    const statement = actualEvidenceStatements[4];
    if (!ts.isExpressionStatement(statement)) return false;
    const assignment = unparenthesizedExpression(statement.expression);
    if (
      !ts.isBinaryExpression(assignment) ||
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(unparenthesizedExpression(assignment.left)) ||
      unparenthesizedExpression(assignment.left).text !== "proof"
    ) {
      return false;
    }
    const value = unparenthesizedExpression(assignment.right);
    if (!ts.isObjectLiteralExpression(value)) return false;
    let diagnosticsProperties = 0;
    let trackedValueProperties = 0;
    for (const property of value.properties) {
      if (
        ts.isSpreadAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        return false;
      }
      const name = property.name
        ? propertyNameStaticValue(property.name, sourceFile)
        : ts.isShorthandPropertyAssignment(property)
          ? property.name.text
          : undefined;
      if (!name) return false;
      if (name === "diagnostics") {
        diagnosticsProperties += 1;
        if (
          !ts.isPropertyAssignment(property) ||
          !directResultMember(property.initializer, sourceFile, "stderr")
        ) {
          return false;
        }
      }
      if (name === "trackedValues") {
        trackedValueProperties += 1;
        const trackedInitializer = ts.isShorthandPropertyAssignment(property)
          ? property.name
          : ts.isPropertyAssignment(property)
            ? unparenthesizedExpression(property.initializer)
            : undefined;
        if (!ts.isIdentifier(trackedInitializer) || trackedInitializer.text !== "trackedValues") {
          return false;
        }
      }
    }
    return diagnosticsProperties === 1 && trackedValueProperties === 1;
  })();
  if (!sanitizerProofStatementExact) {
    diagnostics.push(`${label}:1:sanitizer-proof-missing`);
  }

  const resultDeclarations = declarationsNamed(target, "result");
  const canonicalResult = declarationsNamed(canonicalTarget, "result")[0];
  const resultDeclaration = resultDeclarations.length === 1 ? resultDeclarations[0] : undefined;
  if (
    !resultDeclaration ||
    !canonicalResult ||
    !isConstVariableDeclaration(resultDeclaration) ||
    astFingerprint(resultDeclaration, sourceFile) !==
      astFingerprint(canonicalResult, canonicalFile) ||
    hasIdentifierReassignment(target, "result")
  ) {
    diagnostics.push(`${label}:1:sanitizer-runtime-subject-provenance`);
  }

  const exclusionStatement = exactEvidenceStatement(1) ? actualEvidenceStatements[1] : undefined;
  const permittedRawStatements = new Set(
    [1, 2, 4]
      .filter((index) =>
        index === 4 ? sanitizerProofStatementExact : exactEvidenceStatement(index),
      )
      .map((index) => actualEvidenceStatements[index]),
  );
  let firstRawUse;
  let firstRawBeforeExclusion;
  let firstWholeResultEscape;
  const resultIdentifierFor = (node) => {
    const expression = unparenthesizedExpression(node);
    if (ts.isIdentifier(expression) && expression.text === "result") return expression;
    if (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      ts.isIdentifier(unparenthesizedExpression(expression.expression)) &&
      unparenthesizedExpression(expression.expression).text === "result"
    ) {
      return unparenthesizedExpression(expression.expression);
    }
    return undefined;
  };
  const nestedParameterShadowsRuntimeResult = (node) => {
    const identifier = resultIdentifierFor(node);
    if (!identifier) return false;
    for (let current = identifier.parent; current && current !== target; current = current.parent) {
      if (
        (ts.isArrowFunction(current) ||
          ts.isFunctionExpression(current) ||
          ts.isFunctionDeclaration(current) ||
          ts.isMethodDeclaration(current)) &&
        current.parameters.some(
          (parameter) => bindingNameNodes(parameter.name, "result").length > 0,
        )
      ) {
        return true;
      }
    }
    return false;
  };
  visitNode(target, (node) => {
    if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text)) {
      firstWholeResultEscape ??= node;
    }
    if (nestedParameterShadowsRuntimeResult(node)) return;
    if (directResultMember(node, sourceFile, "stderr")) {
      const statement = statementFor(node);
      if (!permittedRawStatements.has(statement)) firstRawUse ??= node;
      if (
        !exclusionStatement ||
        node.getStart(sourceFile) < exclusionStatement.getStart(sourceFile)
      ) {
        firstRawBeforeExclusion ??= node;
      }
    }
    if (!ts.isIdentifier(node) || node.text !== "result") return;
    if (node === resultDeclaration?.name) return;
    const parent = unparenthesizedExpression(node.parent);
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      unparenthesizedExpression(parent.expression) === node &&
      ["code", "signal", "stderr"].includes(
        ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : resolvedStaticStringValue(parent.argumentExpression, sourceFile),
      )
    ) {
      return;
    }
    firstWholeResultEscape ??= node;
  });
  if (firstRawBeforeExclusion) {
    diagnostics.push(
      `${label}:${sourceLine(sourceFile, firstRawBeforeExclusion)}:diagnostics-before-exclusion`,
    );
  }
  if (firstRawUse || firstWholeResultEscape) {
    const node = firstRawUse ?? firstWholeResultEscape;
    diagnostics.push(`${label}:${sourceLine(sourceFile, node)}:raw-diagnostics-use`);
  }

  const canonicalReturn = canonicalTarget.body.statements.find(
    (statement) =>
      ts.isReturnStatement(statement) &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === "proof",
  );
  const actualReturns = [];
  visitNode(target.body, (node) => {
    if (ts.isReturnStatement(node) && enclosingFunctionNode(node) === target) {
      actualReturns.push(node);
    }
  });
  const proofAssignmentLocation = sanitizerProofStatementExact
    ? statementListLocation(actualEvidenceStatements[4])
    : undefined;
  const proofReturnLocation =
    actualReturns.length === 1 ? statementListLocation(actualReturns[0]) : undefined;
  const targetOuterTryStatements = target.body.statements.filter(ts.isTryStatement);
  const canonicalOuterTryStatements = canonicalTarget.body.statements.filter(ts.isTryStatement);
  const targetOuterTry =
    targetOuterTryStatements.length === 1 ? targetOuterTryStatements[0] : undefined;
  const canonicalOuterTry =
    canonicalOuterTryStatements.length === 1 ? canonicalOuterTryStatements[0] : undefined;
  const samePostCleanupTail = Boolean(
    targetOuterTry &&
      canonicalOuterTry &&
      target.body.statements.slice(target.body.statements.indexOf(targetOuterTry) + 1).length ===
        canonicalTarget.body.statements.slice(
          canonicalTarget.body.statements.indexOf(canonicalOuterTry) + 1,
        ).length &&
      target.body.statements
        .slice(target.body.statements.indexOf(targetOuterTry) + 1)
        .every(
          (statement, index) =>
            astFingerprint(statement, sourceFile) ===
            astFingerprint(
              canonicalTarget.body.statements.slice(
                canonicalTarget.body.statements.indexOf(canonicalOuterTry) + 1,
              )[index],
              canonicalFile,
            ),
        ),
  );
  const proofReturnAfterCleanup = Boolean(
    proofAssignmentLocation &&
      proofReturnLocation &&
      targetOuterTry &&
      proofAssignmentLocation.statements === targetOuterTry.tryBlock.statements &&
      proofAssignmentLocation.index === proofAssignmentLocation.statements.length - 1 &&
      proofReturnLocation.statements === target.body.statements &&
      proofReturnLocation.index === target.body.statements.length - 1 &&
      samePostCleanupTail,
  );
  if (
    !canonicalReturn ||
    actualReturns.length !== 1 ||
    astFingerprint(actualReturns[0], sourceFile) !==
      astFingerprint(canonicalReturn, canonicalFile) ||
    !proofReturnAfterCleanup
  ) {
    diagnostics.push(`${label}:1:sanitizer-proof-return-invalid`);
  }

  const mutationTitle =
    "Red F proves actual diagnostics sanitize every tracked value with mutation sensitivity";
  const mutationRegistration = directNamedTestRegistration(
    sourceFile,
    mutationTitle,
    "HR browser harness contracts",
  );
  const canonicalMutationRegistration = directNamedTestRegistration(
    canonicalFile,
    mutationTitle,
    "HR browser harness contracts",
  );
  const mutationCallback = mutationRegistration?.arguments[2];
  const canonicalMutationCallback = canonicalMutationRegistration?.arguments[2];
  const mutationOptions = mutationRegistration?.arguments[1];
  const canonicalMutationOptions = canonicalMutationRegistration?.arguments[1];
  const timeoutProperty =
    mutationRegistration && ts.isObjectLiteralExpression(mutationRegistration.arguments[1])
      ? mutationRegistration.arguments[1].properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            propertyNameStaticValue(property.name) === "timeout",
        )
      : undefined;
  if (
    !mutationRegistration ||
    !canonicalMutationRegistration ||
    !mutationCallback ||
    !canonicalMutationCallback ||
    !isAsyncFunctionLike(mutationCallback) ||
    !mutationOptions ||
    !canonicalMutationOptions ||
    astFingerprint(mutationOptions, sourceFile) !==
      astFingerprint(canonicalMutationOptions, canonicalFile) ||
    !timeoutProperty ||
    numericLiteralValue(timeoutProperty.initializer) !== 150_000 ||
    astFingerprint(mutationCallback, sourceFile) !==
      astFingerprint(canonicalMutationCallback, canonicalFile) ||
    !hasClosedUnaliasedNamedImportSet(sourceFile, "node:test", ["describe", "it"])
  ) {
    diagnostics.push(`${label}:1:sanitizer-five-value-mutation-missing`);
  }

  return [...new Set(diagnostics)];
}

function normalizedBoundedFinishEnvelope(envelope) {
  const exactDataDescriptor = (descriptor, value, enumerable) =>
    Boolean(
      descriptor &&
        Object.hasOwn(descriptor, "value") &&
        !Object.hasOwn(descriptor, "get") &&
        !Object.hasOwn(descriptor, "set") &&
        descriptor.configurable === true &&
        descriptor.enumerable === enumerable &&
        descriptor.writable === true &&
        descriptor.value === value,
    );
  try {
    if (!envelope || typeof envelope !== "object" || isProxy(envelope)) return undefined;
    if (
      Object.getPrototypeOf(envelope) !== Object.prototype ||
      Object.getOwnPropertySymbols(envelope).length !== 0
    ) {
      return undefined;
    }
    const envelopeOwnNames = Object.getOwnPropertyNames(envelope).sort();
    const kindDescriptor = Object.getOwnPropertyDescriptor(envelope, "kind");
    if (!kindDescriptor || !Object.hasOwn(kindDescriptor, "value")) return undefined;
    const kind = kindDescriptor.value;
    if (!exactDataDescriptor(kindDescriptor, kind, true)) return undefined;
    if (kind === "fulfilled") {
      if (
        envelopeOwnNames.length !== 2 ||
        envelopeOwnNames[0] !== "kind" ||
        envelopeOwnNames[1] !== "value"
      ) {
        return undefined;
      }
      const valueDescriptor = Object.getOwnPropertyDescriptor(envelope, "value");
      if (!valueDescriptor || !Object.hasOwn(valueDescriptor, "value")) return undefined;
      const value = valueDescriptor.value;
      if (
        !exactDataDescriptor(valueDescriptor, value, true) ||
        !value ||
        typeof value !== "object" ||
        isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        return undefined;
      }
      const valueNames = Object.getOwnPropertyNames(value).sort();
      if (
        valueNames.length !== 2 ||
        valueNames[0] !== "code" ||
        valueNames[1] !== "signal" ||
        !exactDataDescriptor(Object.getOwnPropertyDescriptor(value, "code"), 1, true) ||
        !exactDataDescriptor(Object.getOwnPropertyDescriptor(value, "signal"), null, true)
      ) {
        return undefined;
      }
      return { kind: "fulfilled", value: { code: 1, signal: null } };
    }
    if (kind === "rejected") {
      if (
        envelopeOwnNames.length !== 2 ||
        envelopeOwnNames[0] !== "error" ||
        envelopeOwnNames[1] !== "kind"
      ) {
        return undefined;
      }
      const errorDescriptor = Object.getOwnPropertyDescriptor(envelope, "error");
      if (!errorDescriptor || !Object.hasOwn(errorDescriptor, "value")) return undefined;
      const error = errorDescriptor.value;
      if (
        !exactDataDescriptor(errorDescriptor, error, true) ||
        !error ||
        typeof error !== "object" ||
        isProxy(error) ||
        Object.getPrototypeOf(error) !== Error.prototype ||
        Object.getOwnPropertySymbols(error).length !== 0
      ) {
        return undefined;
      }
      const errorNames = Object.getOwnPropertyNames(error).sort();
      if (
        errorNames.length !== 3 ||
        errorNames[0] !== "code" ||
        errorNames[1] !== "message" ||
        errorNames[2] !== "stack" ||
        !exactDataDescriptor(
          Object.getOwnPropertyDescriptor(error, "code"),
          "ERR_WRAPPER_CLOSE_DEADLINE",
          true,
        ) ||
        !exactDataDescriptor(
          Object.getOwnPropertyDescriptor(error, "message"),
          "wrapper close deadline exceeded",
          false,
        ) ||
        !exactDataDescriptor(
          Object.getOwnPropertyDescriptor(error, "stack"),
          "Error: wrapper close deadline exceeded",
          false,
        )
      ) {
        return undefined;
      }
      return {
        error: {
          code: "ERR_WRAPPER_CLOSE_DEADLINE",
          message: "wrapper close deadline exceeded",
          stack: "Error: wrapper close deadline exceeded",
        },
        kind: "rejected",
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isValidBoundedFinishEnvelope(envelope) {
  return normalizedBoundedFinishEnvelope(envelope) !== undefined;
}

function exactFilesystemIdentity(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}

function sameFilesystemIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function readProcessGroupMembers(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error("Process-group membership subject is invalid");
  }
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Process-group membership scan failed");
  }
  const lines = result.stdout.trim() ? result.stdout.trim().split("\n") : [];
  const members = lines.map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error("Process-group membership scan was ambiguous");
    const pid = Number(match[1]);
    const observedPgid = Number(match[2]);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(observedPgid) ||
      observedPgid <= 0
    ) {
      throw new Error("Process-group membership scan contained invalid identities");
    }
    return { pgid: observedPgid, pid };
  });
  return members.filter((member) => member.pgid === pgid);
}

function readProcessIdentity(pid, timeoutMs = 1_000) {
  const result = spawnSync(
    "/bin/ps",
    ["-ww", "-o", "pid=,ppid=,pgid=,sess=,uid=,lstart=,command=", "-p", String(pid)],
    { encoding: "utf8", timeout: timeoutMs },
  );
  if (result.error) throw new Error(`Unable to inspect process ${pid}: ${result.error.message}`);
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length < 11) throw new Error(`Process ${pid} identity is ambiguous`);
  const numeric = parts.slice(0, 5).map((part) => Number(part));
  if (numeric.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Process ${pid} identity has invalid numeric fields`);
  }
  const start = parts.slice(5, 10).join(" ");
  if (!Number.isFinite(Date.parse(start))) throw new Error(`Process ${pid} start is ambiguous`);
  return {
    command: parts.slice(10).join(" "),
    pgid: numeric[2],
    pid: numeric[0],
    ppid: numeric[1],
    session: numeric[3],
    start,
    uid: numeric[4],
  };
}

function sameProcessIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.pid === right.pid &&
      left.ppid === right.ppid &&
      left.pgid === right.pgid &&
      left.session === right.session &&
      left.uid === right.uid &&
      left.start === right.start &&
      left.command === right.command,
  );
}

function readSemanticSessionObservation(expectedIdentity) {
  const before = readProcessIdentity(expectedIdentity.pid, 1_000);
  assert.ok(
    sameProcessIdentity(expectedIdentity, before),
    "session observation subject changed before state read",
  );
  const result = spawnSync(
    "/bin/ps",
    ["-ww", "-o", "pid=,state=", "-p", String(expectedIdentity.pid)],
    { encoding: "utf8", timeout: 1_000 },
  );
  assert.equal(result.error, undefined, "session state observation failed");
  assert.equal(result.status, 0, "session state observation was not successful");
  const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(result.stdout);
  assert.ok(match, "session state observation was ambiguous");
  assert.equal(Number(match[1]), expectedIdentity.pid, "session state PID changed");
  const afterIdentity = readProcessIdentity(expectedIdentity.pid, 1_000);
  assert.ok(
    sameProcessIdentity(before, afterIdentity),
    "session observation subject changed after state read",
  );
  return {
    identity: afterIdentity,
    pid: Number(match[1]),
    platform: process.platform,
    state: match[2],
  };
}

function isSemanticSessionLeader(observation) {
  if (
    !observation ||
    observation.pid !== observation.identity?.pid ||
    typeof observation.state !== "string"
  ) {
    return false;
  }
  if (observation.platform === "darwin") return observation.state.includes("s");
  if (observation.platform === "linux") {
    return observation.identity.session === observation.identity.pid;
  }
  return false;
}

function readProcessDescriptorIdentity(pid, descriptor) {
  if (process.platform === "linux") {
    try {
      return exactFilesystemIdentity(statSync(`/proc/${pid}/fd/${descriptor}`, { bigint: true }));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync(
      "/usr/sbin/lsof",
      ["-a", "-n", "-P", "-p", String(pid), "-d", String(descriptor), "-F", "fDdit"],
      { encoding: "utf8", timeout: 1_000 },
    );
    if (result.error) throw result.error;
    if (!result.stdout.trim() && (result.status === 0 || result.status === 1)) return undefined;
    if (result.status !== 0) throw new Error("Darwin descriptor identity is ambiguous");
    const [processLine, ...lines] = result.stdout.trim().split("\n");
    if (processLine !== `p${pid}` || lines.some((line) => !/^[fDdit].+$/.test(line))) {
      throw new Error("Darwin descriptor metadata is ambiguous");
    }
    const entries = lines.map((line) => [line[0], line.slice(1)]);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error("Darwin descriptor metadata is ambiguous");
    }
    const fields = new Map(entries);
    if (fields.get("f") !== String(descriptor)) {
      throw new Error("Darwin descriptor metadata is ambiguous");
    }
    if (
      lines.length === 4 &&
      fields.size === 4 &&
      fields.get("t") === "REG" &&
      /^0x[0-9a-f]+$/i.test(fields.get("D") ?? "") &&
      /^[0-9]+$/.test(fields.get("i") ?? "")
    ) {
      return {
        dev: BigInt(fields.get("D")).toString(),
        ino: BigInt(fields.get("i")).toString(),
      };
    }
    if (
      lines.length === 3 &&
      fields.size === 3 &&
      fields.get("t") === "unix" &&
      /^0x[0-9a-f]+$/i.test(fields.get("d") ?? "")
    ) {
      return { dev: `unix:${fields.get("d").toLowerCase()}`, ino: "socket" };
    }
    throw new Error("Darwin descriptor metadata is ambiguous");
  }
  throw new Error("Stable descriptor identity is unsupported on this platform");
}

function captureStableProcessIdentity(pid, expected) {
  const first = readProcessIdentity(pid);
  const second = readProcessIdentity(pid);
  assert.ok(first && second, `process ${pid} was not live`);
  assert.ok(sameProcessIdentity(first, second), `process ${pid} identity was unstable`);
  if (expected) assert.ok(sameProcessIdentity(expected, first), `process ${pid} identity changed`);
  return first;
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPath(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`${path} was not created within ${timeoutMs}ms`);
}

async function assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots) {
  assert.deepEqual(await postgresTemporaryDirectories(), beforePostgresRoots);
  assert.deepEqual(await browserTemporaryDirectories(), beforeBrowserRoots);
  const processes = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (processes.error || processes.status !== 0) {
    throw new Error("Unable to inspect owned-process residue", { cause: processes.error });
  }
  const matches = processes.stdout
    .split("\n")
    .filter((line) => line.includes(wrapperTemporaryRoot));
  assert.deepEqual(matches, [], "owned process command still referenced the suite root");
}

async function listenOnEphemeralPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve test port");
  return { port: address.port, server };
}

async function postgresTemporaryDirectories() {
  return new Set(
    (await readdir(wrapperTemporaryRoot)).filter((name) => name.startsWith("esbla-postgres-")),
  );
}

async function browserTemporaryDirectories() {
  return new Set(
    (await readdir(wrapperTemporaryRoot)).filter(
      (name) =>
        name.startsWith("esbla-browser-control-") || name.startsWith("esbla-browser-profile-"),
    ),
  );
}

function spawnPostgresWrapper(command, args = []) {
  return spawnOwnedWrapperController(command, args, {}, { superviseBrowser: false });
}

function spawnSupervisedPostgresWrapper(command, args = [], environment = {}) {
  return spawnOwnedWrapperController(command, args, environment, { superviseBrowser: true });
}

function openOwnershipDescriptor() {
  const tokenPath = join(wrapperTemporaryRoot, `.wrapper-ownership-${process.pid}-${randomUUID()}`);
  let ownershipFd;
  try {
    ownershipFd = openSync(tokenPath, "wx+", 0o600);
    openWrapperOwnershipDescriptors.add(ownershipFd);
    const identity = exactFilesystemIdentity(fstatSync(ownershipFd, { bigint: true }));
    unlinkSync(tokenPath);
    return { fd: ownershipFd, identity };
  } catch (error) {
    const failures = [error];
    if (ownershipFd !== undefined) {
      try {
        closeSync(ownershipFd);
        openWrapperOwnershipDescriptors.delete(ownershipFd);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        unlinkSync(tokenPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") failures.push(cleanupError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "wrapper ownership setup failed");
    }
    throw error;
  }
}

function spawnOwnedChild(command, args, environment, ownershipFd, superviseBrowser) {
  return spawn(
    process.execPath,
    [withPostgres, ...(superviseBrowser ? ["--supervise-browser"] : []), command, ...args],
    {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment, TMPDIR: wrapperTemporaryRoot },
      stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", ownershipFd],
    },
  );
}

function createWrapperCloseDeadlineError() {
  const error = new Error("wrapper close deadline exceeded");
  error.code = "ERR_WRAPPER_CLOSE_DEADLINE";
  Object.defineProperty(error, "stack", {
    configurable: true,
    enumerable: false,
    value: "Error: wrapper close deadline exceeded",
    writable: true,
  });
  return error;
}

async function settleControllerBefore(closeOutcome, deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  let timer;
  try {
    return await Promise.race([
      closeOutcome,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createWrapperCloseDeadlineError()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function retainExactWrapperIdentity(
  childPid,
  parentPid,
  ownershipIdentity,
  first,
  second,
  descriptorIdentity,
) {
  if (!first || !second || !descriptorIdentity) return undefined;
  if (first.pid !== childPid || first.ppid !== parentPid) return undefined;
  if (!sameProcessIdentity(first, second)) return undefined;
  if (!sameFilesystemIdentity(descriptorIdentity, ownershipIdentity)) return undefined;
  return first;
}

function spawnOwnedWrapperController(
  command,
  args = [],
  environment = {},
  { operationTimeoutMs = 35_000, superviseBrowser = true } = {},
) {
  const startedAt = Date.now();
  const absoluteControllerDeadline = startedAt + operationTimeoutMs + 38_000;
  let acquisitionState = "not-attempted";
  let ownershipFd;
  let ownershipIdentity;
  let ownershipTracked = false;
  let exitObserved = false;
  let closeObserved = false;
  let closeObserverBound = false;
  let finalized = false;
  let finalizationError;
  let finishAttempt;
  let identityRecorded = false;
  let retainedIdentity;
  let retentionRounds = 0;
  let setupFailure;
  let setupTerminationRequested = false;
  let child;
  let stderr = "";
  let processError;
  let stdout = "";
  let resolveCloseOutcome;
  const controllerErrors = [];
  const closeOutcome = new Promise((resolveClose) => {
    resolveCloseOutcome = resolveClose;
  });
  const controller = {
    controllerErrors,
    get exitCode() {
      return child?.exitCode ?? null;
    },
    get hardKillUsed() {
      return false;
    },
    ownedWrapperController: true,
    outcome: closeOutcome,
    get phase() {
      return acquisitionState;
    },
    get pid() {
      return child?.pid;
    },
    get rescueUsed() {
      return false;
    },
    get signalCode() {
      return child?.signalCode ?? null;
    },
    get settled() {
      return closeObserved;
    },
  };
  const publishCloseOutcome = (code, signal) => {
    if (closeObserved) return;
    closeObserved = true;
    resolveCloseOutcome({ code, error: processError, signal, stderr, stdout });
  };
  const childStdioClosed = () =>
    [child?.stdin, child?.stdout, child?.stderr].every(
      (stream) => !stream || stream.closed === true,
    );
  const refreshUnboundCloseOutcome = () => {
    if (!child || closeObserved) return;
    if ((child.exitCode !== null || child.signalCode !== null) && childStdioClosed()) {
      exitObserved = true;
      publishCloseOutcome(child.exitCode, child.signalCode);
    }
  };
  const waitForControllerCloseBefore = async (deadline) => {
    while (true) {
      refreshUnboundCloseOutcome();
      if (closeObserved) return await closeOutcome;
      if (closeObserverBound) return await settleControllerBefore(closeOutcome, deadline);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw createWrapperCloseDeadlineError();
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(25, remaining)));
    }
  };
  const retainOwnedWrapper = () => {
    while (
      retentionRounds < 3 &&
      !retainedIdentity &&
      !closeObserved &&
      Date.now() < absoluteControllerDeadline
    ) {
      refreshUnboundCloseOutcome();
      if (closeObserved || child.exitCode !== null || child.signalCode !== null) break;
      retentionRounds += 1;
      const first = readProcessIdentity(child.pid, 1_000);
      const second = readProcessIdentity(child.pid, 1_000);
      const descriptorIdentity = readProcessDescriptorIdentity(child.pid, 6);
      retainedIdentity = retainExactWrapperIdentity(
        child.pid,
        process.pid,
        ownershipIdentity,
        first,
        second,
        descriptorIdentity,
      );
      if (
        !retainedIdentity &&
        !closeObserved &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    refreshUnboundCloseOutcome();
    if (
      !retainedIdentity &&
      !closeObserved &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      throw new Error("Unable to retain owned wrapper identity");
    }
    if (retainedIdentity && !identityRecorded) {
      recordedWrapperIdentities.push(retainedIdentity);
      identityRecorded = true;
      acquisitionState = "identity-retained";
    }
    controller.identity = retainedIdentity;
    return retainedIdentity;
  };
  const verifyOwnedWrapperImmediatelyBeforeSignal = () => {
    if (exitObserved || closeObserved) throw new Error("wrapper already settled");
    const first = readProcessIdentity(child.pid, 1_000);
    const second = readProcessIdentity(child.pid, 1_000);
    const firstDescriptorIdentity = readProcessDescriptorIdentity(child.pid, 6);
    assert.ok(retainedIdentity, "wrapper identity was not retained");
    assert.ok(first && second && firstDescriptorIdentity, "wrapper is not live");
    assert.equal(child.pid, retainedIdentity.pid, "wrapper ChildProcess identity changed");
    assert.ok(sameProcessIdentity(retainedIdentity, first), "wrapper identity changed");
    assert.ok(sameProcessIdentity(first, second), "wrapper identity was unstable");
    assert.equal(first.ppid, process.pid, "wrapper is no longer the direct child");
    assert.ok(
      sameFilesystemIdentity(
        firstDescriptorIdentity,
        exactFilesystemIdentity(fstatSync(ownershipFd, { bigint: true })),
      ),
      "wrapper FD-6 ownership capability changed",
    );
    const boundary = readProcessIdentity(child.pid, 1_000);
    const boundaryDescriptorIdentity = readProcessDescriptorIdentity(child.pid, 6);
    assert.ok(boundary && boundaryDescriptorIdentity, "wrapper changed at signal boundary");
    assert.ok(sameProcessIdentity(second, boundary), "wrapper identity changed at signal boundary");
    assert.ok(
      sameFilesystemIdentity(firstDescriptorIdentity, boundaryDescriptorIdentity),
      "wrapper FD-6 capability changed at signal boundary",
    );
    return boundary;
  };
  const signal = (signalName) => {
    assert.ok(signalName === "SIGINT" || signalName === "SIGTERM", "unsupported wrapper signal");
    if (exitObserved || closeObserved) return false;
    verifyOwnedWrapperImmediatelyBeforeSignal();
    const delivered = child.kill(signalName);
    assert.equal(delivered, true, "wrapper signal was not delivered");
    return true;
  };
  const outcomeWithin = async (timeoutMs) => {
    try {
      await waitForControllerCloseBefore(
        Math.min(Date.now() + timeoutMs, absoluteControllerDeadline),
      );
      return true;
    } catch (error) {
      if (error?.code === "ERR_WRAPPER_CLOSE_DEADLINE") return false;
      throw error;
    }
  };
  const finish = (requestedTimeoutMs = Number.MAX_SAFE_INTEGER) => {
    refreshUnboundCloseOutcome();
    const requestedDeadline = Date.now() + requestedTimeoutMs;
    const finishDeadline = Math.min(requestedDeadline, absoluteControllerDeadline);
    if (finishAttempt) return finishAttempt;
    finishAttempt = (async () => {
      refreshUnboundCloseOutcome();
      if (setupFailure && !closeObserved && !setupTerminationRequested) {
        if (
          !retainedIdentity &&
          retentionRounds < 3 &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          try {
            retainOwnedWrapper();
          } catch (error) {
            controllerErrors.push(error);
          }
        }
        refreshUnboundCloseOutcome();
        if (
          retainedIdentity &&
          !closeObserved &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          try {
            setupTerminationRequested = signal("SIGTERM");
          } catch (error) {
            controllerErrors.push(error);
          }
        }
      }
      return await waitForControllerCloseBefore(finishDeadline);
    })()
      .then((result) => {
        if (!closeObserved) throw createWrapperCloseDeadlineError();
        if (!finalized) {
          const failures = [];
          if (ownershipTracked) {
            try {
              closeSync(ownershipFd);
              openWrapperOwnershipDescriptors.delete(ownershipFd);
              ownershipTracked = false;
            } catch (error) {
              failures.push(error);
            }
          }
          activeWrapperControllers.delete(controller);
          completedWrapperControllers.push(controller);
          acquisitionState = "finalized";
          finalized = true;
          if (failures.length > 0) {
            controllerErrors.push(...failures);
            finalizationError = new AggregateError(
              failures,
              "wrapper controller finalization failed",
            );
          }
        }
        if (setupFailure) {
          throw new AggregateError([...controllerErrors], "wrapper controller setup failed");
        }
        if (finalizationError) throw finalizationError;
        return result;
      })
      .catch((error) => {
        if (!finalized) {
          finishAttempt = undefined;
          if (setupFailure) {
            throw new AggregateError(
              controllerErrors.includes(error)
                ? [...controllerErrors]
                : [...controllerErrors, error],
              "wrapper controller setup recovery failed",
            );
          }
        }
        throw error;
      });
    return finishAttempt;
  };
  controller.absoluteControllerDeadline = absoluteControllerDeadline;
  controller.finish = finish;
  controller.outcomeWithin = outcomeWithin;
  controller.signal = signal;
  controller.verifyOwnedWrapper = verifyOwnedWrapperImmediatelyBeforeSignal;
  try {
    const ownership = openOwnershipDescriptor();
    ownershipFd = ownership.fd;
    ownershipTracked = true;
    ownershipIdentity = ownership.identity;
    assert.equal(
      openWrapperOwnershipDescriptors.has(ownershipFd),
      true,
      "ownership descriptor was not tracked",
    );
    child = spawnOwnedChild(command, args, environment, ownershipFd, superviseBrowser);
    controller.child = child;
    acquisitionState = "acquired";
    activeWrapperControllers.add(controller);
    child.once("close", (code, signalName) => publishCloseOutcome(code, signalName));
    closeObserverBound = true;
    acquisitionState = "close-bound";
    child.once("exit", () => {
      exitObserved = true;
    });
    child.once("error", (error) => {
      processError = error;
    });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    retainOwnedWrapper();
    if (retainedIdentity && !closeObserved) verifyOwnedWrapperImmediatelyBeforeSignal();
    return controller;
  } catch (error) {
    if (child) {
      setupFailure = error;
      controllerErrors.push(error);
      controller.identity = retainedIdentity;
      return controller;
    }
    acquisitionState = "no-subject";
    const failures = [error];
    if (ownershipTracked && ownershipFd !== undefined) {
      try {
        closeSync(ownershipFd);
        openWrapperOwnershipDescriptors.delete(ownershipFd);
        ownershipTracked = false;
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "wrapper controller setup failed");
    }
    throw error;
  }
}

async function assertNoNewPostgresTemporaryDirectories(before) {
  assert.deepEqual(await postgresTemporaryDirectories(), before);
}

async function runRealBrowserSignalCase(signal, secondSignal = false) {
  const before = await postgresTemporaryDirectories();
  const beforeBrowserRoots = await browserTemporaryDirectories();
  const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "real-browser-green-"));
  const readyPath = join(caseRoot, "ready.json");
  const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");
  const signalBehavior = !signal
    ? ""
    : secondSignal
      ? `process.on("${signal}",()=>{})`
      : `process.on("${signal}",()=>process.exit(0))`;
  const source = [
    'const {spawnSync}=require("node:child_process")',
    'const {linkSync,unlinkSync,writeFileSync}=require("node:fs")',
    'const {createRequire}=require("node:module")',
    `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,
    'const {chromium}=requirePlaywright("@playwright/test")',
    "(async()=>{",
    signalBehavior,
    "const controlRoot=process.env.ESBLA_BROWSER_CONTROL_ROOT",
    "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
    "const profileRoot=process.env.ESBLA_BROWSER_PROFILE_ROOT",
    "const launcher=process.env.ESBLA_BROWSER_LAUNCHER",
    'const intentTmp=controlRoot+"/.intent."+process.pid',
    'writeFileSync(intentTmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
    'linkSync(intentTmp,controlRoot+"/browser.intent")',
    "unlinkSync(intentTmp)",
    "const oldTmpdir=process.env.TMPDIR",
    "process.env.TMPDIR=profileRoot",
    "process.env.ESBLA_BROWSER_REAL_EXECUTABLE=chromium.executablePath()",
    "let server",
    'try{server=await chromium.launchServer({executablePath:launcher,handleSIGHUP:false,handleSIGINT:false,handleSIGTERM:false,headless:true,host:"127.0.0.1",port:0})}finally{if(oldTmpdir===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmpdir;delete process.env.ESBLA_BROWSER_REAL_EXECUTABLE}',
    "const browserPid=server.process().pid",
    'const pgid=Number(spawnSync("/bin/ps",["-o","pgid=","-p",String(browserPid)],{encoding:"utf8",timeout:1_000}).stdout.trim())',
    'const ack=Object.fromEntries(require("node:fs").readFileSync(controlRoot+"/browser.ack","utf8").trim().split("\\n").map((line)=>{const index=line.indexOf("=");return[line.slice(0,index),line.slice(index+1)]}))',
    `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({ackPid:Number(ack.pid),browserPid,controlRoot,pgid,profileRoot}))`,
    "setInterval(()=>{},1000)",
    "})().catch((error)=>{let message=String(error?.stack??error);for(const value of [process.env.ESBLA_BROWSER_CONTROL_ROOT,process.env.ESBLA_BROWSER_PROFILE_ROOT,process.env.ESBLA_BROWSER_CONTROL_NONCE,chromium.executablePath()]){if(typeof value==='string'&&value.length>0)message=message.replaceAll(value,'[REDACTED]')}process.stderr.write(message);process.exit(1)})",
  ].join(";");
  let browserIdentity;
  let wrapper;
  try {
    wrapper = spawnSupervisedPostgresWrapper(process.execPath, ["-e", source]);
    const outcome = childOutcome(wrapper, 90_000);
    const startup = await Promise.race([
      waitForFile(readyPath, 30_000).then(
        (value) => ({ kind: "ready", value }),
        () => ({ kind: "ready-error" }),
      ),
      outcome.then(
        (value) => ({ kind: "outcome", value }),
        () => ({ kind: "outcome-error" }),
      ),
    ]);
    if (startup.kind === "ready-error") {
      throw new Error("browser readiness observation failed within its existing bound");
    }
    if (startup.kind === "outcome-error") {
      throw new Error("browser wrapper outcome failed before readiness");
    }
    if (startup.kind === "outcome") {
      const diagnostic = String(startup.value.stderr ?? "").trim();
      if (diagnostic.includes(wrapperTemporaryRoot) || /[a-f0-9]{64}/i.test(diagnostic)) {
        throw new Error("browser wrapper exited before readiness with an unsafe diagnostic");
      }
      throw new Error(
        `browser wrapper exited before readiness: code=${startup.value.code}; signal=${startup.value.signal}; diagnostic=${diagnostic || "none"}`,
      );
    }
    browserIdentity = startup.value;
    assert.equal(browserIdentity.browserPid, browserIdentity.pgid);
    assert.equal(browserIdentity.browserPid, browserIdentity.ackPid);
    if (signal) {
      wrapper.signal(signal);
      if (secondSignal) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        wrapper.signal(signal);
      }
    }
    const result = await outcome;
    assert.equal(result.signal, signal, result.stderr);
    await waitForPidExit(browserIdentity.browserPid);
    for (const ownedRoot of [browserIdentity.profileRoot, browserIdentity.controlRoot]) {
      await assert.rejects(() => access(ownedRoot), /ENOENT/);
    }
    await assertNoNewPostgresTemporaryDirectories(before);
    assert.deepEqual(await browserTemporaryDirectories(), beforeBrowserRoots);
  } finally {
    if (wrapper && !wrapper.settled) {
      wrapper.signal("SIGTERM");
      await wrapper.finish(75_000);
    }
    await rm(caseRoot, { force: true, recursive: true });
  }
}

async function runAbruptHarnessCrashCase() {
  const beforePostgresRoots = await postgresTemporaryDirectories();
  const beforeBrowserRoots = await browserTemporaryDirectories();
  const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "abrupt-harness-crash-"));
  const readyPath = join(caseRoot, "ready.json");
  const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");
  const source = [
    'const {spawnSync}=require("node:child_process")',
    'const {fstatSync,linkSync,readFileSync,unlinkSync,writeFileSync}=require("node:fs")',
    'const {createRequire}=require("node:module")',
    `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,
    'const {chromium}=requirePlaywright("@playwright/test")',
    'const parseIdentity=(line)=>{const p=line.trim().split(/\\s+/);return{pid:Number(p[0]),ppid:Number(p[1]),pgid:Number(p[2]),session:Number(p[3]),uid:Number(p[4]),start:p.slice(5,10).join(" "),command:p.slice(10).join(" ")}}',
    'const identity=(pid)=>parseIdentity(spawnSync("/bin/ps",["-ww","-o","pid=,ppid=,pgid=,sess=,uid=,lstart=,command=","-p",String(pid)],{encoding:"utf8",timeout:1_000}).stdout)',
    'const identities=()=>spawnSync("/bin/ps",["-ww","-axo","pid=,ppid=,pgid=,sess=,uid=,lstart=,command="],{encoding:"utf8",timeout:1_000}).stdout.trim().split("\\n").filter(Boolean).map(parseIdentity)',
    "(async()=>{",
    "const controlRoot=process.env.ESBLA_BROWSER_CONTROL_ROOT",
    "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
    "const profileRoot=process.env.ESBLA_BROWSER_PROFILE_ROOT",
    "const launcher=process.env.ESBLA_BROWSER_LAUNCHER",
    'const intentTmp=controlRoot+"/.intent."+process.pid',
    'writeFileSync(intentTmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
    'linkSync(intentTmp,controlRoot+"/browser.intent")',
    "unlinkSync(intentTmp)",
    "const oldTmpdir=process.env.TMPDIR",
    "process.env.TMPDIR=profileRoot",
    "process.env.ESBLA_BROWSER_REAL_EXECUTABLE=chromium.executablePath()",
    "let server",
    'try{server=await chromium.launchServer({executablePath:launcher,handleSIGHUP:false,handleSIGINT:false,handleSIGTERM:false,headless:true,host:"127.0.0.1",port:0})}finally{if(oldTmpdir===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmpdir;delete process.env.ESBLA_BROWSER_REAL_EXECUTABLE}',
    "const browserPid=server.process().pid",
    "const realExecutable=chromium.executablePath()",
    'const realChildren=identities().filter((candidate)=>candidate.ppid===browserPid&&candidate.pgid===browserPid&&(candidate.command===realExecutable||candidate.command.startsWith(realExecutable+" ")))',
    'if(realChildren.length!==1)throw new Error("Exact direct Chromium child is ambiguous")',
    'const ack=Object.fromEntries(readFileSync(controlRoot+"/browser.ack","utf8").trim().split("\\n").map((line)=>{const index=line.indexOf("=");return[line.slice(0,index),line.slice(index+1)]}))',
    "const fd5=fstatSync(5,{bigint:true})",
    "const ready={ackPid:Number(ack.pid),browser:identity(browserPid),chromium:realChildren[0],controlRoot,fd5:{dev:String(fd5.dev),ino:String(fd5.ino)},harness:identity(process.pid),profileRoot,realExecutable}",
    `const readyTmp=${JSON.stringify(readyPath)}+".tmp."+process.pid`,
    'writeFileSync(readyTmp,JSON.stringify(ready),{flag:"wx",mode:0o600})',
    `linkSync(readyTmp,${JSON.stringify(readyPath)})`,
    "unlinkSync(readyTmp)",
    "setInterval(()=>{},1000)",
    "})().catch((error)=>{process.stderr.write(String(error?.stack??error));process.exitCode=1})",
  ].join(";");
  let controller;
  let ready;
  let result;
  try {
    controller = await spawnOwnedWrapperController(
      process.execPath,
      ["-e", source],
      {},
      {
        operationTimeoutMs: 70_000,
      },
    );
    ready = await waitForFile(readyPath, 30_000);
    const expectedBrowserOwnership = readProcessDescriptorIdentity(ready.browser.pid, 9);
    assert.ok(expectedBrowserOwnership, "browser anchor FD-9 ownership capability was absent");
    const assertRelation = () => {
      const wrapper = controller.verifyOwnedWrapper();
      const harness = captureStableProcessIdentity(ready.harness.pid, ready.harness);
      const browser = captureStableProcessIdentity(ready.browser.pid, ready.browser);
      const chromium = captureStableProcessIdentity(ready.chromium.pid, ready.chromium);
      assert.equal(harness.ppid, wrapper.pid);
      assert.equal(harness.pgid, harness.pid);
      assert.equal(browser.ppid, harness.pid);
      assert.equal(browser.pgid, browser.pid);
      assert.equal(browser.session, harness.session);
      assert.equal(browser.uid, harness.uid);
      assert.equal(chromium.ppid, browser.pid);
      assert.equal(chromium.pgid, browser.pgid);
      assert.equal(chromium.session, browser.session);
      assert.equal(chromium.uid, browser.uid);
      assert.ok(
        commandUsesExactExecutable(chromium.command, ready.realExecutable),
        "direct Chromium child executable changed",
      );
      assert.equal(ready.ackPid, browser.pid);
      assert.ok(processGroupExists(harness.pgid));
      assert.ok(processGroupExists(browser.pgid));
      assert.ok(
        sameFilesystemIdentity(readProcessDescriptorIdentity(harness.pid, 5), ready.fd5),
        "harness FD-5 ownership capability changed",
      );
      assert.ok(
        sameFilesystemIdentity(
          readProcessDescriptorIdentity(browser.pid, 9),
          expectedBrowserOwnership,
        ),
        "browser anchor FD-9 ownership capability changed",
      );
      assert.equal(readProcessDescriptorIdentity(browser.pid, 3), undefined);
      assert.equal(readProcessDescriptorIdentity(browser.pid, 4), undefined);
      assert.ok(readProcessDescriptorIdentity(chromium.pid, 3));
      assert.ok(readProcessDescriptorIdentity(chromium.pid, 4));
      assert.equal(
        sameFilesystemIdentity(
          readProcessDescriptorIdentity(chromium.pid, 9),
          expectedBrowserOwnership,
        ),
        false,
        "direct Chromium child inherited the browser ownership capability",
      );
      return { browser, chromium, harness };
    };
    assertRelation();
    const boundary = assertRelation();
    process.kill(boundary.harness.pid, "SIGKILL");
    result = await controller.outcome;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /exited with SIGKILL/);
    await Promise.all([
      waitForPidExit(boundary.harness.pid, 15_000),
      waitForPidExit(boundary.browser.pid, 15_000),
      waitForPidExit(boundary.chromium.pid, 15_000),
    ]);
    await assert.rejects(() => access(ready.controlRoot), /ENOENT/);
    await assert.rejects(() => access(ready.profileRoot), /ENOENT/);
  } finally {
    if (controller && !controller.settled) controller.signal("SIGTERM");
    if (controller) result = await controller.finish();
    await rm(caseRoot, { force: true, recursive: true });
  }
  assert.equal(controller?.controllerErrors.length, 0);
  assert.equal(controller?.hardKillUsed, false);
  assert.equal(controller?.rescueUsed, false);
  await assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots);
}

async function runMalformedCancellationIsolationCase({
  afterFixtureIdentityCapture,
  beforeControllerAcquisition,
  fixturePrivateStopRoot,
  fixtureSignalEvidenceRoot,
  onCaseRootAcquired,
  onFixtureAcquired,
  onFixturesCreated,
} = {}) {
  const beforePostgresRoots = await postgresTemporaryDirectories();
  const beforeBrowserRoots = await browserTemporaryDirectories();
  const fixtureSlots = [
    createCooperativeFixtureSlot("claimed"),
    createCooperativeFixtureSlot("sentinel"),
  ];
  let caseRoot;
  let caseRootOwned;
  let claimed;
  let sentinel;
  let controller;
  let controllerAcquisition = "not-attempted";
  let controlOwned;
  let profileOwned;
  let proof;
  let hasPrimaryFailure = false;
  let primaryFailure;
  const cleanupFailures = [];
  try {
    caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "malformed-case-"));
    caseRootOwned = captureOwnedDirectory(await realpath(caseRoot), "malformed case root");
    await onCaseRootAcquired?.({ caseRoot, caseRootOwned });
    spawnCooperativeFixture(
      fixtureSlots[0],
      caseRoot,
      "claimed",
      fixtureSignalEvidenceRoot ?? caseRoot,
      fixturePrivateStopRoot ?? caseRoot,
      [],
      onFixtureAcquired,
    );
    spawnCooperativeFixture(
      fixtureSlots[1],
      caseRoot,
      "sentinel",
      fixtureSignalEvidenceRoot ?? caseRoot,
      fixturePrivateStopRoot ?? caseRoot,
      [],
      onFixtureAcquired,
    );
    await onFixturesCreated?.({ caseRoot, fixtures: fixtureSlots });
    claimed = await retainCooperativeFixture(fixtureSlots[0]);
    await afterFixtureIdentityCapture?.(claimed);
    sentinel = await retainCooperativeFixture(fixtureSlots[1]);
    await afterFixtureIdentityCapture?.(sentinel);
    assert.equal(
      isSemanticSessionLeader(claimed.sessionObservation),
      true,
      "retained semantic session-leader evidence is invalid",
    );
    assert.equal(
      isSemanticSessionLeader(sentinel.sessionObservation),
      true,
      "retained semantic session-leader evidence is invalid",
    );
    await beforeControllerAcquisition?.();
    const readyPath = join(caseRoot, "ready.json");
    const harnessTermMarker = join(caseRoot, "harness-term.txt");
    const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");
    const source = [
      'const {existsSync,linkSync,unlinkSync,writeFileSync}=require("node:fs")',
      'const {spawnSync}=require("node:child_process")',
      'const {createRequire}=require("node:module")',
      `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,
      'const {chromium}=requirePlaywright("@playwright/test")',
      `const claimed=${JSON.stringify(claimed.identity)}`,
      'const identity=(pid)=>{const p=spawnSync("/bin/ps",["-ww","-o","pid=,ppid=,pgid=,sess=,uid=,lstart=,command=","-p",String(pid)],{encoding:"utf8",timeout:1_000}).stdout.trim().split(/\\s+/);return{pid:Number(p[0]),ppid:Number(p[1]),pgid:Number(p[2]),session:Number(p[3]),uid:Number(p[4]),start:p.slice(5,10).join(" "),command:p.slice(10).join(" ")}}',
      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",
      "const profile=process.env.ESBLA_BROWSER_PROFILE_ROOT",
      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
      "const realExecutable=chromium.executablePath()",
      'const wrongNonce=(nonce[0]==="a"?"b":"a")+nonce.slice(1)',
      `process.on("SIGTERM",()=>{try{writeFileSync(${JSON.stringify(harnessTermMarker)},"SIGTERM\\n",{flag:"a",mode:0o600})}catch{}})`,
      'for(let attempt=0;attempt<400&&!existsSync(root+"/harness.retained");attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)',
      'if(!existsSync(root+"/harness.retained"))throw new Error("harness retention was not published")',
      'const intentTmp=root+"/.intent."+process.pid',
      'writeFileSync(intentTmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
      'linkSync(intentTmp,root+"/browser.intent")',
      "unlinkSync(intentTmp)",
      'writeFileSync(root+"/browser.cancelled","malformed\\n",{flag:"wx",mode:0o600})',
      'const record={version:"2",nonce:wrongNonce,pid:String(claimed.pid),ppid:String(process.pid),pgid:String(claimed.pgid),session:String(claimed.session),uid:String(claimed.uid),start:claimed.start,parent_start:identity(process.pid).start,fd3:"open",fd4:"open",fd9:"open",real:realExecutable}',
      'const body=["version","nonce","pid","ppid","pgid","session","uid","start","parent_start","fd3","fd4","fd9","real"].map((key)=>key+"="+record[key]).join("\\n")+"\\n"',
      'writeFileSync(root+"/browser.registration",body,{flag:"wx",mode:0o600})',
      `const ready={harness:identity(process.pid),profile,root,nonce,wrongNonce,realExecutable}`,
      `const readyTmp=${JSON.stringify(readyPath)}+".tmp."+process.pid`,
      'writeFileSync(readyTmp,JSON.stringify(ready),{flag:"wx",mode:0o600})',
      `linkSync(readyTmp,${JSON.stringify(readyPath)})`,
      "unlinkSync(readyTmp)",
      "setInterval(()=>{},1000)",
    ].join(";");
    controllerAcquisition = "attempting";
    try {
      controller = spawnOwnedWrapperController(
        process.execPath,
        ["-e", source],
        {},
        { operationTimeoutMs: 35_000 },
      );
      controllerAcquisition = controller.phase;
    } catch (error) {
      controllerAcquisition = "no-subject";
      throw error;
    }
    const ready = await waitForFile(readyPath, 20_000);
    const harness = captureStableProcessIdentity(ready.harness.pid, ready.harness);
    assert.equal(claimed.identity.ppid, process.pid, "claimed fixture is not a direct child");
    assert.equal(sentinel.identity.ppid, process.pid, "sentinel fixture is not a direct child");
    assert.equal(claimed.identity.pid, claimed.identity.pgid, "claimed group is not isolated");
    assert.equal(sentinel.identity.pid, sentinel.identity.pgid, "sentinel group is not isolated");
    assert.equal(harness.pid, harness.pgid, "supervised harness group is not isolated");
    assert.equal(
      new Set([claimed.identity.pgid, sentinel.identity.pgid, harness.pgid]).size,
      3,
      "claimed, sentinel, and harness groups are not distinct",
    );
    controlOwned = captureOwnedDirectory(await realpath(ready.root), "Red F control root");
    profileOwned = captureOwnedDirectory(await realpath(ready.profile), "Red F profile root");
    await waitForPath(harnessTermMarker, 10_000);
    assert.equal(
      await controller.outcomeWithin(20_000),
      true,
      "internal bounded shutdown did not complete",
    );
    const result = await controller.finish();
    assert.equal(result.code, 1, "internally rejected wrapper did not exit with code 1");
    assert.equal(result.signal, null, "internally rejected wrapper reported an outer signal");
    const claimedAfter = captureStableProcessIdentity(claimed.identity.pid, claimed.identity);
    const sentinelAfter = captureStableProcessIdentity(sentinel.identity.pid, sentinel.identity);
    const claimedSessionObservationAfter = readSemanticSessionObservation(claimedAfter);
    const sentinelSessionObservationAfter = readSemanticSessionObservation(sentinelAfter);
    assert.equal(
      isSemanticSessionLeader(claimedSessionObservationAfter),
      true,
      "claimed fixture lost semantic session leadership after supervisor drain",
    );
    assert.equal(
      isSemanticSessionLeader(sentinelSessionObservationAfter),
      true,
      "sentinel fixture lost semantic session leadership after supervisor drain",
    );
    assert.equal(await pathExists(claimed.signalMarkerPath), false, "claimed fixture was signaled");
    assert.equal(
      await pathExists(sentinel.signalMarkerPath),
      false,
      "sentinel fixture was signaled",
    );
    await assert.rejects(() => access(join(ready.root, "browser.ack")), /ENOENT/);
    await access(ready.root);
    await access(ready.profile);
    assert.equal(controller.controllerErrors.length, 0, "controller recorded an unexpected error");
    assert.equal(controller.hardKillUsed, false, "external hard-kill rescue was used");
    assert.equal(controller.rescueUsed, false, "external rescue was used");
    const trackedValues = Object.freeze([
      ready.root,
      ready.profile,
      ready.nonce,
      ready.wrongNonce,
      ready.realExecutable,
    ]);
    assert.equal(
      diagnosticsExcludeTrackedValues(result.stderr, trackedValues),
      true,
      "diagnostics exposed protected metadata",
    );
    const diagnosticPredicates = [
      /exited with SIGKILL/.test(result.stderr),
      /registration.*nonce|nonce.*registration/i.test(result.stderr),
      /Browser control record contains a malformed field/.test(result.stderr),
    ];
    assert.deepEqual(diagnosticPredicates, [true, true, true], "required diagnostics absent");
    proof = {
      claimedAfter,
      claimedBefore: claimed.identity,
      claimedSessionObservation: claimed.sessionObservation,
      claimedSessionObservationAfter,
      diagnostics: result.stderr,
      harnessBefore: harness,
      sentinelAfter,
      sentinelBefore: sentinel.identity,
      sentinelSessionObservation: sentinel.sessionObservation,
      sentinelSessionObservationAfter,
      trackedValues,
    };
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  } finally {
    const ownerResults = await Promise.allSettled(
      fixtureSlots.map(async (slot) => {
        if (["not-attempted", "no-subject"].includes(slot.acquisition)) return { kind: "absent" };
        const owner = await retainCooperativeFixture(slot);
        return { kind: "owned", owner };
      }),
    );
    const stopPublicationResults = await Promise.allSettled(
      fixtureSlots.map((slot) => publishCooperativeFixtureStop(slot)),
    );
    const controllerResults = await Promise.allSettled([
      (async () => {
        if (["not-attempted", "no-subject"].includes(controllerAcquisition)) {
          assert.equal(controller, undefined);
          return { finishResults: [], kind: "absent", verificationResults: [] };
        }
        assert.ok(controller, "controller handle missing after acquisition");
        const identity = controller.identity;
        const finishResults = await Promise.allSettled([controller.finish(75_000)]);
        const verificationResults = await Promise.allSettled([
          (async () =>
            assert.equal(controller.phase, "finalized", "controller did not finalize"))(),
          (async () => assert.equal(controller.settled, true, "controller did not settle"))(),
          (async () =>
            assert.equal(
              activeWrapperControllers.has(controller),
              false,
              "controller remained active",
            ))(),
          (async () => {
            if (identity)
              assert.equal(
                sameProcessIdentity(identity, readProcessIdentity(identity.pid, 1_000)),
                false,
                "controller exact identity remained live",
              );
          })(),
        ]);
        return { finishResults, kind: "finished", verificationResults };
      })(),
    ]);
    const exactJoinResults = await Promise.allSettled(
      fixtureSlots.map((slot) => joinCooperativeFixture(slot)),
    );
    const exactFixtureFinalizationFulfilled =
      fixtureSlots.length === 2 &&
      ownerResults.length === 2 &&
      stopPublicationResults.length === 2 &&
      exactJoinResults.length === 2 &&
      fixtureSlots.every((slot, index) => {
        const owner = ownerResults[index];
        const stop = stopPublicationResults[index];
        const join = exactJoinResults[index];
        if (["not-attempted", "no-subject"].includes(slot.acquisition))
          return (
            !slot.child &&
            owner.status === "fulfilled" &&
            owner.value.kind === "absent" &&
            stop.status === "fulfilled" &&
            stop.value.kind === "absent" &&
            join.status === "fulfilled" &&
            join.value.kind === "absent"
          );
        return (
          slot.acquisition === "acquired" &&
          slot.stopPublished &&
          slot.rawClosed &&
          slot.signalAbsent &&
          slot.joined &&
          ["fulfilled", "rejected"].includes(owner.status) &&
          stop.status === "fulfilled" &&
          stop.value.kind === "published" &&
          join.status === "fulfilled" &&
          ["joined", "closed-unretained"].includes(join.value.kind)
        );
      });
    const exactControllerFinalizationFulfilled =
      controllerResults.length === 1 &&
      controllerResults[0].status === "fulfilled" &&
      controllerResults[0].value.kind ===
        (["not-attempted", "no-subject"].includes(controllerAcquisition) ? "absent" : "finished") &&
      controllerResults[0].value.verificationResults.every(
        (result) => result.status === "fulfilled",
      );
    const everyAcquiredFixtureClosed = fixtureSlots.every(
      (slot) =>
        ["not-attempted", "no-subject"].includes(slot.acquisition) ||
        (slot.acquisition === "acquired" && slot.rawClosed && slot.signalAbsent && slot.joined),
    );
    const ownedRootResults = await Promise.allSettled(
      exactControllerFinalizationFulfilled
        ? [
            (async () => {
              const roots = [controlOwned, profileOwned].filter((owned) => Boolean(owned));
              if (roots.length === 0) return { kind: "absent" };
              await cleanupExactOwnedDirectories(roots);
              return { kind: "cleaned" };
            })(),
          ]
        : [],
    );
    const caseRootResults = await Promise.allSettled(
      everyAcquiredFixtureClosed && exactControllerFinalizationFulfilled
        ? [
            (async () => {
              if (caseRoot === undefined) {
                assert.equal(caseRootOwned, undefined);
                return { kind: "absent" };
              }
              assert.ok(caseRootOwned, "case-root capability missing");
              await cleanupExactOwnedDirectories([caseRootOwned]);
              return { kind: "cleaned" };
            })(),
          ]
        : [],
    );
    const residueResults = await Promise.allSettled([
      (async () => {
        await assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots);
        if (caseRoot !== undefined)
          assert.equal(await pathExists(caseRoot), false, "malformed case root remained");
        return { kind: "clean" };
      })(),
    ]);
    const controllerFinishResults = controllerResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value.finishResults : [],
    );
    const controllerVerificationResults = controllerResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value.verificationResults : [],
    );
    const allCleanupResults = [
      ...ownerResults,
      ...stopPublicationResults,
      ...controllerResults,
      ...controllerFinishResults,
      ...controllerVerificationResults,
      ...exactJoinResults,
      ...ownedRootResults,
      ...caseRootResults,
      ...residueResults,
    ];
    cleanupFailures.push(
      ...allCleanupResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
      ...fixtureSlots.filter((slot) => Boolean(slot.setupError)).map((slot) => slot.setupError),
      ...(!exactFixtureFinalizationFulfilled
        ? [new Error("exact fixture finalization was incomplete")]
        : []),
      ...(!exactControllerFinalizationFulfilled
        ? [new Error("exact controller finalization was incomplete")]
        : []),
    );
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(hasPrimaryFailure ? [primaryFailure] : []), ...cleanupFailures],
      "Red F isolation cleanup was incomplete",
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
  return proof;
}

function sealedAbruptRelationCarrierManifest() {
  return Object.freeze(
    [
      ["wrapper", "const wrapper=controller.verifyOwnedWrapper()"],
      ["harness", "const harness=captureStableProcessIdentity(ready.harness.pid,ready.harness)"],
      ["browser", "const browser=captureStableProcessIdentity(ready.browser.pid,ready.browser)"],
      [
        "chromium",
        "const chromium=captureStableProcessIdentity(ready.chromium.pid,ready.chromium)",
      ],
      ["harness-parent", "assert.equal(harness.ppid,wrapper.pid)"],
      ["harness-leader", "assert.equal(harness.pgid,harness.pid)"],
      ["browser-parent", "assert.equal(browser.ppid,harness.pid)"],
      ["browser-leader", "assert.equal(browser.pgid,browser.pid)"],
      ["session", "assert.equal(browser.session,harness.session)"],
      ["uid", "assert.equal(browser.uid,harness.uid)"],
      ["chromium-parent", "assert.equal(chromium.ppid,browser.pid)"],
      ["chromium-group", "assert.equal(chromium.pgid,browser.pgid)"],
      ["chromium-session", "assert.equal(chromium.session,browser.session)"],
      ["chromium-uid", "assert.equal(chromium.uid,browser.uid)"],
      [
        "chromium-executable",
        'assert.ok(commandUsesExactExecutable(chromium.command,ready.realExecutable),"direct Chromium child executable changed")',
      ],
      ["ack", "assert.equal(ready.ackPid,browser.pid)"],
      ["harness-live", "assert.ok(processGroupExists(harness.pgid))"],
      ["browser-live", "assert.ok(processGroupExists(browser.pgid))"],
      [
        "fd5",
        'assert.ok(sameFilesystemIdentity(readProcessDescriptorIdentity(harness.pid,5),ready.fd5),"harness FD-5 ownership capability changed")',
      ],
      [
        "fd9",
        'assert.ok(sameFilesystemIdentity(readProcessDescriptorIdentity(browser.pid,9),expectedBrowserOwnership),"browser anchor FD-9 ownership capability changed")',
      ],
      ["anchor-fd3", "assert.equal(readProcessDescriptorIdentity(browser.pid,3),undefined)"],
      ["anchor-fd4", "assert.equal(readProcessDescriptorIdentity(browser.pid,4),undefined)"],
      ["chromium-fd3", "assert.ok(readProcessDescriptorIdentity(chromium.pid,3))"],
      ["chromium-fd4", "assert.ok(readProcessDescriptorIdentity(chromium.pid,4))"],
      [
        "chromium-fd9",
        'assert.equal(sameFilesystemIdentity(readProcessDescriptorIdentity(chromium.pid,9),expectedBrowserOwnership),false,"direct Chromium child inherited the browser ownership capability")',
      ],
      ["return", "return {browser,chromium,harness}"],
    ].map(([key, statement]) => Object.freeze({ key, statement })),
  );
}

function syntheticAbruptHarnessProgram(omission) {
  const relationStatements = sealedAbruptRelationCarrierManifest()
    .filter(({ key }) => key !== omission)
    .map(({ statement }) => statement)
    .join(";");
  const repeatedRelation = omission === "repeat" ? "" : "assertRelation();";
  return `function runAbruptHarnessCrashCase(){const expectedBrowserOwnership=readProcessDescriptorIdentity(ready.browser.pid,9);assert.ok(expectedBrowserOwnership,"browser anchor FD-9 ownership capability was absent");const assertRelation=()=>{${relationStatements}};${repeatedRelation}const boundary=assertRelation();process.kill(boundary.harness.pid,"SIGKILL")}`;
}

function canonicalSignalContractSource() {
  return [
    'import assert from "node:assert/strict";',
    'import {spawn,spawnSync} from "node:child_process";',
    'import {randomUUID} from "node:crypto";',
    'import {closeSync,fstatSync,openSync,statSync,unlinkSync} from "node:fs";',
    'import {mkdtemp} from "node:fs/promises";',
    'import {join,resolve} from "node:path";',
    'import {fileURLToPath} from "node:url";',
    canonicalOwnedControllerEnvironmentSource(),
    "const activeWrapperControllers=new Set();",
    "const completedWrapperControllers=[];",
    "const openWrapperOwnershipDescriptors=new Set();",
    "const recordedWrapperIdentities=[];",
    canonicalSignalHelperSemanticSource("captureStableProcessIdentity"),
    canonicalProbeSignalSource(),
    canonicalOwnedControllerLifecycleSource(),
    syntheticAbruptHarnessProgram(undefined),
  ].join("\n");
}

function canonicalExecutableFacadeCallContracts() {
  const contracts = [
    {
      expression: "spawnOwnedWrapperController(command,args,{}, {superviseBrowser:false})",
      owner: "spawnPostgresWrapper",
    },
    {
      expression: "spawnOwnedWrapperController(command,args,environment,{superviseBrowser:true})",
      owner: "spawnSupervisedPostgresWrapper",
    },
    {
      expression: 'spawnSupervisedPostgresWrapper(process.execPath,["-e",source])',
      owner: "runRealBrowserSignalCase",
    },
    {
      expression:
        'spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:70_000})',
      owner: "runAbruptHarnessCrashCase",
    },
    {
      expression:
        'spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000})',
      owner: "runMalformedCancellationIsolationCase",
    },
    {
      expression:
        'spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000})',
      owner: "runMaliciousRegistrationCase",
    },
    {
      expression: 'spawnPostgresWrapper(process.execPath,["-e","process.exit(0)"])',
      owner: "test:cleans PostgreSQL on child success, failure, and spawn error",
    },
    {
      expression: 'spawnPostgresWrapper(process.execPath,["-e","process.exit(7)"])',
      owner: "test:cleans PostgreSQL on child success, failure, and spawn error",
    },
    {
      expression: 'spawnPostgresWrapper(join(tmpdir(),"esbla-command-that-does-not-exist"))',
      owner: "test:cleans PostgreSQL on child success, failure, and spawn error",
    },
    {
      expression:
        'spawnOwnedWrapperController(process.execPath,["-e",source],{ESBLA_BROWSER_CONTROL_NONCE:"ambient-nonce",ESBLA_BROWSER_CONTROL_ROOT:"/tmp/ambient-control",ESBLA_BROWSER_REAL_EXECUTABLE:"/tmp/ambient-browser"},{superviseBrowser:false})',
      owner: "test:keeps ordinary PostgreSQL-wrapper children free of browser-control environment",
    },
    {
      expression:
        'spawnOwnedWrapperController(process.execPath,["-e","process.exit(0)"],{PATH:"/usr/bin:/bin"},{superviseBrowser:true})',
      owner: "test:removes supervised control and profile roots when setup fails before PostgreSQL",
    },
    {
      expression: 'spawnSupervisedPostgresWrapper(process.execPath,["-e",source])',
      owner: "test:cancels launch intent when the harness crashes before launcher spawn",
    },
    {
      expression: 'spawnSupervisedPostgresWrapper(process.execPath,["-e",source])',
      owner: "test:V1C3-AUDIT-002 retains roots for a no-intent detached exact launcher",
    },
    {
      expression: 'spawnSupervisedPostgresWrapper(process.execPath,["-e",source])',
      owner: "test:V1C3-AUDIT-004 rejects multiply-linked cancellation and retains roots",
    },
    {
      expression: 'spawnSupervisedPostgresWrapper(process.execPath,["-e",source])',
      owner: "test:cleans owned state when BrowserServer listen is rejected",
    },
    {
      expression: 'spawnSupervisedPostgresWrapper(process.execPath,["-e",commandSource])',
      owner:
        "test:Red F bounds finish after the wrapper exits while an owned fixture retains its pipes",
    },
    {
      expression: 'spawnPostgresWrapper(process.execPath,["-e",source])',
      owner: "test:preserves the ordinary wrapper's inherited process-group behavior",
    },
    {
      expression: 'spawnSupervisedPostgresWrapper(process.execPath,["-e",source])',
      owner: "test-template:forwarded-signal",
    },
    {
      expression: 'spawnSupervisedPostgresWrapper(process.execPath,["-e",source])',
      owner: "test:a second signal immediately escalates a resistant child group",
    },
    {
      expression:
        'spawnSupervisedPostgresWrapper(process.execPath,["-e",source],{ESBLA_BROWSER_TEST_PRE_REGISTRATION_DELAY_MS:"800"})',
      owner: "test-template:pre-registration-signal",
    },
  ];
  const controlByOwner = new Map([
    ["spawnPostgresWrapper", ["ReturnStatement", 0]],
    ["spawnSupervisedPostgresWrapper", ["ReturnStatement", 0]],
    ["runRealBrowserSignalCase", ["ExpressionStatement", 1]],
    ["runAbruptHarnessCrashCase", ["ExpressionStatement", 1]],
    ["runMalformedCancellationIsolationCase", ["ExpressionStatement", 2]],
    ["runMaliciousRegistrationCase", ["ExpressionStatement", 2]],
    ["test:cleans PostgreSQL on child success, failure, and spawn error", ["VariableStatement", 0]],
    [
      "test:keeps ordinary PostgreSQL-wrapper children free of browser-control environment",
      ["VariableStatement", 1],
    ],
    [
      "test:removes supervised control and profile roots when setup fails before PostgreSQL",
      ["VariableStatement", 0],
    ],
    [
      "test:cancels launch intent when the harness crashes before launcher spawn",
      ["VariableStatement", 1],
    ],
    [
      "test:V1C3-AUDIT-002 retains roots for a no-intent detached exact launcher",
      ["VariableStatement", 1],
    ],
    [
      "test:V1C3-AUDIT-004 rejects multiply-linked cancellation and retains roots",
      ["VariableStatement", 1],
    ],
    ["test:cleans owned state when BrowserServer listen is rejected", ["VariableStatement", 1]],
    [
      "test:Red F bounds finish after the wrapper exits while an owned fixture retains its pipes",
      ["VariableStatement", 0],
    ],
    [
      "test:preserves the ordinary wrapper's inherited process-group behavior",
      ["VariableStatement", 1],
    ],
    ["test-template:forwarded-signal", ["ExpressionStatement", 1]],
    [
      "test:a second signal immediately escalates a resistant child group",
      ["ExpressionStatement", 1],
    ],
    ["test-template:pre-registration-signal", ["ExpressionStatement", 1]],
  ]);
  return Object.freeze(
    contracts.map((contract) => {
      const [statementKind, protectedTryDepth] = controlByOwner.get(contract.owner) ?? [];
      return Object.freeze({ ...contract, protectedTryDepth, statementKind });
    }),
  );
}

function canonicalExecutableFacadeDefinitionsSource() {
  return [
    "function spawnPostgresWrapper(command,args=[]){return spawnOwnedWrapperController(command,args,{},{superviseBrowser:false})}",
    "function spawnSupervisedPostgresWrapper(command,args=[],environment={}){return spawnOwnedWrapperController(command,args,environment,{superviseBrowser:true})}",
  ].join("\n");
}

function canonicalTopLevelFunctionText(sourceText, name) {
  const sourceFile = ts.createSourceFile(
    `canonical-${name}`,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = uniqueTopLevelFunctionDeclaration(sourceFile, name);
  if (sourceFile.parseDiagnostics.length > 0 || !declaration) {
    throw new Error("canonical executable-facade owner drifted");
  }
  return declaration.getText(sourceFile);
}

function canonicalRealBrowserFacadePreCallEnvelopeSource(carrierBody) {
  return [
    "const before=await postgresTemporaryDirectories();",
    "const beforeBrowserRoots=await browserTemporaryDirectories();",
    'const caseRoot=await mkdtemp(join(wrapperTemporaryRoot,"real-browser-green-"));',
    carrierBody,
    "let browserIdentity;",
    "let wrapper;",
  ].join("\n");
}

function canonicalAbruptHarnessFacadePreCallEnvelopeSource(carrierBody) {
  return [
    "const beforePostgresRoots=await postgresTemporaryDirectories();",
    "const beforeBrowserRoots=await browserTemporaryDirectories();",
    'const caseRoot=await mkdtemp(join(wrapperTemporaryRoot,"abrupt-harness-crash-"));',
    carrierBody,
    "let controller;",
    "let ready;",
    "let result;",
  ].join("\n");
}

function canonicalAbruptHarnessFacadeTrySource() {
  const relationStatements = sealedAbruptRelationCarrierManifest()
    .map(({ statement }) => statement)
    .join(";");
  return [
    'controller=await spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:70_000});',
    "ready=await waitForFile(readyPath,30_000);",
    "const expectedBrowserOwnership=readProcessDescriptorIdentity(ready.browser.pid,9);",
    'assert.ok(expectedBrowserOwnership,"browser anchor FD-9 ownership capability was absent");',
    `const assertRelation=()=>{${relationStatements}};`,
    "assertRelation();",
    "const boundary=assertRelation();",
    'process.kill(boundary.harness.pid,"SIGKILL");',
  ].join("\n");
}

function canonicalExecutableFacadeProvenanceSource() {
  const carrierBodies = Object.freeze({
    runRealBrowserSignalCase:
      '  const readyPath = join(caseRoot, "ready.json");\n  const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");\n  const signalBehavior = !signal\n    ? ""\n    : secondSignal\n      ? `process.on("${signal}",()=>{})`\n      : `process.on("${signal}",()=>process.exit(0))`;\n  const source = [\n    \'const {spawnSync}=require("node:child_process")\',\n    \'const {linkSync,unlinkSync,writeFileSync}=require("node:fs")\',\n    \'const {createRequire}=require("node:module")\',\n    `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,\n    \'const {chromium}=requirePlaywright("@playwright/test")\',\n    "(async()=>{",\n    signalBehavior,\n    "const controlRoot=process.env.ESBLA_BROWSER_CONTROL_ROOT",\n    "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",\n    "const profileRoot=process.env.ESBLA_BROWSER_PROFILE_ROOT",\n    "const launcher=process.env.ESBLA_BROWSER_LAUNCHER",\n    \'const intentTmp=controlRoot+"/.intent."+process.pid\',\n    \'writeFileSync(intentTmp,"nonce="+nonce+"\\\\npid="+process.pid+"\\\\n",{flag:"wx",mode:0o600})\',\n    \'linkSync(intentTmp,controlRoot+"/browser.intent")\',\n    "unlinkSync(intentTmp)",\n    "const oldTmpdir=process.env.TMPDIR",\n    "process.env.TMPDIR=profileRoot",\n    "process.env.ESBLA_BROWSER_REAL_EXECUTABLE=chromium.executablePath()",\n    "let server",\n    \'try{server=await chromium.launchServer({executablePath:launcher,handleSIGHUP:false,handleSIGINT:false,handleSIGTERM:false,headless:true,host:"127.0.0.1",port:0})}finally{if(oldTmpdir===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmpdir;delete process.env.ESBLA_BROWSER_REAL_EXECUTABLE}\',\n    "const browserPid=server.process().pid",\n    \'const pgid=Number(spawnSync("ps",["-o","pgid=","-p",String(browserPid)],{encoding:"utf8"}).stdout.trim())\',\n    \'const ack=Object.fromEntries(require("node:fs").readFileSync(controlRoot+"/browser.ack","utf8").trim().split("\\\\n").map((line)=>{const index=line.indexOf("=");return[line.slice(0,index),line.slice(index+1)]}))\',\n    `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({ackPid:Number(ack.pid),browserPid,controlRoot,pgid,profileRoot}))`,\n    "setInterval(()=>{},1000)",\n    "})().catch((error)=>{let message=String(error?.stack??error);for(const value of [process.env.ESBLA_BROWSER_CONTROL_ROOT,process.env.ESBLA_BROWSER_PROFILE_ROOT,process.env.ESBLA_BROWSER_CONTROL_NONCE,chromium.executablePath()]){if(typeof value===\'string\'&&value.length>0)message=message.replaceAll(value,\'[REDACTED]\')}process.stderr.write(message);process.exit(1)})",\n  ].join(";");',
    runAbruptHarnessCrashCase:
      '  const readyPath = join(caseRoot, "ready.json");\n  const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");\n  const source = [\n    \'const {spawnSync}=require("node:child_process")\',\n    \'const {fstatSync,linkSync,readFileSync,unlinkSync,writeFileSync}=require("node:fs")\',\n    \'const {createRequire}=require("node:module")\',\n    `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,\n    \'const {chromium}=requirePlaywright("@playwright/test")\',\n    \'const identity=(pid)=>{const p=spawnSync("ps",["-ww","-o","pid=,ppid=,pgid=,sess=,uid=,lstart=,command=","-p",String(pid)],{encoding:"utf8"}).stdout.trim().split(/\\\\s+/);return{pid:Number(p[0]),ppid:Number(p[1]),pgid:Number(p[2]),session:Number(p[3]),uid:Number(p[4]),start:p.slice(5,10).join(" "),command:p.slice(10).join(" ")}}\',\n    "(async()=>{",\n    "const controlRoot=process.env.ESBLA_BROWSER_CONTROL_ROOT",\n    "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",\n    "const profileRoot=process.env.ESBLA_BROWSER_PROFILE_ROOT",\n    "const launcher=process.env.ESBLA_BROWSER_LAUNCHER",\n    \'const intentTmp=controlRoot+"/.intent."+process.pid\',\n    \'writeFileSync(intentTmp,"nonce="+nonce+"\\\\npid="+process.pid+"\\\\n",{flag:"wx",mode:0o600})\',\n    \'linkSync(intentTmp,controlRoot+"/browser.intent")\',\n    "unlinkSync(intentTmp)",\n    "const oldTmpdir=process.env.TMPDIR",\n    "process.env.TMPDIR=profileRoot",\n    "process.env.ESBLA_BROWSER_REAL_EXECUTABLE=chromium.executablePath()",\n    "let server",\n    \'try{server=await chromium.launchServer({executablePath:launcher,handleSIGHUP:false,handleSIGINT:false,handleSIGTERM:false,headless:true,host:"127.0.0.1",port:0})}finally{if(oldTmpdir===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmpdir;delete process.env.ESBLA_BROWSER_REAL_EXECUTABLE}\',\n    "const browserPid=server.process().pid",\n    \'const ack=Object.fromEntries(readFileSync(controlRoot+"/browser.ack","utf8").trim().split("\\\\n").map((line)=>{const index=line.indexOf("=");return[line.slice(0,index),line.slice(index+1)]}))\',\n    "const fd5=fstatSync(5,{bigint:true})",\n    "const ready={ackPid:Number(ack.pid),browser:identity(browserPid),controlRoot,fd5:{dev:String(fd5.dev),ino:String(fd5.ino)},harness:identity(process.pid),profileRoot}",\n    `const readyTmp=${JSON.stringify(readyPath)}+".tmp."+process.pid`,\n    \'writeFileSync(readyTmp,JSON.stringify(ready),{flag:"wx",mode:0o600})\',\n    `linkSync(readyTmp,${JSON.stringify(readyPath)})`,\n    "unlinkSync(readyTmp)",\n    "setInterval(()=>{},1000)",\n    "})().catch((error)=>{process.stderr.write(String(error?.stack??error));process.exitCode=1})",\n  ].join(";");',
    ordinaryEnvironment:
      '    const observedPath = join(root, "observed.json");\n    const source = `require("node:fs").writeFileSync(${JSON.stringify(observedPath)},JSON.stringify({nonce:process.env.ESBLA_BROWSER_CONTROL_NONCE,root:process.env.ESBLA_BROWSER_CONTROL_ROOT,real:process.env.ESBLA_BROWSER_REAL_EXECUTABLE}))`;',
    launchIntent:
      '    const readyPath = join(caseRoot, "ready.json");\n    const source = [\n      \'const {linkSync,unlinkSync,writeFileSync}=require("node:fs")\',\n      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",\n      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",\n      \'const tmp=root+"/.intent."+process.pid\',\n      \'writeFileSync(tmp,"nonce="+nonce+"\\\\npid="+process.pid+"\\\\n",{flag:"wx",mode:0o600})\',\n      \'linkSync(tmp,root+"/browser.intent")\',\n      "unlinkSync(tmp)",\n      \'for(let attempt=0;attempt<400&&!require("node:fs").existsSync(root+"/harness.retained");attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)\',\n      \'if(!require("node:fs").existsSync(root+"/harness.retained"))process.exit(8)\',\n      `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({ready:true}))`,\n      "process.exit(9)",\n    ].join(";");',
    audit002:
      '    const beforeBrowserRoots = await browserTemporaryDirectories();\n    const beforePostgresRoots = await postgresTemporaryDirectories();\n    const realSuiteRoot = realpathSync(wrapperTemporaryRoot);\n    const caseRoot = mkdtempSync(join(realSuiteRoot, "no-intent-launcher-"));\n    const caseRootOwned = captureOwnedDirectory(caseRoot, "no-intent launcher case root");\n    const readyPath = join(caseRoot, "ready.json");\n    const releasePath = join(caseRoot, "release");\n    const shimReadyPath = join(caseRoot, "shim.ready");\n    const stopPath = join(caseRoot, "shim.stop");\n    const signalMarkerPath = join(caseRoot, "shim.signal");\n    const shimSource = [\n      "#!/bin/sh",\n      "set -eu",\n      `stop=${JSON.stringify(stopPath)}`,\n      `ready=${JSON.stringify(shimReadyPath)}`,\n      `signal_marker=${JSON.stringify(signalMarkerPath)}`,\n      \'trap \\\'printf "signal\\\\n" >> "$signal_marker"\\\' HUP INT TERM\',\n      \': > "$ready"\',\n      \'while [ ! -f "$stop" ]; do sleep 0.025; done\',\n      "exit 0",\n      "",\n    ].join("\\n");\n    const source = [\n      \'const {spawn}=require("node:child_process")\',\n      \'const {existsSync,writeFileSync}=require("node:fs")\',\n      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",\n      "const profile=process.env.ESBLA_BROWSER_PROFILE_ROOT",\n      "const launcher=process.env.ESBLA_BROWSER_LAUNCHER",\n      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",\n      `const shimSource=${JSON.stringify(shimSource)}`,\n      `const shimReadyPath=${JSON.stringify(shimReadyPath)}`,\n      `const readyPath=${JSON.stringify(readyPath)}`,\n      `const releasePath=${JSON.stringify(releasePath)}`,\n      "writeFileSync(launcher,shimSource,{mode:0o700})",\n      \'const shim=spawn("/bin/sh",[launcher],{detached:true,env:process.env,stdio:"ignore"})\',\n      "shim.unref()",\n      "for(let attempt=0;attempt<800&&!existsSync(shimReadyPath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",\n      \'if(!existsSync(shimReadyPath))throw new Error("detached shim did not become ready")\',\n      \'writeFileSync(readyPath,JSON.stringify({launcher,nonce,profile,root,shim:shim.pid}),{flag:"wx",mode:0o600})\',\n      "for(let attempt=0;attempt<800&&!existsSync(releasePath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",\n      \'if(!existsSync(releasePath))throw new Error("private release was not published")\',\n      "process.exit(0)",\n    ].join(";");\n\n    let wrapperController;\n    let ready;\n    let shimIdentity;\n    let controlOwned;\n    let profileOwned;\n    let observation;\n    let primaryFailure;\n    const cleanupFailures = [];',
    audit004:
      '    const beforeBrowserRoots = await browserTemporaryDirectories();\n    const beforePostgresRoots = await postgresTemporaryDirectories();\n    const realSuiteRoot = realpathSync(wrapperTemporaryRoot);\n    const caseRoot = mkdtempSync(join(realSuiteRoot, "linked-cancellation-"));\n    const caseRootOwned = captureOwnedDirectory(caseRoot, "linked cancellation case root");\n    const heldPath = join(caseRoot, "held-cancellation");\n    const readyPath = join(caseRoot, "ready.json");\n    const releasePath = join(caseRoot, "release");\n    const source = [\n      \'const {existsSync,linkSync,unlinkSync,writeFileSync}=require("node:fs")\',\n      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",\n      "const profile=process.env.ESBLA_BROWSER_PROFILE_ROOT",\n      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",\n      `const heldPath=${JSON.stringify(heldPath)}`,\n      `const readyPath=${JSON.stringify(readyPath)}`,\n      `const releasePath=${JSON.stringify(releasePath)}`,\n      \'for(let attempt=0;attempt<800&&!existsSync(root+"/harness.retained");attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)\',\n      \'if(!existsSync(root+"/harness.retained"))throw new Error("harness retention was not published")\',\n      \'writeFileSync(heldPath,"nonce="+nonce+"\\\\n",{flag:"wx",mode:0o600})\',\n      \'linkSync(heldPath,root+"/browser.cancelled")\',\n      \'const temporary=root+"/.intent."+process.pid\',\n      \'writeFileSync(temporary,"nonce="+nonce+"\\\\npid="+process.pid+"\\\\n",{flag:"wx",mode:0o600})\',\n      \'linkSync(temporary,root+"/browser.intent")\',\n      "unlinkSync(temporary)",\n      \'writeFileSync(readyPath,JSON.stringify({cancellation:root+"/browser.cancelled",nonce,profile,root}),{flag:"wx",mode:0o600})\',\n      "for(let attempt=0;attempt<800&&!existsSync(releasePath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",\n      \'if(!existsSync(releasePath))throw new Error("private release was not published")\',\n      "process.exit(0)",\n    ].join(";");\n\n    let wrapperController;\n    let ready;\n    let controlOwned;\n    let profileOwned;\n    let observation;\n    let primaryFailure;\n    const cleanupFailures = [];',
    listenRejection:
      '    const { port, server } = await listenOnEphemeralPort();\n    const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");\n    const source = [\n      \'const {linkSync,unlinkSync,writeFileSync}=require("node:fs")\',\n      \'const {createRequire}=require("node:module")\',\n      `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,\n      \'const {chromium}=requirePlaywright("@playwright/test")\',\n      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",\n      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",\n      \'const tmp=root+"/.intent."+process.pid\',\n      \'writeFileSync(tmp,"nonce="+nonce+"\\\\npid="+process.pid+"\\\\n",{flag:"wx",mode:0o600})\',\n      \'linkSync(tmp,root+"/browser.intent")\',\n      "unlinkSync(tmp)",\n      "process.env.TMPDIR=process.env.ESBLA_BROWSER_PROFILE_ROOT",\n      "process.env.ESBLA_BROWSER_REAL_EXECUTABLE=chromium.executablePath()",\n      `(async()=>{try{const browser=await chromium.launchServer({executablePath:process.env.ESBLA_BROWSER_LAUNCHER,handleSIGHUP:false,handleSIGINT:false,handleSIGTERM:false,headless:true,host:"127.0.0.1",port:${port}});await browser.close();process.exit(0)}catch{process.exit(7)}})()`,\n    ].join(";");',
    retainedPipe:
      '    const startPath = join(caseRoot, "start");\n    const handlerReadyPath = join(caseRoot, "handler-ready.json");\n    const orphanReadyPath = join(caseRoot, "orphan-ready.json");\n    const stopPath = join(caseRoot, "stop");\n    const signalMarkerPath = join(caseRoot, "signal-marker.txt");\n    const fixtureSource = [\n      \'const {existsSync,linkSync,unlinkSync,writeFileSync}=require("node:fs")\',\n      `const handlerReadyPath=${JSON.stringify(handlerReadyPath)}`,\n      `const orphanReadyPath=${JSON.stringify(orphanReadyPath)}`,\n      `const stopPath=${JSON.stringify(stopPath)}`,\n      `const signalMarkerPath=${JSON.stringify(signalMarkerPath)}`,\n      "const originalPpid=process.ppid",\n      \'const publish=(path,value)=>{const temporary=path+".tmp."+process.pid;writeFileSync(temporary,JSON.stringify(value),{flag:"wx",mode:0o600});linkSync(temporary,path);unlinkSync(temporary)}\',\n      \'for(const signal of ["SIGHUP","SIGINT","SIGTERM"])process.on(signal,()=>{try{writeFileSync(signalMarkerPath,signal+"\\\\n",{flag:"a",mode:0o600})}catch{}})\',\n      "publish(handlerReadyPath,{originalPpid,pid:process.pid})",\n      "let orphanPublished=false",\n      "setInterval(()=>{if(!orphanPublished&&process.ppid!==originalPpid){orphanPublished=true;publish(orphanReadyPath,{currentPpid:process.ppid,originalPpid,pid:process.pid})}if(existsSync(stopPath))process.exit(0)},25)",\n    ].join(";");\n    const commandSource = [\n      \'const {existsSync,readFileSync}=require("node:fs")\',\n      \'const {spawn}=require("node:child_process")\',\n      "const controlRoot=process.env.ESBLA_BROWSER_CONTROL_ROOT",\n      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",\n      \'const retainedPath=controlRoot+"/harness.retained"\',\n      \'const retainedExpected="nonce="+nonce+"\\\\npid="+process.pid+"\\\\n"\',\n      `const startPath=${JSON.stringify(startPath)}`,\n      `const handlerReadyPath=${JSON.stringify(handlerReadyPath)}`,\n      `const fixtureSource=${JSON.stringify(fixtureSource)}`,\n      \'let retainedBytes;for(let attempt=0;attempt<800&&retainedBytes===undefined;attempt++){try{retainedBytes=readFileSync(retainedPath,"utf8")}catch(error){if(error?.code!=="ENOENT")throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)}}\',\n      \'if(retainedBytes!==retainedExpected)throw new Error("exact harness retention was not published")\',\n      "for(let attempt=0;attempt<800&&!existsSync(startPath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",\n      \'if(!existsSync(startPath))throw new Error("private start was not published")\',\n      \'const fixture=spawn(process.execPath,["-e",fixtureSource],{detached:true,stdio:["ignore",1,2]})\',\n      "fixture.unref()",\n      "for(let attempt=0;attempt<800&&!existsSync(handlerReadyPath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",\n      \'if(!existsSync(handlerReadyPath))throw new Error("fixture handler readiness was not published")\',\n      "process.exit(0)",\n    ].join(";");',
    ordinaryGroup:
      '    const readyPath = join(root, "ready.json");\n    const source = [\n      \'const {spawnSync}=require("node:child_process")\',\n      \'const {writeFileSync}=require("node:fs")\',\n      \'const identity=(pid)=>spawnSync("ps",["-o","pid=,pgid=","-p",String(pid)],{encoding:"utf8"}).stdout.trim().split(/\\\\s+/).map(Number)\',\n      `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({child:identity(process.pid),parent:identity(process.ppid)}))`,\n      "process.exit(0)",\n    ].join(";");',
    forwardedSignal:
      '      const readyPath = join(root, "ready.json");\n      const descendant =\n        \'process.on("SIGINT",()=>process.exit(0));process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)\';\n      const source = [\n        \'const {spawn}=require("node:child_process")\',\n        \'const {writeFileSync}=require("node:fs")\',\n        `const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{detached:false,stdio:"ignore"})`,\n        \'process.on("SIGINT",()=>process.exit(0))\',\n        \'process.on("SIGTERM",()=>process.exit(0))\',\n        `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({leader:process.pid,grandchild:child.pid}))`,\n        "setInterval(()=>{},1000)",\n      ].join(";");',
    doubleSignal:
      '    const realSuiteRoot = await realpath(wrapperTemporaryRoot);\n    const root = await mkdtemp(join(realSuiteRoot, "double-signal-contract-"));\n    const rootOwned = captureOwnedDirectory(root, "double-signal contract root");\n    const readyPath = join(root, "ready.json");\n    const stopPath = join(root, "grandchild.stop");\n    const resistant = [\n      \'const {existsSync}=require("node:fs")\',\n      `const stopPath=${JSON.stringify(stopPath)}`,\n      \'process.on("SIGINT",()=>{})\',\n      \'process.on("SIGTERM",()=>{})\',\n      "setInterval(()=>{if(existsSync(stopPath))process.exit(0)},25)",\n    ].join(";");\n    const source = [\n      \'const {spawn}=require("node:child_process")\',\n      \'const {existsSync,writeFileSync}=require("node:fs")\',\n      `const stopPath=${JSON.stringify(stopPath)}`,\n      `const child=spawn(process.execPath,["-e",${JSON.stringify(resistant)}],{detached:false,stdio:"ignore"})`,\n      \'process.on("SIGTERM",()=>{})\',\n      `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({leader:process.pid,grandchild:child.pid}))`,\n      "setInterval(()=>{if(existsSync(stopPath))process.exit(0)},25)",\n    ].join(";");',
    preRegistration:
      '      const launchMarker = join(caseRoot, "launch-intent.json");\n      const execMarker = join(caseRoot, "browser-exec.json");\n      const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");\n      const source = [\n        \'const {linkSync,unlinkSync,writeFileSync}=require("node:fs")\',\n        \'const {createRequire}=require("node:module")\',\n        `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,\n        \'const {chromium}=requirePlaywright("@playwright/test")\',\n        "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",\n        "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",\n        \'const tmp=root+"/.intent."+process.pid\',\n        \'writeFileSync(tmp,"nonce="+nonce+"\\\\npid="+process.pid+"\\\\n",{flag:"wx",mode:0o600})\',\n        \'linkSync(tmp,root+"/browser.intent")\',\n        "unlinkSync(tmp)",\n        `writeFileSync(${JSON.stringify(launchMarker)},JSON.stringify({launched:true}))`,\n        "process.env.TMPDIR=process.env.ESBLA_BROWSER_PROFILE_ROOT",\n        "process.env.ESBLA_BROWSER_REAL_EXECUTABLE=chromium.executablePath()",\n        \'(async()=>{const server=await chromium.launchServer({executablePath:process.env.ESBLA_BROWSER_LAUNCHER,handleSIGHUP:false,handleSIGINT:false,handleSIGTERM:false,headless:true,host:"127.0.0.1",port:0});writeFileSync(\' +\n          JSON.stringify(execMarker) +\n          ",JSON.stringify({pid:server.process().pid}));setInterval(()=>{},1000)})()",\n      ].join(";");',
  });
  const replaceCarrierTextExactlyOnce = (body, needle, replacement) => {
    if (body.split(needle).length - 1 !== 1) {
      throw new Error("canonical executable-facade carrier drifted");
    }
    return body.replace(needle, replacement);
  };
  const greenCarrierBodies = Object.freeze({
    ...carrierBodies,
    ordinaryEnvironment: replaceCarrierTextExactlyOnce(
      carrierBodies.ordinaryEnvironment,
      '    const observedPath = join(root, "observed.json");',
      '    const root = await mkdtemp(join(tmpdir(), "esbla-ordinary-wrapper-"));\n    const observedPath = join(root, "observed.json");',
    ),
    launchIntent: replaceCarrierTextExactlyOnce(
      carrierBodies.launchIntent,
      '    const readyPath = join(caseRoot, "ready.json");',
      '    const beforeBrowserRoots = await browserTemporaryDirectories();\n    const beforePostgresRoots = await postgresTemporaryDirectories();\n    const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "intent-crash-"));\n    const readyPath = join(caseRoot, "ready.json");',
    ),
    listenRejection: replaceCarrierTextExactlyOnce(
      carrierBodies.listenRejection,
      "    const { port, server } = await listenOnEphemeralPort();",
      "    const beforeBrowserRoots = await browserTemporaryDirectories();\n    const beforePostgresRoots = await postgresTemporaryDirectories();\n    const { port, server } = await listenOnEphemeralPort();",
    ),
    ordinaryGroup: replaceCarrierTextExactlyOnce(
      replaceCarrierTextExactlyOnce(
        carrierBodies.ordinaryGroup,
        '    const readyPath = join(root, "ready.json");',
        '    const before = await postgresTemporaryDirectories();\n    const root = await mkdtemp(join(tmpdir(), "esbla-ordinary-group-contract-"));\n    const readyPath = join(root, "ready.json");',
      ),
      'spawnSync("ps",["-o","pid=,pgid=","-p",String(pid)],{encoding:"utf8"})',
      'spawnSync("/bin/ps",["-o","pid=,pgid=","-p",String(pid)],{encoding:"utf8",timeout:1_000})',
    ),
    forwardedSignal: replaceCarrierTextExactlyOnce(
      carrierBodies.forwardedSignal,
      '      const readyPath = join(root, "ready.json");',
      '      const before = await postgresTemporaryDirectories();\n      const root = await mkdtemp(join(tmpdir(), "esbla-signal-contract-"));\n      const readyPath = join(root, "ready.json");',
    ),
    doubleSignal: replaceCarrierTextExactlyOnce(
      carrierBodies.doubleSignal,
      "    const realSuiteRoot = await realpath(wrapperTemporaryRoot);",
      "    const before = await postgresTemporaryDirectories();\n    const beforeBrowserRoots = await browserTemporaryDirectories();\n    const realSuiteRoot = await realpath(wrapperTemporaryRoot);",
    ),
    preRegistration: replaceCarrierTextExactlyOnce(
      carrierBodies.preRegistration,
      '      const launchMarker = join(caseRoot, "launch-intent.json");',
      '      const beforeBrowserRoots = await browserTemporaryDirectories();\n      const beforePostgresRoots = await postgresTemporaryDirectories();\n      const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "pre-ack-browser-"));\n      const launchMarker = join(caseRoot, "launch-intent.json");',
    ),
    retainedPipe: replaceCarrierTextExactlyOnce(
      carrierBodies.retainedPipe,
      '    const startPath = join(caseRoot, "start");',
      '    const beforePostgresRoots = await postgresTemporaryDirectories();\n    const beforeBrowserRoots = await browserTemporaryDirectories();\n    const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "red-f-retained-pipe-"));\n    const caseRootOwned = captureOwnedDirectory(await realpath(caseRoot), "Red F retained-pipe root");\n    const startPath = join(caseRoot, "start");',
    ),
    runAbruptHarnessCrashCase: replaceCarrierTextExactlyOnce(
      replaceCarrierTextExactlyOnce(
        replaceCarrierTextExactlyOnce(
          carrierBodies.runAbruptHarnessCrashCase,
          '    \'const identity=(pid)=>{const p=spawnSync("ps",["-ww","-o","pid=,ppid=,pgid=,sess=,uid=,lstart=,command=","-p",String(pid)],{encoding:"utf8"}).stdout.trim().split(/\\\\s+/);return{pid:Number(p[0]),ppid:Number(p[1]),pgid:Number(p[2]),session:Number(p[3]),uid:Number(p[4]),start:p.slice(5,10).join(" "),command:p.slice(10).join(" ")}}\',',
          '    \'const parseIdentity=(line)=>{const p=line.trim().split(/\\\\s+/);return{pid:Number(p[0]),ppid:Number(p[1]),pgid:Number(p[2]),session:Number(p[3]),uid:Number(p[4]),start:p.slice(5,10).join(" "),command:p.slice(10).join(" ")}}\',\n    \'const identity=(pid)=>parseIdentity(spawnSync("/bin/ps",["-ww","-o","pid=,ppid=,pgid=,sess=,uid=,lstart=,command=","-p",String(pid)],{encoding:"utf8",timeout:1_000}).stdout)\',\n    \'const identities=()=>spawnSync("/bin/ps",["-ww","-axo","pid=,ppid=,pgid=,sess=,uid=,lstart=,command="],{encoding:"utf8",timeout:1_000}).stdout.trim().split("\\\\n").filter(Boolean).map(parseIdentity)\',',
        ),
        '    "const browserPid=server.process().pid",',
        '    "const browserPid=server.process().pid",\n    "const realExecutable=chromium.executablePath()",\n    \'const realChildren=identities().filter((candidate)=>candidate.ppid===browserPid&&candidate.pgid===browserPid&&(candidate.command===realExecutable||candidate.command.startsWith(realExecutable+" ")))\',\n    \'if(realChildren.length!==1)throw new Error("Exact direct Chromium child is ambiguous")\',',
      ),
      '    "const ready={ackPid:Number(ack.pid),browser:identity(browserPid),controlRoot,fd5:{dev:String(fd5.dev),ino:String(fd5.ino)},harness:identity(process.pid),profileRoot}",',
      '    "const ready={ackPid:Number(ack.pid),browser:identity(browserPid),chromium:realChildren[0],controlRoot,fd5:{dev:String(fd5.dev),ino:String(fd5.ino)},harness:identity(process.pid),profileRoot,realExecutable}",',
    ),
    runRealBrowserSignalCase: replaceCarrierTextExactlyOnce(
      carrierBodies.runRealBrowserSignalCase,
      'spawnSync("ps",["-o","pgid=","-p",String(browserPid)],{encoding:"utf8"})',
      'spawnSync("/bin/ps",["-o","pgid=","-p",String(browserPid)],{encoding:"utf8",timeout:1_000})',
    ),
  });
  const malformedOwner = canonicalTopLevelFunctionText(
    canonicalSanitizerOrderingSource(),
    "runMalformedCancellationIsolationCase",
  );
  const maliciousOwner = canonicalTopLevelFunctionText(
    canonicalMaliciousDeadlineSource(),
    "runMaliciousRegistrationCase",
  );
  const realBrowserPreCallEnvelope = canonicalRealBrowserFacadePreCallEnvelopeSource(
    greenCarrierBodies.runRealBrowserSignalCase,
  );
  const abruptHarnessPreCallEnvelope = canonicalAbruptHarnessFacadePreCallEnvelopeSource(
    greenCarrierBodies.runAbruptHarnessCrashCase,
  );
  const abruptHarnessTry = canonicalAbruptHarnessFacadeTrySource();
  return [
    'import {after,describe,it} from "node:test";',
    canonicalSignalContractSource().replace(syntheticAbruptHarnessProgram(undefined), ""),
    canonicalExecutableFacadeDefinitionsSource(),
    `async function runRealBrowserSignalCase(signal,secondSignal=false){${realBrowserPreCallEnvelope}\ntry{wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source])}finally{}}`,
    `async function runAbruptHarnessCrashCase(){${abruptHarnessPreCallEnvelope}\ntry{${abruptHarnessTry}}finally{}}`,
    malformedOwner,
    maliciousOwner,
    'describe("HR browser harness contracts",()=>{',
    'it("cleans PostgreSQL on child success, failure, and spawn error",{timeout:90_000},async()=>{const success=await childOutcome(spawnPostgresWrapper(process.execPath,["-e","process.exit(0)"]));const failure=await childOutcome(spawnPostgresWrapper(process.execPath,["-e","process.exit(7)"]));const spawnError=await childOutcome(spawnPostgresWrapper(join(tmpdir(),"esbla-command-that-does-not-exist")));void success;void failure;void spawnError});',
    `it("keeps ordinary PostgreSQL-wrapper children free of browser-control environment",{timeout:45_000},async()=>{${greenCarrierBodies.ordinaryEnvironment}\ntry{const child=spawnOwnedWrapperController(process.execPath,["-e",source],{ESBLA_BROWSER_CONTROL_NONCE:"ambient-nonce",ESBLA_BROWSER_CONTROL_ROOT:"/tmp/ambient-control",ESBLA_BROWSER_REAL_EXECUTABLE:"/tmp/ambient-browser"},{superviseBrowser:false});void child}finally{}});`,
    'it("removes supervised control and profile roots when setup fails before PostgreSQL",async()=>{const wrapper=spawnOwnedWrapperController(process.execPath,["-e","process.exit(0)"],{PATH:"/usr/bin:/bin"},{superviseBrowser:true});void wrapper});',
    `it("cancels launch intent when the harness crashes before launcher spawn",{timeout:60_000},async()=>{${greenCarrierBodies.launchIntent}\ntry{const wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source]);void wrapper}finally{}});`,
    `it("V1C3-AUDIT-002 retains roots for a no-intent detached exact launcher",{timeout:90_000},async()=>{${carrierBodies.audit002}\ntry{const wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source]);void wrapper}catch(error){}finally{}});`,
    `it("V1C3-AUDIT-004 rejects multiply-linked cancellation and retains roots",{timeout:90_000},async()=>{${carrierBodies.audit004}\ntry{const wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source]);void wrapper}catch(error){}finally{}});`,
    `it("cleans owned state when BrowserServer listen is rejected",{timeout:90_000},async()=>{${greenCarrierBodies.listenRejection}\ntry{const wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source]);void wrapper}finally{}});`,
    `it("Red F bounds finish after the wrapper exits while an owned fixture retains its pipes",{timeout:150_000},async()=>{${greenCarrierBodies.retainedPipe}\nconst controller=spawnSupervisedPostgresWrapper(process.execPath,["-e",commandSource]);void controller});`,
    `it("preserves the ordinary wrapper's inherited process-group behavior",{timeout:45_000},async()=>{${greenCarrierBodies.ordinaryGroup}\ntry{const wrapper=spawnPostgresWrapper(process.execPath,["-e",source]);void wrapper}finally{}});`,
    `for(const signal of ["SIGINT","SIGTERM"]){it(\`forwards \${signal}, drains the complete child group, and preserves signal exit semantics\`,{timeout:45_000},async()=>{${greenCarrierBodies.forwardedSignal}\nlet wrapper;try{wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source])}finally{}})}`,
    `it("a second signal immediately escalates a resistant child group",{timeout:45_000},async()=>{${greenCarrierBodies.doubleSignal}\nlet wrapper;try{wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source])}catch(error){}finally{}});`,
    `for(const signal of ["SIGINT","SIGTERM"]){it(\`cancels a real BrowserServer launch before registration on \${signal}\`,{timeout:90_000},async()=>{${greenCarrierBodies.preRegistration}\nlet wrapper;try{wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source],{ESBLA_BROWSER_TEST_PRE_REGISTRATION_DELAY_MS:"800"})}finally{}})}`,
    'for(const [label,signal,secondSignal] of [["single SIGINT","SIGINT",false,false],["single SIGTERM","SIGTERM",false,false],["second-signal escalation","SIGTERM",true,false]]){it(`owns a real detached Chromium group and profile through ${label}`,{timeout:90_000},async()=>await runRealBrowserSignalCase(signal,secondSignal))}',
    'it("owns and drains real Chromium after exact parent-delivered post-ACK harness SIGKILL",{timeout:90_000},runAbruptHarnessCrashCase);',
    "})",
  ].join("\n");
}

function syntheticSignalMutationSource(kind) {
  const canonical = canonicalSignalContractSource();
  const canonicalAbruptProgram = syntheticAbruptHarnessProgram(undefined);
  const canonicalAbruptBoundarySequence =
    'assertRelation();const boundary=assertRelation();process.kill(boundary.harness.pid,"SIGKILL")';
  const replaceCanonicalAbruptProgramExactlyOnce = (replacement) => {
    if (
      canonical.split(canonicalAbruptProgram).length - 1 !== 1 ||
      replacement === canonicalAbruptProgram
    ) {
      throw new Error("canonical abrupt signal carrier mutation was not exact-once");
    }
    return canonical.replace(canonicalAbruptProgram, replacement);
  };
  const mutateAbruptBoundarySequence = (replacement) => {
    if (canonicalAbruptProgram.split(canonicalAbruptBoundarySequence).length - 1 !== 1) {
      throw new Error("canonical abrupt signal carrier drifted");
    }
    return replaceCanonicalAbruptProgramExactlyOnce(
      canonicalAbruptProgram.replace(canonicalAbruptBoundarySequence, replacement),
    );
  };
  const mutateAbruptRelationCarrier = (omission) => {
    const carrier = sealedAbruptRelationCarrierManifest().find(({ key }) => key === omission);
    if (!carrier || canonicalAbruptProgram.split(carrier.statement).length - 1 !== 1) {
      throw new Error("unknown abrupt relation carrier omission");
    }
    const replacement = syntheticAbruptHarnessProgram(omission);
    if (replacement.includes(carrier.statement)) {
      throw new Error("abrupt relation carrier omission was not exact-once");
    }
    return replaceCanonicalAbruptProgramExactlyOnce(replacement);
  };
  if (kind === "parse ambiguity") return "const broken =";
  if (kind === "computed access") {
    return `${canonical}\nconst syntheticKillMember="kill";process[syntheticKillMember](1,"SIGTERM");`;
  }
  if (kind === "internal kill access") {
    return `${canonical}\nprocess._kill(424242,"SIGTERM");`;
  }
  if (kind === "opaque computed access") {
    return `${canonical}\nprocess[JSON.parse('"kill"')](1,"SIGTERM");`;
  }
  if (kind === "optional access") {
    return `${canonical}\nprocess?.kill?.(1,"SIGTERM");`;
  }
  if (kind === "aliased access") {
    return `${canonical}\nconst terminate=process.kill;terminate(1,"SIGTERM");`;
  }
  if (kind === "reflected access") {
    return `${canonical}\nReflect.get(process,"kill")(1,"SIGTERM");`;
  }
  if (kind === "aliased reflected access") {
    return `${canonical}\nconst syntheticReflectGet=Reflect.get;syntheticReflectGet(process,"kill")(1,"SIGTERM");`;
  }
  if (kind === "destructured reflected access") {
    return `${canonical}\nconst {get:syntheticReflectGet}=Reflect;syntheticReflectGet(process,"kill")(1,"SIGTERM");`;
  }
  if (kind === "process binding shadow") {
    return `${canonical}\nconst process=makeSyntheticProcess();void process;`;
  }
  if (kind === "counterfeit process identity helper") {
    return canonical.replace(
      canonicalSignalHelperSemanticSource("sameProcessIdentity"),
      "function sameProcessIdentity(){return true}",
    );
  }
  if (kind === "counterfeit stable identity helper") {
    return canonical.replace(
      canonicalSignalHelperSemanticSource("captureStableProcessIdentity"),
      "function captureStableProcessIdentity(pid){return {pid}}",
    );
  }
  if (kind === "global process replacement") {
    return `${canonical}\nglobalThis.process=makeSyntheticProcess();`;
  }
  if (kind === "aliased global process replacement") {
    return `${canonical}\nconst syntheticGlobal=globalThis;syntheticGlobal.process=makeSyntheticProcess();`;
  }
  if (kind === "aliased object mutator") {
    return `${canonical}\nconst syntheticAssign=Object.assign;syntheticAssign(globalThis,{process:makeSyntheticProcess()});`;
  }
  if (kind === "destructured conditional object mutator") {
    return `${canonical}\nconst {assign:syntheticAssign}=(true?Object:Object);syntheticAssign(globalThis,{process:makeSyntheticProcess()});`;
  }
  if (kind === "projected object mutator") {
    return `${canonical}\nconst syntheticAssign=({value:Object.assign}).value;syntheticAssign(globalThis,{process:makeSyntheticProcess()});`;
  }
  if (kind === "computed destructured object mutator") {
    return `${canonical}\nconst {[JSON.parse('"assign"')]:syntheticAssign}=Object;syntheticAssign(globalThis,{process:makeSyntheticProcess()});`;
  }
  if (kind === "assigned destructured object mutator") {
    return `${canonical}\nlet syntheticAssign;({assign:syntheticAssign}=Object);syntheticAssign(globalThis,{process:makeSyntheticProcess()});`;
  }
  if (kind === "array-assigned object mutator") {
    return `${canonical}\nlet syntheticAssign;[syntheticAssign]=[Object.assign];syntheticAssign(globalThis,{process:makeSyntheticProcess()});`;
  }
  if (kind === "member-stored object mutator") {
    return `${canonical}\nconst syntheticHolder={};syntheticHolder.assign=Object.assign;syntheticHolder.assign(globalThis,{process:makeSyntheticProcess()});`;
  }
  if (kind === "logical-assigned object mutator") {
    return `${canonical}\nlet syntheticAssign;syntheticAssign||=Object.assign;syntheticAssign(globalThis,{process:makeSyntheticProcess()});`;
  }
  if (kind === "call-bound evaluator") {
    return `${canonical}\nconst syntheticEvaluator=globalThis.eval.call.bind(globalThis.eval);syntheticEvaluator(null,"void 0");`;
  }
  if (kind === "aliased assert authority") {
    return `${canonical}\nconst syntheticAssert=assert;syntheticAssert.ok=()=>{};`;
  }
  if (kind === "sequence-wrapped assert authority") {
    return `${canonical}\nconst syntheticAssert=(0,assert);syntheticAssert.ok=()=>{};`;
  }
  if (kind === "logical-wrapped assert authority") {
    return `${canonical}\nconst syntheticAssert=true&&assert;syntheticAssert.ok=()=>{};`;
  }
  if (kind === "awaited assert authority") {
    return `${canonical}\nconst syntheticAssert=await Promise.resolve(assert);syntheticAssert.ok=()=>{};`;
  }
  if (kind === "yielded assert authority") {
    return `${canonical}\nfunction* syntheticGenerator(){yield assert}const syntheticAssert=syntheticGenerator().next().value;syntheticAssert.ok=()=>{};`;
  }
  if (kind === "spread assert authority") {
    return `${canonical}\nlet syntheticAssert;function syntheticSink(value){syntheticAssert=value}syntheticSink(...[assert]);syntheticAssert.ok=()=>{};`;
  }
  if (kind === "defaulted assert authority") {
    return `${canonical}\nfunction syntheticFactory(value=assert){return value}const syntheticAssert=syntheticFactory();syntheticAssert.ok=()=>{};`;
  }
  if (kind === "iterated assert authority") {
    return `${canonical}\nlet syntheticAssert;for(const value of [assert])syntheticAssert=value;syntheticAssert.ok=()=>{};`;
  }
  if (kind === "thrown assert authority") {
    return `${canonical}\nlet syntheticAssert;try{throw assert}catch(value){syntheticAssert=value}syntheticAssert.ok=()=>{};`;
  }
  if (kind === "class-field assert authority") {
    return `${canonical}\nclass SyntheticHolder{static authority=assert}SyntheticHolder.authority.ok=()=>{};`;
  }
  if (kind === "tagged assert authority") {
    return `${canonical}\nlet syntheticAssert;function syntheticTag(_parts,value){syntheticAssert=value}syntheticTag\`${"${assert}"}\`;syntheticAssert.ok=()=>{};`;
  }
  if (kind === "projected assert authority") {
    return `${canonical}\nconst syntheticAssert=[assert][0];syntheticAssert.ok=()=>{};`;
  }
  if (kind === "nested projected assert authority") {
    return `${canonical}\nconst syntheticAssert=[[assert]][0][0];syntheticAssert.ok=()=>{};`;
  }
  if (kind === "callback-carried assert authority") {
    return `${canonical}\n[assert].forEach((syntheticAssert)=>{syntheticAssert.ok=()=>{}});`;
  }
  if (kind === "literal intrinsic recovery") {
    return `${canonical}\n[].__proto__.every=()=>true;`;
  }
  if (kind === "subclass intrinsic recovery") {
    return `${canonical}\nclass SyntheticSet extends Set{};const syntheticSet=Object.getPrototypeOf(SyntheticSet);syntheticSet.prototype.add=()=>{};`;
  }
  if (kind === "prototype intrinsic recovery") {
    return `${canonical}\nconst syntheticSetPrototype=Object.getPrototypeOf(new Set());syntheticSetPrototype.add=()=>{};`;
  }
  if (kind === "dynamic authority import") {
    return `${canonical}\nconst syntheticAssert=(await import("node:assert/strict")).default;syntheticAssert.ok=()=>{};`;
  }
  if (kind === "aliased builtin-module loader") {
    return `${canonical}\nconst syntheticGetBuiltin=process.getBuiltinModule;const syntheticCreateRequire=syntheticGetBuiltin("node:module").createRequire;const syntheticRequire=syntheticCreateRequire(import.meta.url);const syntheticAssert=syntheticRequire("node:assert/strict");syntheticAssert.ok=()=>{};`;
  }
  if (kind === "comma-wrapped builtin loader") {
    return `${canonical}\nconst syntheticGetBuiltin=(0,process.getBuiltinModule);syntheticGetBuiltin("node:module");`;
  }
  if (kind === "nested destructured native loaders") {
    return `${canonical}\nconst {binding:syntheticBinding,getBuiltinModule:syntheticGetBuiltin,mainModule:{require:syntheticRequire}}=process;void syntheticBinding;void syntheticGetBuiltin;void syntheticRequire;`;
  }
  if (kind === "transitive main-module loader") {
    return `${canonical}\nconst syntheticProcess=process;const syntheticMain=syntheticProcess.mainModule;const syntheticRequire=syntheticMain.require;syntheticRequire("node:child_process");`;
  }
  if (kind === "aliased intrinsic prototype") {
    return `${canonical}\nconst syntheticSetPrototype=Set.prototype;syntheticSetPrototype.add=()=>syntheticSetPrototype;`;
  }
  if (kind === "shadowed clock authority") {
    return `${canonical}\nconst Date={now:()=>0};`;
  }
  if (kind === "computed global process replacement") {
    return `${canonical}\nglobalThis[JSON.parse('"process"')]=makeSyntheticProcess();`;
  }
  if (kind === "reflected global process replacement") {
    return `${canonical}\nReflect.set(globalThis,JSON.parse('"process"'),makeSyntheticProcess());`;
  }
  if (kind === "assigned global process replacement") {
    return `${canonical}\nObject.assign(globalThis,{[JSON.parse('"process"')]:makeSyntheticProcess()});`;
  }
  if (kind === "external signal command") {
    return `${canonical}\nspawnSync("/bin/kill",["-TERM","1"]);`;
  }
  if (kind === "external signal command via call") {
    return `${canonical}\nspawnSync.call(undefined,"/bin/kill",["-TERM","1"]);`;
  }
  if (kind === "external pkill command") {
    return `${canonical}\nspawn("/usr/bin/pkill",["-TERM","synthetic-subject"]);`;
  }
  if (kind === "external shell signal command") {
    return `${canonical}\nspawnSync("/bin/sh",["-c","kill -TERM 1"]);`;
  }
  if (kind === "allowlisted probe shell") {
    return `${canonical}\nspawnSync("/bin/ps",["-p","1"],{shell:true});`;
  }
  if (kind === "unresolved external command") {
    return `${canonical}\nconst syntheticCommand=process.env.SYNTHETIC_COMMAND;spawnSync(syntheticCommand,[]);`;
  }
  if (kind === "native binding loader") {
    return `${canonical}\nprocess.binding("spawn_sync");`;
  }
  if (kind === "aliased native binding loader") {
    return `${canonical}\nconst syntheticBinding=process.binding;syntheticBinding("spawn_sync");`;
  }
  if (kind === "projected native binding loader") {
    return `${canonical}\nconst syntheticBinding=[process.binding][0];syntheticBinding("spawn_sync");`;
  }
  if (kind === "main-module require loader") {
    return `${canonical}\nconst syntheticRequire=process.mainModule.require;syntheticRequire("node:child_process");`;
  }
  if (kind === "aliased child-process import") {
    return canonical.replace(
      'import {spawn,spawnSync} from "node:child_process";',
      'import {spawn as syntheticSpawn,spawnSync} from "node:child_process";',
    );
  }
  if (kind === "static module loader import") {
    return canonical.replace(
      'import assert from "node:assert/strict";',
      'import {createRequire as syntheticCreateRequire} from "node:module";\nimport assert from "node:assert/strict";',
    );
  }
  if (kind === "counterfeit cooperative spawn owner") {
    return `${canonical}\nfunction spawnCooperativeFixture(source){spawn(process.execPath,["-e",source])}spawnCooperativeFixture("setInterval(()=>{},1000)");`;
  }
  if (kind === "counterfeit browser harness path") {
    return `${canonical}\nconst browserHarness="/tmp/synthetic-browser-harness.mjs";spawn(process.execPath,[browserHarness]);`;
  }
  if (kind === "embedded child-process command") {
    return `${canonical}\nspawn(process.execPath,["-e",'require("node:child_process").spawnSync("/bin/kill",["-TERM","1"])']);`;
  }
  if (kind === "embedded shell signal command") {
    return `${canonical}\nspawn(process.execPath,["-e",'require("node:child_process").spawnSync("/bin/sh",["-c","kill -TERM 1"])']);`;
  }
  if (kind === "projected controller ledger") {
    return `${canonical}\n[activeWrapperControllers][0].clear();`;
  }
  if (kind === "callback controller ledger") {
    return `${canonical}\nactiveWrapperControllers.forEach((_value,_same,self)=>self.clear());`;
  }
  if (kind === "called controller ledger method") {
    return `${canonical}\nactiveWrapperControllers.clear.call(activeWrapperControllers);`;
  }
  if (kind === "whitespace-obscured access") {
    return `${canonical}\nprocess /* gap */ . kill /* gap */ (1,"SIGTERM");`;
  }
  if (kind === "prefixed builder bypass") {
    return `${canonical}\nfunction syntheticBackdoor(){process.kill(1,"SIGTERM")}`;
  }
  if (kind === "prefixed aliased eval bypass") {
    return `${canonical}\nfunction syntheticBackdoor(){const execute=eval;execute('process.kill(1,"SIGTERM")')}`;
  }
  if (kind === "prefixed assigned eval bypass") {
    return `${canonical}\nfunction syntheticBackdoor(){let execute;execute=eval;execute('process.kill(1,"SIGTERM")')}`;
  }
  if (kind === "nested embedded program") {
    const deepest = 'process.kill(1,"SIGTERM")';
    const nested = `const inner=${JSON.stringify(deepest)}`;
    return `${canonical}\nconst nested=${JSON.stringify(nested)};void nested;`;
  }
  if (kind === "duplicate allowed call") {
    return canonical.replace(
      "try{process.kill(pid,0);return true}",
      "try{process.kill(pid,0);process.kill(pid,0);return true}",
    );
  }
  if (kind === "abrupt missing repeated relation") {
    return replaceCanonicalAbruptProgramExactlyOnce(syntheticAbruptHarnessProgram("repeat"));
  }
  if (kind === "abrupt missing PID equals PGID") {
    return mutateAbruptRelationCarrier("harness-leader");
  }
  if (kind === "abrupt missing FD-5") {
    return mutateAbruptRelationCarrier("fd5");
  }
  const abruptRelationCarrierPrefix = "abrupt missing relation carrier ";
  if (kind.startsWith(abruptRelationCarrierPrefix)) {
    return mutateAbruptRelationCarrier(kind.slice(abruptRelationCarrierPrefix.length));
  }
  if (kind === "abrupt unreachable branch") {
    return mutateAbruptBoundarySequence(`if(false){${canonicalAbruptBoundarySequence}}`);
  }
  if (kind === "abrupt preceding return") {
    return mutateAbruptBoundarySequence(`return;${canonicalAbruptBoundarySequence}`);
  }
  if (kind === "abrupt preceding throw") {
    return mutateAbruptBoundarySequence(
      `throw new Error("blocked");${canonicalAbruptBoundarySequence}`,
    );
  }
  if (kind === "abrupt preceding infinite loop") {
    return mutateAbruptBoundarySequence(`while(true){}${canonicalAbruptBoundarySequence}`);
  }
  if (kind === "abrupt destructured assert shadow") {
    return canonical.replace(
      "function runAbruptHarnessCrashCase(){",
      "function runAbruptHarnessCrashCase(){const {assert}=globalThis;",
    );
  }
  if (kind === "abrupt assert method replacement") {
    return canonical.replace(
      syntheticAbruptHarnessProgram(undefined),
      `assert.equal=()=>{};${syntheticAbruptHarnessProgram(undefined)}`,
    );
  }
  if (kind === "controller without immediate verification") {
    return canonical.replace(
      "    verifyOwnedWrapperImmediatelyBeforeSignal();\n    const delivered = child.kill(signalName);",
      "    const delivered = child.kill(signalName);",
    );
  }
  if (kind === "controller permits unledgered hard kill") {
    return canonical.replace(
      '    assert.ok(signalName === "SIGINT" || signalName === "SIGTERM", "unsupported wrapper signal");',
      '    assert.ok(["SIGINT","SIGTERM","SIGKILL"].includes(signalName), "unsupported wrapper signal");',
    );
  }
  if (kind === "controller drops post-spawn setup failure") {
    return canonical.replace(
      "    if (child) {\n      setupFailure = error;\n      controllerErrors.push(error);",
      "    if (child) throw error;\n    if (false) {\n      setupFailure = error;\n      controllerErrors.push(error);",
    );
  }
  if (kind === "controller delays acquisition ledger") {
    return canonical.replace(
      [
        "    controller.child = child;",
        '    acquisitionState = "acquired";',
        "    activeWrapperControllers.add(controller);",
        '    child.once("close", (code, signalName) => publishCloseOutcome(code, signalName));',
      ].join("\n"),
      [
        '    child.once("close", (code, signalName) => publishCloseOutcome(code, signalName));',
        "    controller.child = child;",
        '    acquisitionState = "acquired";',
        "    activeWrapperControllers.add(controller);",
      ].join("\n"),
    );
  }
  if (kind === "controller tolerates missing live identity") {
    return canonical.replace(
      '      throw new Error("Unable to retain owned wrapper identity");',
      "      return undefined;",
    );
  }
  if (kind === "controller restarts retention budget") {
    return canonical.replace(
      "  const retainOwnedWrapper = () => {\n    while (",
      "  const retainOwnedWrapper = () => {\n    retentionRounds = 0;\n    while (",
    );
  }
  if (kind === "controller counts retention after probes") {
    return canonical.replace(
      [
        "      retentionRounds += 1;",
        "      const first = readProcessIdentity(child.pid, 1_000);",
        "      const second = readProcessIdentity(child.pid, 1_000);",
        "      const descriptorIdentity = readProcessDescriptorIdentity(child.pid, 6);",
      ].join("\n"),
      [
        "      const first = readProcessIdentity(child.pid, 1_000);",
        "      const second = readProcessIdentity(child.pid, 1_000);",
        "      const descriptorIdentity = readProcessDescriptorIdentity(child.pid, 6);",
        "      retentionRounds += 1;",
      ].join("\n"),
    );
  }
  if (kind === "controller conflates no subject") {
    return canonical.replace(
      '    acquisitionState = "no-subject";',
      '    acquisitionState = "acquired";',
    );
  }
  if (kind === "controller loses unbound close polling") {
    return canonical.replace(
      "      return await waitForControllerCloseBefore(finishDeadline);",
      "      return await settleControllerBefore(closeOutcome, finishDeadline);",
    );
  }
  if (kind === "controller loses absolute outcome bound") {
    return canonical.replace(
      "        Math.min(Date.now() + timeoutMs, absoluteControllerDeadline),",
      "        Date.now() + timeoutMs,",
    );
  }
  if (kind === "controller skips setup termination") {
    return canonical.replace(
      '            setupTerminationRequested = signal("SIGTERM");',
      "            setupTerminationRequested = true;",
    );
  }
  if (kind === "controller caches recovery rejection") {
    return canonical.replace(
      "          finishAttempt = undefined;",
      '          if (error?.code === "ERR_WRAPPER_CLOSE_DEADLINE") finishAttempt = undefined;',
    );
  }
  if (kind === "controller drops setup recovery aggregate") {
    return canonical.replace(
      [
        "          if (setupFailure) {",
        "            throw new AggregateError(",
        "              controllerErrors.includes(error)",
        "                ? [...controllerErrors]",
        "                : [...controllerErrors, error],",
        '              "wrapper controller setup recovery failed",',
        "            );",
        "          }",
      ].join("\n"),
      "          void setupFailure;",
    );
  }
  throw new Error("unknown synthetic signal mutation");
}

function canonicalHarnessSuiteFinalizerRegistrationSource() {
  return [
    canonicalHarnessStaticImportSource(),
    'const repositoryRoot=resolve(fileURLToPath(new URL("../..",import.meta.url)));',
    'const browserHarness=join(repositoryRoot,"scripts/test/hr-browser-harness.mjs");',
    'const withPostgres=join(repositoryRoot,"scripts/test/with-postgres.mjs");',
    'const secret="browser-harness-secret-that-must-never-escape";',
    'const wrapperTemporaryRoot=await mkdtemp(join("/tmp","ebw-"));',
    "const activeWrapperControllers=new Set();",
    "const completedWrapperControllers=[];",
    "const openWrapperOwnershipDescriptors=new Set();",
    "const recordedWrapperIdentities=[];",
    "const redExpectedControllerFailures=new WeakSet();",
    "const suiteFinalizerFinishTimeoutMs=75_000;",
    'const maliciousRegistrationVariantContract=Object.freeze(["malformed","multiply-linked","wrong-nonce","wrong-nonce-resistant-harness","wrong-parent","wrong-start","wrong-record-uid","wrong-pgid","unrelated-process","leader-gone","changed-parent","executable-substring","wrong-mode","symlink"]);',
    "after(async()=>{})",
  ].join("\n");
}

function canonicalSuiteFinalizerSource() {
  return [
    'import assert from "node:assert/strict";',
    'import {spawnSync} from "node:child_process";',
    'import {closeSync} from "node:fs";',
    'import {mkdtemp,readdir,rmdir} from "node:fs/promises";',
    'import {join} from "node:path";',
    'import {after} from "node:test";',
    'const wrapperTemporaryRoot=await mkdtemp(join("/tmp","ebw-"));',
    "const activeWrapperControllers=new Set();",
    "const completedWrapperControllers=[];",
    "const openWrapperOwnershipDescriptors=new Set();",
    "const recordedWrapperIdentities=[];",
    "const suiteFinalizerFinishTimeoutMs=75_000;",
    canonicalSignalHelperSemanticSource("readProcessIdentity"),
    canonicalSignalHelperSemanticSource("sameProcessIdentity"),
    canonicalCleanupResidueAuthoritySource(false),
    "after(async()=>{",
    'const controllerResults=await Promise.allSettled([...activeWrapperControllers].map(async(controller)=>{const finishResults=await Promise.allSettled([controller.finish(suiteFinalizerFinishTimeoutMs)]);const verificationResults=await Promise.allSettled([(async()=>assert.equal(controller.phase,"finalized","suite controller did not finalize"))(),(async()=>assert.equal(controller.settled,true,"suite controller did not settle"))(),(async()=>assert.equal(activeWrapperControllers.has(controller),false,"suite controller remained active"))()]);return{finishResults,verificationResults}}));',
    'const controllerFinishResults=controllerResults.flatMap((result)=>result.status==="fulfilled"?result.value.finishResults:[]);',
    'const controllerVerificationResults=controllerResults.flatMap((result)=>result.status==="fulfilled"?result.value.verificationResults:[]);',
    "const descriptorResults=await Promise.allSettled([...openWrapperOwnershipDescriptors].map(async(descriptor)=>{closeSync(descriptor);openWrapperOwnershipDescriptors.delete(descriptor)}));",
    'const processResults=await Promise.allSettled(recordedWrapperIdentities.map(async(identity)=>assert.equal(sameProcessIdentity(identity,readProcessIdentity(identity.pid,1_000)),false,"wrapper identity remained live")));',
    "const completedResults=await Promise.allSettled(completedWrapperControllers.map(async(controller)=>{assert.equal(controller.rescueUsed,false);assert.equal(controller.hardKillUsed,false);assert.deepEqual(controller.controllerErrors,[])}));",
    "const ownedRootResults=await Promise.allSettled([(async()=>assert.deepEqual(await postgresTemporaryDirectories(),new Set()))(),(async()=>assert.deepEqual(await browserTemporaryDirectories(),new Set()))()]);",
    "const preSuiteCleanupResults=[...controllerResults,...controllerFinishResults,...controllerVerificationResults,...descriptorResults,...processResults,...completedResults,...ownedRootResults];",
    'const suiteRootResults=await Promise.allSettled(preSuiteCleanupResults.every((result)=>result.status==="fulfilled")?[(async()=>{assert.deepEqual(await readdir(wrapperTemporaryRoot),[]);await rmdir(wrapperTemporaryRoot)})()]:[]);',
    "const allResults=[...controllerResults,...controllerFinishResults,...controllerVerificationResults,...descriptorResults,...processResults,...completedResults,...ownedRootResults,...suiteRootResults];",
    'const failures=allResults.filter((result)=>result.status==="rejected");',
    'if(failures.length>0)throw new AggregateError(failures.map((failure)=>failure.reason),"suite finalization failed")',
    "})",
  ].join("\n");
}

function canonicalCleanupResidueAuthoritySource(includeEnvironment = true) {
  return [
    ...(includeEnvironment
      ? [
          'const wrapperTemporaryRoot=await mkdtemp(join("/tmp","ebw-"));',
          canonicalSignalHelperSemanticSource("exactFilesystemIdentity"),
        ]
      : []),
    'async function postgresTemporaryDirectories(){return new Set((await readdir(wrapperTemporaryRoot)).filter((name)=>name.startsWith("esbla-postgres-")))}',
    'async function browserTemporaryDirectories(){return new Set((await readdir(wrapperTemporaryRoot)).filter((name)=>name.startsWith("esbla-browser-control-")||name.startsWith("esbla-browser-profile-")))}',
    'async function assertNoOwnedResidue(beforePostgresRoots,beforeBrowserRoots){assert.deepEqual(await postgresTemporaryDirectories(),beforePostgresRoots);assert.deepEqual(await browserTemporaryDirectories(),beforeBrowserRoots);const processes=spawnSync("/bin/ps",["-ww","-axo","pid=,command="],{encoding:"utf8",timeout:1_000});if(processes.error||processes.status!==0){throw new Error("Unable to inspect owned-process residue",{cause:processes.error})}const matches=processes.stdout.split("\\n").filter((line)=>line.includes(wrapperTemporaryRoot));assert.deepEqual(matches,[],"owned process command still referenced the suite root")}',
  ].join("\n");
}

function canonicalCooperativeFixtureAcquisitionSource() {
  return [
    "function createCooperativeCloseState(){let resolveClose;const outcome=new Promise((resolveOutcome)=>{resolveClose=resolveOutcome});return{observed:false,outcome,resolveClose}}",
    'function createCooperativeFixtureSlot(label){return{acquisition:"not-attempted",child:undefined,closeBound:false,closeState:createCooperativeCloseState(),handlerReadyPath:undefined,identity:undefined,identityRetained:false,joined:false,label,rawClosed:false,receipt:undefined,sessionObservation:undefined,setupError:undefined,signalAbsent:false,signalMarkerPath:undefined,stopPath:undefined,stopPublished:false}}',
    "function publishCooperativeClose(subject,outcome){const state=subject.closeState;if(state.observed)return;state.observed=true;state.resolveClose(outcome)}",
    "function refreshCooperativeClose(subject){if(!subject.child||subject.closeState.observed)return;if(subject.child.exitCode!==null||subject.child.signalCode!==null)publishCooperativeClose(subject,{code:subject.child.exitCode,signal:subject.child.signalCode})}",
    'function observeChildClose(subject){refreshCooperativeClose(subject);if(subject.closeState.observed||subject.closeBound)return;try{subject.child.once("error",(error)=>{subject.setupError??=error});subject.child.once("close",(code,signal)=>publishCooperativeClose(subject,{code,signal}));subject.closeBound=true}catch(error){subject.setupError??=error}}',
    'async function settleCooperativeClose(subject,timeoutMs=10_000){const deadline=Date.now()+timeoutMs;while(true){refreshCooperativeClose(subject);if(subject.closeState.observed)return await subject.closeState.outcome;const remaining=deadline-Date.now();if(remaining<=0)throw new Error("cooperative fixture close exceeded its bound");const observed=await Promise.race([subject.closeState.outcome.then((value)=>({kind:"closed",value})),new Promise((resolveWait)=>setTimeout(()=>resolveWait({kind:"waiting"}),Math.min(25,remaining)))]);if(observed.kind==="closed")return observed.value}}',
    'function spawnCooperativeFixture(slot,caseRoot,label,signalEvidenceRoot=caseRoot,fixturePrivateStopRoot=caseRoot,childArguments=[],onFixtureAcquired){assert.equal(slot.acquisition,"not-attempted",`${label} fixture slot was reused`);slot.acquisition="attempting";let acquisitionHookError;try{const handlerReadyPath=join(caseRoot,`${label}.handler-ready.json`);const signalMarkerPath=join(signalEvidenceRoot,`${label}.signal-marker.txt`);const stopPath=join(fixturePrivateStopRoot,`${label}.stop`);const source=[\'const {existsSync,linkSync,unlinkSync,writeFileSync}=require("node:fs")\',`const handlerReadyPath=${JSON.stringify(handlerReadyPath)}`,`const signalMarkerPath=${JSON.stringify(signalMarkerPath)}`,`const stopPath=${JSON.stringify(stopPath)}`,\'const publish=(path,value)=>{const temporary=path+".tmp."+process.pid;writeFileSync(temporary,JSON.stringify(value),{flag:"wx",mode:0o600});linkSync(temporary,path);unlinkSync(temporary)}\',\'for(const signal of ["SIGHUP","SIGINT","SIGTERM"])process.on(signal,()=>{try{writeFileSync(signalMarkerPath,signal+"\\\\n",{flag:"a",mode:0o600})}catch{}})\',\'publish(handlerReadyPath,{pid:process.pid,ppid:process.ppid})\',\'setInterval(()=>{if(existsSync(stopPath))process.exit(0)},25)\'].join(";");slot.handlerReadyPath=handlerReadyPath;slot.signalMarkerPath=signalMarkerPath;slot.stopPath=stopPath;slot.child=spawn(process.execPath,["-e",source,...childArguments],{detached:true,stdio:"ignore"});slot.acquisition="acquired";slot.receipt=Object.freeze({child:slot.child,closeState:slot.closeState,handlerReadyPath,label,signalMarkerPath,stopPath});try{onFixtureAcquired?.(slot.receipt,slot)}catch(error){acquisitionHookError=error}observeChildClose(slot);if(acquisitionHookError)throw acquisitionHookError;return slot}catch(error){if(!acquisitionHookError)slot.setupError=error;if(!slot.child)slot.acquisition="no-subject";throw error}}',
    'async function retainCooperativeFixtureReceipt(receipt){const ready=await waitForFile(receipt.handlerReadyPath,10_000);assert.equal(ready.pid,receipt.child.pid,"cooperative fixture PID changed before retention");const identity=captureStableProcessIdentity(ready.pid);assert.equal(identity.ppid,process.pid,"cooperative fixture is not a direct child");assert.equal(identity.pid,identity.pgid,"cooperative fixture does not lead its group");const sessionObservation=readSemanticSessionObservation(identity);assert.equal(isSemanticSessionLeader(sessionObservation),true,"cooperative fixture is not a semantic session leader");return Object.freeze({...receipt,identity:Object.freeze({...identity}),sessionObservation:Object.freeze({...sessionObservation,identity:Object.freeze({...sessionObservation.identity})})})}',
    'async function retainCooperativeFixture(slot){assert.equal(slot.acquisition,"acquired",`${slot.label} fixture has no acquired subject`);observeChildClose(slot);if(slot.identityRetained)return slot;const owner=await retainCooperativeFixtureReceipt(slot.receipt);slot.identity=owner.identity;slot.sessionObservation=owner.sessionObservation;slot.identityRetained=true;return slot}',
    'async function publishCooperativeFixtureStop(slot){if(["not-attempted","no-subject"].includes(slot.acquisition))return{kind:"absent"};assert.equal(slot.acquisition,"acquired",`${slot.label} fixture acquisition is ambiguous`);assert.ok(slot.stopPath,`${slot.label} fixture stop path missing`);await writePrivateStop(slot.stopPath);slot.stopPublished=true;return{kind:"published"}}',
    'async function joinCooperativeFixture(slot){if(["not-attempted","no-subject"].includes(slot.acquisition))return{kind:"absent"};assert.equal(slot.acquisition,"acquired",`${slot.label} fixture acquisition is ambiguous`);observeChildClose(slot);assert.equal(slot.stopPublished,true,`${slot.label} fixture private stop was not published`);const outcome=await settleCooperativeClose(slot,10_000);assert.deepEqual(outcome,{code:0,signal:null});slot.rawClosed=true;assert.equal(await pathExists(slot.signalMarkerPath),false,"cooperative fixture was signaled");slot.signalAbsent=true;if(slot.identityRetained){await waitForExactProcessExit(slot.identity,10_000);assert.equal(sameProcessIdentity(slot.identity,readProcessIdentity(slot.identity.pid,1_000)),false,"cooperative fixture retained its exact identity")}slot.joined=true;return{identity:slot.identity,kind:slot.identityRetained?"joined":"closed-unretained",outcome}}',
  ].join("\n");
}

function canonicalMalformedFixtureCleanupSource() {
  return [
    'import assert from "node:assert/strict";',
    'import {spawn,spawnSync} from "node:child_process";',
    'import {randomUUID} from "node:crypto";',
    'import {closeSync,fstatSync,openSync,statSync,unlinkSync} from "node:fs";',
    'import {access,mkdtemp,readdir,readFile,realpath,writeFile} from "node:fs/promises";',
    'import {join,resolve} from "node:path";',
    'import {fileURLToPath} from "node:url";',
    'import {withTimeout} from "./hr-browser-harness.mjs";',
    'import {captureOwnedDirectory,cleanupExactOwnedDirectories} from "./with-postgres.mjs";',
    canonicalOwnedControllerEnvironmentSource(),
    "const activeWrapperControllers=new Set();",
    "const completedWrapperControllers=[];",
    "const openWrapperOwnershipDescriptors=new Set();",
    "const recordedWrapperIdentities=[];",
    canonicalSignalHelperSemanticSource("captureStableProcessIdentity"),
    canonicalProbeSignalSource(),
    canonicalOwnedControllerLifecycleSource(),
    canonicalCleanupResidueAuthoritySource(false),
    canonicalSignalHelperSemanticSource("readSemanticSessionObservation"),
    canonicalSignalHelperSemanticSource("isSemanticSessionLeader"),
    canonicalWaitForFileSource(),
    canonicalWaitForPathSource(),
    'async function writePrivateStop(path){try{await writeFile(path,"stop\\n",{flag:"wx",mode:0o600})}catch(error){if(error?.code!=="EEXIST")throw error}}',
    'async function waitForExactProcessExit(identity,timeoutMs=10_000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const current=readProcessIdentity(identity.pid);if(!current||!sameProcessIdentity(identity,current))return;await new Promise((resolveWait)=>setTimeout(resolveWait,25))}throw new Error("owned cooperative fixture retained its exact identity")}',
    'async function pathExists(path){try{await access(path);return true}catch(error){if(error?.code==="ENOENT")return false;throw error}}',
    canonicalCooperativeFixtureAcquisitionSource(),
    "async function runMalformedCancellationIsolationCase({afterFixtureIdentityCapture,beforeControllerAcquisition,fixturePrivateStopRoot,fixtureSignalEvidenceRoot,onCaseRootAcquired,onFixtureAcquired,onFixturesCreated}={}){",
    "const beforePostgresRoots=await postgresTemporaryDirectories();",
    "const beforeBrowserRoots=await browserTemporaryDirectories();",
    'const fixtureSlots=[createCooperativeFixtureSlot("claimed"),createCooperativeFixtureSlot("sentinel")];',
    'let caseRoot;let caseRootOwned;let claimed;let sentinel;let controller;let controllerAcquisition="not-attempted";let controlOwned;let profileOwned;let proof;',
    "let hasPrimaryFailure=false;let primaryFailure;const cleanupFailures=[];",
    "try{",
    'caseRoot=await mkdtemp(join(wrapperTemporaryRoot,"malformed-case-"));',
    'caseRootOwned=captureOwnedDirectory(await realpath(caseRoot),"malformed case root");',
    "await onCaseRootAcquired?.({caseRoot,caseRootOwned});",
    'spawnCooperativeFixture(fixtureSlots[0],caseRoot,"claimed",fixtureSignalEvidenceRoot??caseRoot,fixturePrivateStopRoot??caseRoot,[],onFixtureAcquired);',
    'spawnCooperativeFixture(fixtureSlots[1],caseRoot,"sentinel",fixtureSignalEvidenceRoot??caseRoot,fixturePrivateStopRoot??caseRoot,[],onFixtureAcquired);',
    "await onFixturesCreated?.({caseRoot,fixtures:fixtureSlots});",
    "claimed=await retainCooperativeFixture(fixtureSlots[0]);await afterFixtureIdentityCapture?.(claimed);",
    "sentinel=await retainCooperativeFixture(fixtureSlots[1]);await afterFixtureIdentityCapture?.(sentinel);",
    'assert.equal(isSemanticSessionLeader(claimed.sessionObservation),true,"retained semantic session-leader evidence is invalid");',
    'assert.equal(isSemanticSessionLeader(sentinel.sessionObservation),true,"retained semantic session-leader evidence is invalid");',
    "await beforeControllerAcquisition?.();",
    'const readyPath=join(caseRoot,"ready.json");',
    'const harnessTermMarker=join(caseRoot,"harness-term.txt");',
    'const playwrightPackage=join(repositoryRoot,"scripts/test/browser-tooling/package.json");',
    canonicalMalformedProgramSourceDeclaration(),
    'controllerAcquisition="attempting";',
    'try{controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});controllerAcquisition=controller.phase}catch(error){controllerAcquisition="no-subject";throw error}',
    "}catch(error){hasPrimaryFailure=true;primaryFailure=error}finally{",
    'const ownerResults=await Promise.allSettled(fixtureSlots.map(async(slot)=>{if(["not-attempted","no-subject"].includes(slot.acquisition))return{kind:"absent"};const owner=await retainCooperativeFixture(slot);return{kind:"owned",owner}}));',
    "const stopPublicationResults=await Promise.allSettled(fixtureSlots.map((slot)=>publishCooperativeFixtureStop(slot)));",
    'const controllerResults=await Promise.allSettled([(async()=>{if(["not-attempted","no-subject"].includes(controllerAcquisition)){assert.equal(controller,undefined);return{finishResults:[],kind:"absent",verificationResults:[]}}assert.ok(controller,"controller handle missing after acquisition");const identity=controller.identity;const finishResults=await Promise.allSettled([controller.finish(75_000)]);const verificationResults=await Promise.allSettled([(async()=>assert.equal(controller.phase,"finalized","controller did not finalize"))(),(async()=>assert.equal(controller.settled,true,"controller did not settle"))(),(async()=>assert.equal(activeWrapperControllers.has(controller),false,"controller remained active"))(),(async()=>{if(identity)assert.equal(sameProcessIdentity(identity,readProcessIdentity(identity.pid,1_000)),false,"controller exact identity remained live")})()]);return{finishResults,kind:"finished",verificationResults}})()]);',
    "const exactJoinResults=await Promise.allSettled(fixtureSlots.map((slot)=>joinCooperativeFixture(slot)));",
    'const exactFixtureFinalizationFulfilled=fixtureSlots.length===2&&ownerResults.length===2&&stopPublicationResults.length===2&&exactJoinResults.length===2&&fixtureSlots.every((slot,index)=>{const owner=ownerResults[index];const stop=stopPublicationResults[index];const join=exactJoinResults[index];if(["not-attempted","no-subject"].includes(slot.acquisition))return(!slot.child&&owner.status==="fulfilled"&&owner.value.kind==="absent"&&stop.status==="fulfilled"&&stop.value.kind==="absent"&&join.status==="fulfilled"&&join.value.kind==="absent");return(slot.acquisition==="acquired"&&slot.stopPublished&&slot.rawClosed&&slot.signalAbsent&&slot.joined&&["fulfilled","rejected"].includes(owner.status)&&stop.status==="fulfilled"&&stop.value.kind==="published"&&join.status==="fulfilled"&&["joined","closed-unretained"].includes(join.value.kind))});',
    'const exactControllerFinalizationFulfilled=controllerResults.length===1&&controllerResults[0].status==="fulfilled"&&controllerResults[0].value.kind===(["not-attempted","no-subject"].includes(controllerAcquisition)?"absent":"finished")&&controllerResults[0].value.verificationResults.every((result)=>result.status==="fulfilled");',
    'const everyAcquiredFixtureClosed=fixtureSlots.every((slot)=>["not-attempted","no-subject"].includes(slot.acquisition)||(slot.acquisition==="acquired"&&slot.rawClosed&&slot.signalAbsent&&slot.joined));',
    'const ownedRootResults=await Promise.allSettled(exactControllerFinalizationFulfilled?[(async()=>{const roots=[controlOwned,profileOwned].filter((owned)=>Boolean(owned));if(roots.length===0)return{kind:"absent"};await cleanupExactOwnedDirectories(roots);return{kind:"cleaned"}})()]:[]);',
    'const caseRootResults=await Promise.allSettled(everyAcquiredFixtureClosed&&exactControllerFinalizationFulfilled?[(async()=>{if(caseRoot===undefined){assert.equal(caseRootOwned,undefined);return{kind:"absent"}}assert.ok(caseRootOwned,"case-root capability missing");await cleanupExactOwnedDirectories([caseRootOwned]);return{kind:"cleaned"}})()]:[]);',
    'const residueResults=await Promise.allSettled([(async()=>{await assertNoOwnedResidue(beforePostgresRoots,beforeBrowserRoots);if(caseRoot!==undefined)assert.equal(await pathExists(caseRoot),false,"malformed case root remained");return{kind:"clean"}})()]);',
    'const controllerFinishResults=controllerResults.flatMap((result)=>result.status==="fulfilled"?result.value.finishResults:[]);',
    'const controllerVerificationResults=controllerResults.flatMap((result)=>result.status==="fulfilled"?result.value.verificationResults:[]);',
    "const allCleanupResults=[...ownerResults,...stopPublicationResults,...controllerResults,...controllerFinishResults,...controllerVerificationResults,...exactJoinResults,...ownedRootResults,...caseRootResults,...residueResults];",
    'cleanupFailures.push(...allCleanupResults.filter((result)=>result.status==="rejected").map((result)=>result.reason),...fixtureSlots.filter((slot)=>Boolean(slot.setupError)).map((slot)=>slot.setupError),...(!exactFixtureFinalizationFulfilled?[new Error("exact fixture finalization was incomplete")]:[]),...(!exactControllerFinalizationFulfilled?[new Error("exact controller finalization was incomplete")]:[]));',
    "}",
    'if(cleanupFailures.length>0){throw new AggregateError([...(hasPrimaryFailure?[primaryFailure]:[]),...cleanupFailures],"Red F isolation cleanup was incomplete")}',
    "if(hasPrimaryFailure)throw primaryFailure;",
    "return proof",
    "}",
  ].join("\n");
}

function canonicalMaliciousVariantProgramStatements() {
  return [
    'const {linkSync,symlinkSync,unlinkSync,writeFileSync}=require("node:fs")',
    "@@VARIANT@@",
    "@@CLAIMED@@",
    "@@SENTINEL@@",
    "@@REAL@@",
    "let browser=claimed",
    "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",
    "const profile=process.env.ESBLA_BROWSER_PROFILE_ROOT",
    "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
    'const wrongNonce=(nonce[0]==="a"?"b":"a")+nonce.slice(1)',
    'const intentTmp=root+"/.intent."+process.pid',
    'writeFileSync(intentTmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
    'linkSync(intentTmp,root+"/browser.intent")',
    "unlinkSync(intentTmp)",
    'const record={version:"2",nonce,pid:String(browser.pid),ppid:String(process.pid),pgid:String(browser.pgid),session:String(browser.session),uid:String(browser.uid),start:browser.start,parent_start:claimed.start,fd3:"open",fd4:"open",fd9:"open",real:realExecutable}',
    'let body;let publication="regular";let leaderGone=false;let changedParent=false;switch(variant){case "malformed":body="malformed\\n";break;case "multiply-linked":publication="multiply-linked";break;case "wrong-nonce":record.nonce=wrongNonce;break;case "wrong-nonce-resistant-harness":process.on("SIGTERM",()=>{});record.nonce=wrongNonce;break;case "wrong-parent":record.ppid=String(process.pid+1);break;case "wrong-start":record.start="Mon Jan 01 00:00:00 2001";break;case "wrong-record-uid":record.uid=String(browser.uid+1);break;case "wrong-pgid":record.pgid=String(browser.pgid+1);break;case "unrelated-process":browser=sentinel;record.pid=String(browser.pid);record.pgid=String(browser.pgid);record.session=String(browser.session);record.uid=String(browser.uid);record.start=browser.start;break;case "leader-gone":publication="multiply-linked";leaderGone=true;break;case "changed-parent":publication="multiply-linked";changedParent=true;break;case "executable-substring":if(!claimed.command.includes(realExecutable))throw new Error("executable substring missing");break;case "wrong-mode":publication="wrong-mode";break;case "symlink":publication="symlink";break;default:throw new Error("unknown malicious registration variant")}',
    'if(body===undefined)body=["version","nonce","pid","ppid","pgid","session","uid","start","parent_start","fd3","fd4","fd9","real"].map((key)=>key+"="+record[key]).join("\\n")+"\\n"',
    'const registration=root+"/browser.registration"',
    'const held=root+"/.registration-held"',
    'if(publication==="symlink"){const target=root+"/target";writeFileSync(target,body,{mode:0o600});symlinkSync(target,registration)}else if(publication==="multiply-linked"){writeFileSync(held,body,{mode:0o600});linkSync(held,registration)}else{writeFileSync(registration,body,{mode:publication==="wrong-mode"?0o644:0o600})}',
    "@@READY@@",
    "if(changedParent)process.exit(9)",
    "setInterval(()=>{},1000)",
  ];
}

function canonicalMaliciousVariantSourceInitializer() {
  const elements = canonicalMaliciousVariantProgramStatements().map((statement) => {
    if (statement === "@@VARIANT@@") return "`const variant=${JSON.stringify(variant)}`";
    if (statement === "@@CLAIMED@@") return "`const claimed=${JSON.stringify(claimed.identity)}`";
    if (statement === "@@SENTINEL@@") {
      return "`const sentinel=${JSON.stringify(sentinel.identity)}`";
    }
    if (statement === "@@REAL@@") {
      return "`const realExecutable=${JSON.stringify(realBrowserExecutable)}`";
    }
    if (statement === "@@READY@@") {
      return "`writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({changedParent,held,leaderGone,nonce,profile,realExecutable,root,wrongNonce}))`";
    }
    return JSON.stringify(statement);
  });
  return `[${elements.join(",")}].join(";")`;
}

function canonicalWaitForFileSource() {
  return [
    "async function waitForFile(path,timeoutMs=10_000){",
    "const deadline=Date.now()+timeoutMs;",
    "while(Date.now()<deadline){",
    'try{await access(path);return JSON.parse(await readFile(path,"utf8"))}',
    "catch{await new Promise((resolveWait)=>setTimeout(resolveWait,25))}",
    "}",
    "throw new Error(`${path} was not created within ${timeoutMs}ms`)",
    "}",
  ].join("\n");
}

function canonicalWaitForPathSource() {
  return [
    "async function waitForPath(path,timeoutMs=10_000){",
    "const deadline=Date.now()+timeoutMs;",
    "while(Date.now()<deadline){",
    'try{await access(path);return;}catch(error){if(error?.code!=="ENOENT")throw error}',
    "await new Promise((resolveWait)=>setTimeout(resolveWait,25))",
    "}",
    "throw new Error(`${path} was not created within ${timeoutMs}ms`)",
    "}",
  ].join("\n");
}

function canonicalMaliciousDependencySupportSource() {
  return [
    canonicalCleanupResidueAuthoritySource(false),
    canonicalSignalHelperSemanticSource("readSemanticSessionObservation"),
    canonicalSignalHelperSemanticSource("isSemanticSessionLeader"),
    canonicalSignalHelperSemanticSource("captureStableProcessIdentity"),
    canonicalWaitForFileSource(),
    'async function waitForExactProcessExit(identity,timeoutMs=10_000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const current=readProcessIdentity(identity.pid);if(!current||!sameProcessIdentity(identity,current))return;await new Promise((resolveWait)=>setTimeout(resolveWait,25))}throw new Error("owned cooperative fixture retained its exact identity")}',
    'async function pathExists(path){try{await access(path);return true}catch(error){if(error?.code==="ENOENT")return false;throw error}}',
    'async function writePrivateStop(path){try{await writeFile(path,"stop\\n",{flag:"wx",mode:0o600})}catch(error){if(error?.code!=="EEXIST")throw error}}',
    canonicalCooperativeFixtureAcquisitionSource(),
    "async function stopAndJoinCooperativeFixture(slot){await retainCooperativeFixture(slot);await publishCooperativeFixtureStop(slot);return await joinCooperativeFixture(slot)}",
    canonicalSanitizerExclusionHelperSource(),
  ].join("\n");
}

function canonicalMaliciousCaseHelperSource() {
  return [
    "async function runMaliciousRegistrationCase(variant){",
    "const beforePostgresRoots=await postgresTemporaryDirectories();",
    "const beforeBrowserRoots=await browserTemporaryDirectories();",
    "const realSuiteRoot=await realpath(wrapperTemporaryRoot);",
    "const caseRootPrefix=`invalid-${variant.length}-${variant}-`;",
    "const caseRootNamesBefore=(await readdir(realSuiteRoot)).filter((name)=>name.startsWith(caseRootPrefix)).sort();",
    "const ownershipLedger=[];",
    "const failures=[];",
    'let caseRoot;let caseRootOwned;let claimedOwner;let sentinelOwner;let claimed;let sentinel;let ready;let controller;let result;let controllerAcquisition="not-attempted";',
    "try{",
    "caseRoot=await mkdtemp(join(realSuiteRoot,caseRootPrefix));",
    "const caseRootName=caseRoot.slice(realSuiteRoot.length+1);",
    'assert.equal(caseRootName.startsWith(caseRootPrefix),true,"malicious case-root prefix changed");',
    'assert.equal(caseRoot,join(realSuiteRoot,caseRootName),"malicious case root escaped the suite root");',
    "const resolvedCaseRoot=await realpath(caseRoot);",
    'assert.equal(resolvedCaseRoot,join(realSuiteRoot,caseRootName),"malicious case root resolved outside the suite root");',
    'caseRootOwned=captureOwnedDirectory(resolvedCaseRoot,"malicious case root");',
    'const readyPath=join(caseRoot,"ready.json");',
    "const realBrowserExecutable=browserToolingChromium.executablePath();",
    "const ownFixture=(label,extraArguments=[])=>{const owner=createCooperativeFixtureSlot(label);ownershipLedger.push(owner);spawnCooperativeFixture(owner,caseRoot,label,caseRoot,caseRoot,extraArguments);return owner};",
    'claimedOwner=ownFixture("claimed",variant==="executable-substring"?[realBrowserExecutable]:[]);',
    'sentinelOwner=ownFixture("sentinel");',
    "const retentionResults=await Promise.allSettled(ownershipLedger.map((owner)=>retainCooperativeFixture(owner)));",
    'const retentionFailures=retentionResults.filter((entry)=>entry.status==="rejected").map((entry)=>entry.reason);',
    'if(retentionFailures.length>0)throw new AggregateError(retentionFailures,"malicious fixture retention failed");',
    "claimed=claimedOwner;sentinel=sentinelOwner;",
    `const source=${canonicalMaliciousVariantSourceInitializer()};`,
    'controllerAcquisition="attempting";',
    'try{controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});controllerAcquisition=controller.phase}catch(error){controllerAcquisition="no-subject";throw error}',
    "ready=await waitForFile(readyPath,30_000);",
    "if(ready.leaderGone){await stopAndJoinCooperativeFixture(claimed);unlinkSync(ready.held)}",
    "if(ready.changedParent)unlinkSync(ready.held);",
    "const completedOutcome=await childOutcome(controller,73_000);result=completedOutcome;",
    "const completedFinish=await controller.finish(75_000);assert.deepEqual(completedFinish,completedOutcome);",
    'assert.equal(result.code,1,"malicious wrapper did not fail closed");',
    'assert.equal(result.signal,null,"malicious wrapper reported an outer signal");',
    'assert.equal(await pathExists(join(ready.root,"browser.ack")),false,"malicious registration received ACK");',
    "const trackedValues=Object.freeze([ready.root,ready.profile,ready.nonce,ready.wrongNonce,ready.realExecutable]);",
    'assert.equal(diagnosticsExcludeTrackedValues(result.stderr,trackedValues),true,"malicious diagnostics exposed protected metadata");',
    "const diagnosticPredicates=[/registration|browser/i.test(result.stderr),result.code===1,result.signal===null];",
    'assert.deepEqual(diagnosticPredicates,[true,true,true],"malicious rejection diagnostics absent");',
    'if(!claimedOwner.joined)assert.equal(sameProcessIdentity(claimed.identity,captureStableProcessIdentity(claimed.identity.pid,claimed.identity)),true,"claimed fixture identity changed");',
    'assert.equal(sameProcessIdentity(sentinel.identity,captureStableProcessIdentity(sentinel.identity.pid,sentinel.identity)),true,"sentinel fixture identity changed");',
    'assert.equal(controller.settled,true,"malicious controller did not settle");',
    'assert.equal(activeWrapperControllers.has(controller),false,"malicious controller remained active");',
    'assert.equal(controller.rescueUsed,false,"malicious controller required rescue");',
    'assert.equal(controller.hardKillUsed,false,"malicious controller required hard kill");',
    'assert.deepEqual(controller.controllerErrors,[],"malicious controller recorded errors");',
    "}catch(error){failures.push(error)}finally{",
    'const identityResults=await Promise.allSettled(ownershipLedger.map(async(owner)=>{if(["not-attempted","no-subject"].includes(owner.acquisition))return{kind:"absent"};return{kind:"owned",owner:await retainCooperativeFixture(owner)}}));',
    "const stopResults=await Promise.allSettled(ownershipLedger.map((owner)=>publishCooperativeFixtureStop(owner)));",
    "const joinResults=await Promise.allSettled(ownershipLedger.map((owner)=>joinCooperativeFixture(owner)));",
    'const controllerResults=await Promise.allSettled([(async()=>{if(["not-attempted","no-subject"].includes(controllerAcquisition)){assert.equal(controller,undefined,"controller exists without an acquired subject");return{kind:"absent"}}assert.ok(controller,"controller handle missing after acquisition");const identity=controller.identity;const finishResults=await Promise.allSettled([controller.finish(75_000)]);assert.equal(controller.phase,"finalized","malicious controller did not finalize");assert.equal(controller.settled,true,"malicious controller did not settle during finalization");assert.equal(activeWrapperControllers.has(controller),false,"malicious controller remained active after finalization");if(identity)assert.equal(sameProcessIdentity(identity,readProcessIdentity(identity.pid,1_000)),false,"malicious controller exact identity remained live");return{finishResults,kind:"finished"}})()]);',
    "const finalizationResults=[...identityResults,...controllerResults,...stopResults,...joinResults];",
    'failures.push(...finalizationResults.filter((entry)=>entry.status==="rejected").map((entry)=>entry.reason));',
    'const allJoinsFulfilled=[identityResults,stopResults,joinResults].every((results)=>results.length===ownershipLedger.length&&results.every((entry)=>entry.status==="fulfilled"))&&ownershipLedger.every((owner,index)=>{const identityResult=identityResults[index].value;const stopResult=stopResults[index].value;const joinResult=joinResults[index].value;if(["not-attempted","no-subject"].includes(owner.acquisition))return(!owner.child&&!owner.identity&&identityResult.kind==="absent"&&stopResult.kind==="absent"&&joinResult.kind==="absent");return(owner.acquisition==="acquired"&&owner.closeBound&&owner.identityRetained&&owner.stopPublished&&owner.joined&&identityResult.kind==="owned"&&identityResult.owner===owner&&stopResult.kind==="published"&&joinResult.kind==="joined"&&joinResult.identity===owner.identity&&joinResult.outcome?.code===0&&joinResult.outcome?.signal===null)});',
    'const exactControllerFinalizationFulfilled=controllerResults.length===1&&controllerResults[0].status==="fulfilled"&&controllerResults[0].value.kind===(["not-attempted","no-subject"].includes(controllerAcquisition)?"absent":"finished");',
    'const everyAcquiredFixtureClosed=ownershipLedger.every((owner)=>["not-attempted","no-subject"].includes(owner.acquisition)||(owner.acquisition==="acquired"&&owner.rawClosed));',
    "const discoveryResults=await Promise.allSettled([(async()=>(await readdir(realSuiteRoot)).filter((name)=>name.startsWith(caseRootPrefix)).sort())(),(async()=>[...(await browserTemporaryDirectories())].filter((name)=>!beforeBrowserRoots.has(name)).sort())()]);",
    'failures.push(...discoveryResults.filter((entry)=>entry.status==="rejected").map((entry)=>entry.reason));',
    'const caseRootNamesAfter=discoveryResults[0]?.status==="fulfilled"?discoveryResults[0].value:[];',
    "const caseRootNamesBeforeSet=new Set(caseRootNamesBefore);",
    "const discoveredCaseRootNames=caseRootNamesAfter.filter((name)=>!caseRootNamesBeforeSet.has(name)&&join(realSuiteRoot,name)!==caseRootOwned?.path);",
    'const survivingBrowserRootNames=discoveryResults[1]?.status==="fulfilled"?discoveryResults[1].value:[];',
    'const caseCapabilityAttempt=(async()=>await Promise.allSettled(discoveredCaseRootNames.map(async(name)=>{const expected=join(realSuiteRoot,name);const resolved=await realpath(expected);assert.equal(resolved,expected,"malicious discovered case root escaped the suite root");if(caseRootOwned?.path===resolved)return caseRootOwned;return captureOwnedDirectory(resolved,`malicious recovered case root ${name}`)})))();',
    'const browserCapabilityAttempt=(async()=>await Promise.allSettled(survivingBrowserRootNames.map(async(name)=>{const expected=join(realSuiteRoot,name);const resolved=await realpath(expected);assert.equal(resolved,expected,"malicious discovered browser root escaped the suite root");return captureOwnedDirectory(resolved,`malicious surviving browser root ${name}`)})))();',
    "const capabilityBatchResults=await Promise.allSettled([caseCapabilityAttempt,browserCapabilityAttempt]);",
    'failures.push(...capabilityBatchResults.filter((entry)=>entry.status==="rejected").map((entry)=>entry.reason));',
    'const caseCapabilityResults=capabilityBatchResults[0]?.status==="fulfilled"?capabilityBatchResults[0].value:[];',
    'const browserCapabilityResults=capabilityBatchResults[1]?.status==="fulfilled"?capabilityBatchResults[1].value:[];',
    'failures.push(...caseCapabilityResults.filter((entry)=>entry.status==="rejected").map((entry)=>entry.reason),...browserCapabilityResults.filter((entry)=>entry.status==="rejected").map((entry)=>entry.reason));',
    'const recoveredCaseCapabilities=[...(caseRootOwned?[caseRootOwned]:[]),...caseCapabilityResults.filter((entry)=>entry.status==="fulfilled").map((entry)=>entry.value)];',
    'const survivingBrowserCapabilities=browserCapabilityResults.filter((entry)=>entry.status==="fulfilled").map((entry)=>entry.value);',
    'const rootTasks=everyAcquiredFixtureClosed&&exactControllerFinalizationFulfilled?[...recoveredCaseCapabilities.map(async(owned)=>{if(await pathExists(owned.path))await cleanupExactOwnedDirectories([owned]);return{kind:"case"}}),...survivingBrowserCapabilities.map(async(owned)=>{if(await pathExists(owned.path))await cleanupExactOwnedDirectories([owned]);return{kind:"surviving-browser"}})]:[];',
    "const rootResults=await Promise.allSettled(rootTasks);",
    'failures.push(...controllerResults.flatMap((result)=>result.status==="fulfilled"&&result.value.finishResults?result.value.finishResults.filter((finish)=>finish.status==="rejected").map((finish)=>finish.reason):[]));',
    'if(!everyAcquiredFixtureClosed||!exactControllerFinalizationFulfilled)failures.push(new Error("malicious roots withheld until every acquired subject closed"));',
    'if(!allJoinsFulfilled)failures.push(new Error("malicious exact fixture finalization was incomplete"));',
    'const residueResults=await Promise.allSettled([(async()=>assert.deepEqual(await postgresTemporaryDirectories(),beforePostgresRoots,"malicious PostgreSQL roots changed"))(),(async()=>assert.deepEqual(await browserTemporaryDirectories(),beforeBrowserRoots,"malicious browser roots changed"))(),(async()=>assert.deepEqual((await readdir(realSuiteRoot)).filter((name)=>name.startsWith(caseRootPrefix)).sort(),caseRootNamesBefore,"malicious case roots changed"))(),(async()=>assertNoOwnedResidue(beforePostgresRoots,beforeBrowserRoots))()]);',
    'failures.push(...rootResults.filter((entry)=>entry.status==="rejected").map((entry)=>entry.reason),...residueResults.filter((entry)=>entry.status==="rejected").map((entry)=>entry.reason));',
    "}",
    'if(failures.length>0)throw new AggregateError(failures,"malicious controller lifecycle failed");',
    "return result",
    "}",
  ].join("\n");
}

function canonicalMaliciousDeadlineSource() {
  const registrations = maliciousRegistrationVariantContract.map(
    (variant) =>
      `it(${JSON.stringify(`denies malicious registration: ${variant}`)},{timeout:150_000},async()=>{await runMaliciousRegistrationCase(${JSON.stringify(variant)})})`,
  );
  const placeholder =
    '[`const variant=${JSON.stringify(variant)}`,`require("node:fs").writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({nonce:process.env.ESBLA_BROWSER_CONTROL_NONCE,profile:process.env.ESBLA_BROWSER_PROFILE_ROOT,realExecutable:process.execPath,root:process.env.ESBLA_BROWSER_CONTROL_ROOT,wrongNonce:process.env.ESBLA_BROWSER_CONTROL_NONCE+"-wrong"}))`,`if(!variant)throw new Error("variant missing")`,`setInterval(()=>{},1000)`].join(";")';
  const suiteFinalizerFile = ts.createSourceFile(
    "canonical-malicious-suite-finalizer",
    canonicalSuiteFinalizerSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const suiteFinalizerStatements = suiteFinalizerFile.statements.filter(
    (statement) =>
      ts.isExpressionStatement(statement) && isCallNamed(statement.expression, "after"),
  );
  if (suiteFinalizerStatements.length !== 1) {
    throw new Error("canonical malicious suite-finalizer anchor drifted");
  }
  const harnessPrefix = canonicalHarnessSuiteFinalizerRegistrationSource().replace(
    "after(async()=>{})",
    suiteFinalizerStatements[0].getText(suiteFinalizerFile),
  );
  if (harnessPrefix === canonicalHarnessSuiteFinalizerRegistrationSource()) {
    throw new Error("canonical malicious harness-prefix anchor drifted");
  }
  return [
    harnessPrefix,
    'const malformedRecoveryExpectedFixtureLabels=Object.freeze(["claimed","sentinel"]);',
    "const malformedRecoveryParentPid=process.pid;",
    "const malformedRecoveryPlatform=process.platform;",
    canonicalSignalHelperSemanticSource("exactFilesystemIdentity"),
    canonicalSignalHelperSemanticSource("readProcessDescriptorIdentity"),
    canonicalSignalHelperSemanticSource("readProcessIdentity"),
    canonicalSignalHelperSemanticSource("sameFilesystemIdentity"),
    canonicalSignalHelperSemanticSource("sameProcessIdentity"),
    canonicalProbeSignalSource(),
    canonicalMaliciousDependencySupportSource(),
    canonicalOwnedControllerLifecycleSource(),
    canonicalMaliciousCaseHelperSource(),
    `const maliciousRegistrationVariants=Object.freeze(${JSON.stringify(maliciousRegistrationVariantContract)});`,
    'describe("HR browser harness contracts",()=>{',
    'it("registration shell",()=>{})',
    'for(const signal of ["SIGINT","SIGTERM"]){it(`registration shell ${signal}`,{timeout:30_000},async()=>{})}',
    "})",
    'describe("malicious registration contracts",()=>{',
    ...registrations,
    "})",
  ]
    .join("\n")
    .replace(placeholder, canonicalMaliciousVariantSourceInitializer());
}

function canonicalSanitizerExclusionHelperSource() {
  return 'function diagnosticsExcludeTrackedValues(output,trackedValues){return (trackedValues.length===5&&new Set(trackedValues).size===trackedValues.length&&trackedValues.every((value)=>typeof value==="string"&&value.length>0)&&trackedValues.every((value)=>!String(output).includes(value)))}';
}

function canonicalSanitizerRuntimeSupportSource() {
  return [
    'const caseRoot="/tmp/synthetic-sanitizer-case";',
    'const claimed=Object.freeze({identity:Object.freeze({command:"synthetic",pgid:1,pid:1,ppid:1,session:1,start:"synthetic",uid:1})});',
  ].join("\n");
}

function canonicalMalformedRuntimeEvidenceSource() {
  return [
    "const ready=await waitForFile(readyPath,20_000);",
    "const harness=captureStableProcessIdentity(ready.harness.pid,ready.harness);",
    'assert.equal(claimed.identity.ppid,process.pid,"claimed fixture is not a direct child");',
    'assert.equal(sentinel.identity.ppid,process.pid,"sentinel fixture is not a direct child");',
    'assert.equal(claimed.identity.pid,claimed.identity.pgid,"claimed group is not isolated");',
    'assert.equal(sentinel.identity.pid,sentinel.identity.pgid,"sentinel group is not isolated");',
    'assert.equal(harness.pid,harness.pgid,"supervised harness group is not isolated");',
    'assert.equal(new Set([claimed.identity.pgid,sentinel.identity.pgid,harness.pgid]).size,3,"claimed, sentinel, and harness groups are not distinct");',
    'controlOwned=captureOwnedDirectory(await realpath(ready.root),"Red F control root");',
    'profileOwned=captureOwnedDirectory(await realpath(ready.profile),"Red F profile root");',
    "await waitForPath(harnessTermMarker,10_000);",
    'assert.equal(await controller.outcomeWithin(20_000),true,"internal bounded shutdown did not complete");',
    "const result=await controller.finish();",
    'assert.equal(result.code,1,"internally rejected wrapper did not exit with code 1");',
    'assert.equal(result.signal,null,"internally rejected wrapper reported an outer signal");',
    "const claimedAfter=captureStableProcessIdentity(claimed.identity.pid,claimed.identity);",
    "const sentinelAfter=captureStableProcessIdentity(sentinel.identity.pid,sentinel.identity);",
    "const claimedSessionObservationAfter=readSemanticSessionObservation(claimedAfter);",
    "const sentinelSessionObservationAfter=readSemanticSessionObservation(sentinelAfter);",
    'assert.equal(isSemanticSessionLeader(claimedSessionObservationAfter),true,"claimed fixture lost semantic session leadership after supervisor drain");',
    'assert.equal(isSemanticSessionLeader(sentinelSessionObservationAfter),true,"sentinel fixture lost semantic session leadership after supervisor drain");',
    'assert.equal(await pathExists(claimed.signalMarkerPath),false,"claimed fixture was signaled");',
    'assert.equal(await pathExists(sentinel.signalMarkerPath),false,"sentinel fixture was signaled");',
    'await assert.rejects(()=>access(join(ready.root,"browser.ack")),/ENOENT/);',
    "await access(ready.root);",
    "await access(ready.profile);",
    'assert.equal(controller.controllerErrors.length,0,"controller recorded an unexpected error");',
    'assert.equal(controller.hardKillUsed,false,"external hard-kill rescue was used");',
    'assert.equal(controller.rescueUsed,false,"external rescue was used");',
    "const trackedValues=Object.freeze([ready.root,ready.profile,ready.nonce,ready.wrongNonce,ready.realExecutable]);",
    'assert.equal(diagnosticsExcludeTrackedValues(result.stderr,trackedValues),true,"diagnostics exposed protected metadata");',
    "const diagnosticPredicates=[/exited with SIGKILL/.test(result.stderr),/registration.*nonce|nonce.*registration/i.test(result.stderr),/Browser control record contains a malformed field/.test(result.stderr)];",
    'assert.deepEqual(diagnosticPredicates,[true,true,true],"required diagnostics absent");',
    "proof={claimedAfter,claimedBefore:claimed.identity,claimedSessionObservation:claimed.sessionObservation,claimedSessionObservationAfter,diagnostics:result.stderr,harnessBefore:harness,sentinelAfter,sentinelBefore:sentinel.identity,sentinelSessionObservation:sentinel.sessionObservation,sentinelSessionObservationAfter,trackedValues};",
  ].join("\n");
}

function canonicalSanitizerOrderingSource() {
  const controllerAcquisition =
    'try{controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});controllerAcquisition=controller.phase}catch(error){controllerAcquisition="no-subject";throw error}';
  const outerCatch = "}catch(error){hasPrimaryFailure=true;primaryFailure=error}finally{";
  const sanitizerRuntime = canonicalMalformedRuntimeEvidenceSource();
  const cleanupCanonical = canonicalMalformedFixtureCleanupSource();
  const runtimeCanonical = cleanupCanonical.replace(
    `${controllerAcquisition}\n${outerCatch}`,
    `${controllerAcquisition}\n${sanitizerRuntime}\n${outerCatch}`,
  );
  if (runtimeCanonical === cleanupCanonical) {
    throw new Error("canonical sanitizer runtime anchor drifted");
  }
  return [
    'import {describe,it} from "node:test";',
    canonicalSanitizerExclusionHelperSource(),
    runtimeCanonical,
    'describe("HR browser harness contracts",()=>{',
    'it("Red F proves actual diagnostics sanitize every tracked value with mutation sensitivity",{timeout:150_000},async()=>{',
    "const proof=await runMalformedCancellationIsolationCase();",
    'assert.equal(proof.trackedValues.length,5,"mutation proof did not retain five tracked values");',
    'assert.equal(Object.isFrozen(proof.trackedValues),true,"mutation proof tracked values are mutable");',
    "for(const trackedValue of proof.trackedValues){",
    "const injected=`${proof.diagnostics}\\n${trackedValue}`;",
    'assert.equal(diagnosticsExcludeTrackedValues(injected,proof.trackedValues),false,"sanitizer accepted protected metadata");',
    "}",
    "})",
    "})",
  ].join("\n");
}

async function runMaliciousRegistrationCase(variant) {
  const beforePostgresRoots = await postgresTemporaryDirectories();
  const beforeBrowserRoots = await browserTemporaryDirectories();
  const realSuiteRoot = await realpath(wrapperTemporaryRoot);
  const caseRootPrefix = `invalid-${variant.length}-${variant}-`;
  const caseRootNamesBefore = (await readdir(realSuiteRoot))
    .filter((name) => name.startsWith(caseRootPrefix))
    .sort();
  const ownershipLedger = [];
  const failures = [];
  let caseRoot;
  let caseRootOwned;
  let claimedOwner;
  let sentinelOwner;
  let claimed;
  let sentinel;
  let ready;
  let controller;
  let result;
  let controllerAcquisition = "not-attempted";
  try {
    caseRoot = await mkdtemp(join(realSuiteRoot, caseRootPrefix));
    const caseRootName = caseRoot.slice(realSuiteRoot.length + 1);
    assert.equal(
      caseRootName.startsWith(caseRootPrefix),
      true,
      "malicious case-root prefix changed",
    );
    assert.equal(
      caseRoot,
      join(realSuiteRoot, caseRootName),
      "malicious case root escaped the suite root",
    );
    const resolvedCaseRoot = await realpath(caseRoot);
    assert.equal(
      resolvedCaseRoot,
      join(realSuiteRoot, caseRootName),
      "malicious case root resolved outside the suite root",
    );
    caseRootOwned = captureOwnedDirectory(resolvedCaseRoot, "malicious case root");
    const readyPath = join(caseRoot, "ready.json");
    const realBrowserExecutable = browserToolingChromium.executablePath();
    const ownFixture = (label, extraArguments = []) => {
      const owner = createCooperativeFixtureSlot(label);
      ownershipLedger.push(owner);
      spawnCooperativeFixture(owner, caseRoot, label, caseRoot, caseRoot, extraArguments);
      return owner;
    };
    claimedOwner = ownFixture(
      "claimed",
      variant === "executable-substring" ? [realBrowserExecutable] : [],
    );
    sentinelOwner = ownFixture("sentinel");
    const retentionResults = await Promise.allSettled(
      ownershipLedger.map((owner) => retainCooperativeFixture(owner)),
    );
    const retentionFailures = retentionResults
      .filter((entry) => entry.status === "rejected")
      .map((entry) => entry.reason);
    if (retentionFailures.length > 0)
      throw new AggregateError(retentionFailures, "malicious fixture retention failed");
    claimed = claimedOwner;
    sentinel = sentinelOwner;
    const source = [
      'const {linkSync,symlinkSync,unlinkSync,writeFileSync}=require("node:fs")',
      `const variant=${JSON.stringify(variant)}`,
      `const claimed=${JSON.stringify(claimed.identity)}`,
      `const sentinel=${JSON.stringify(sentinel.identity)}`,
      `const realExecutable=${JSON.stringify(realBrowserExecutable)}`,
      "let browser=claimed",
      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",
      "const profile=process.env.ESBLA_BROWSER_PROFILE_ROOT",
      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
      'const wrongNonce=(nonce[0]==="a"?"b":"a")+nonce.slice(1)',
      'const intentTmp=root+"/.intent."+process.pid',
      'writeFileSync(intentTmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
      'linkSync(intentTmp,root+"/browser.intent")',
      "unlinkSync(intentTmp)",
      'const record={version:"2",nonce,pid:String(browser.pid),ppid:String(process.pid),pgid:String(browser.pgid),session:String(browser.session),uid:String(browser.uid),start:browser.start,parent_start:claimed.start,fd3:"open",fd4:"open",fd9:"open",real:realExecutable}',
      'let body;let publication="regular";let leaderGone=false;let changedParent=false;switch(variant){case "malformed":body="malformed\\n";break;case "multiply-linked":publication="multiply-linked";break;case "wrong-nonce":record.nonce=wrongNonce;break;case "wrong-nonce-resistant-harness":process.on("SIGTERM",()=>{});record.nonce=wrongNonce;break;case "wrong-parent":record.ppid=String(process.pid+1);break;case "wrong-start":record.start="Mon Jan 01 00:00:00 2001";break;case "wrong-record-uid":record.uid=String(browser.uid+1);break;case "wrong-pgid":record.pgid=String(browser.pgid+1);break;case "unrelated-process":browser=sentinel;record.pid=String(browser.pid);record.pgid=String(browser.pgid);record.session=String(browser.session);record.uid=String(browser.uid);record.start=browser.start;break;case "leader-gone":publication="multiply-linked";leaderGone=true;break;case "changed-parent":publication="multiply-linked";changedParent=true;break;case "executable-substring":if(!claimed.command.includes(realExecutable))throw new Error("executable substring missing");break;case "wrong-mode":publication="wrong-mode";break;case "symlink":publication="symlink";break;default:throw new Error("unknown malicious registration variant")}',
      'if(body===undefined)body=["version","nonce","pid","ppid","pgid","session","uid","start","parent_start","fd3","fd4","fd9","real"].map((key)=>key+"="+record[key]).join("\\n")+"\\n"',
      'const registration=root+"/browser.registration"',
      'const held=root+"/.registration-held"',
      'if(publication==="symlink"){const target=root+"/target";writeFileSync(target,body,{mode:0o600});symlinkSync(target,registration)}else if(publication==="multiply-linked"){writeFileSync(held,body,{mode:0o600});linkSync(held,registration)}else{writeFileSync(registration,body,{mode:publication==="wrong-mode"?0o644:0o600})}',
      `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({changedParent,held,leaderGone,nonce,profile,realExecutable,root,wrongNonce}))`,
      "if(changedParent)process.exit(9)",
      "setInterval(()=>{},1000)",
    ].join(";");
    controllerAcquisition = "attempting";
    try {
      controller = spawnOwnedWrapperController(
        process.execPath,
        ["-e", source],
        {},
        { operationTimeoutMs: 35_000 },
      );
      controllerAcquisition = controller.phase;
    } catch (error) {
      controllerAcquisition = "no-subject";
      throw error;
    }
    ready = await waitForFile(readyPath, 30_000);
    if (ready.leaderGone) {
      await stopAndJoinCooperativeFixture(claimed);
      unlinkSync(ready.held);
    }
    if (ready.changedParent) unlinkSync(ready.held);
    const completedOutcome = await childOutcome(controller, 73_000);
    result = completedOutcome;
    const completedFinish = await controller.finish(75_000);
    assert.deepEqual(completedFinish, completedOutcome);
    assert.equal(result.code, 1, "malicious wrapper did not fail closed");
    assert.equal(result.signal, null, "malicious wrapper reported an outer signal");
    assert.equal(
      await pathExists(join(ready.root, "browser.ack")),
      false,
      "malicious registration received ACK",
    );
    const trackedValues = Object.freeze([
      ready.root,
      ready.profile,
      ready.nonce,
      ready.wrongNonce,
      ready.realExecutable,
    ]);
    assert.equal(
      diagnosticsExcludeTrackedValues(result.stderr, trackedValues),
      true,
      "malicious diagnostics exposed protected metadata",
    );
    const diagnosticPredicates = [
      /registration|browser/i.test(result.stderr),
      result.code === 1,
      result.signal === null,
    ];
    assert.deepEqual(
      diagnosticPredicates,
      [true, true, true],
      "malicious rejection diagnostics absent",
    );
    if (!claimedOwner.joined)
      assert.equal(
        sameProcessIdentity(
          claimed.identity,
          captureStableProcessIdentity(claimed.identity.pid, claimed.identity),
        ),
        true,
        "claimed fixture identity changed",
      );
    assert.equal(
      sameProcessIdentity(
        sentinel.identity,
        captureStableProcessIdentity(sentinel.identity.pid, sentinel.identity),
      ),
      true,
      "sentinel fixture identity changed",
    );
    assert.equal(controller.settled, true, "malicious controller did not settle");
    assert.equal(
      activeWrapperControllers.has(controller),
      false,
      "malicious controller remained active",
    );
    assert.equal(controller.rescueUsed, false, "malicious controller required rescue");
    assert.equal(controller.hardKillUsed, false, "malicious controller required hard kill");
    assert.deepEqual(controller.controllerErrors, [], "malicious controller recorded errors");
  } catch (error) {
    failures.push(error);
  } finally {
    const identityResults = await Promise.allSettled(
      ownershipLedger.map(async (owner) => {
        if (["not-attempted", "no-subject"].includes(owner.acquisition)) return { kind: "absent" };
        return { kind: "owned", owner: await retainCooperativeFixture(owner) };
      }),
    );
    const stopResults = await Promise.allSettled(
      ownershipLedger.map((owner) => publishCooperativeFixtureStop(owner)),
    );
    const joinResults = await Promise.allSettled(
      ownershipLedger.map((owner) => joinCooperativeFixture(owner)),
    );
    const controllerResults = await Promise.allSettled([
      (async () => {
        if (["not-attempted", "no-subject"].includes(controllerAcquisition)) {
          assert.equal(controller, undefined, "controller exists without an acquired subject");
          return { kind: "absent" };
        }
        assert.ok(controller, "controller handle missing after acquisition");
        const identity = controller.identity;
        const finishResults = await Promise.allSettled([controller.finish(75_000)]);
        assert.equal(controller.phase, "finalized", "malicious controller did not finalize");
        assert.equal(
          controller.settled,
          true,
          "malicious controller did not settle during finalization",
        );
        assert.equal(
          activeWrapperControllers.has(controller),
          false,
          "malicious controller remained active after finalization",
        );
        if (identity)
          assert.equal(
            sameProcessIdentity(identity, readProcessIdentity(identity.pid, 1_000)),
            false,
            "malicious controller exact identity remained live",
          );
        return { finishResults, kind: "finished" };
      })(),
    ]);
    const finalizationResults = [
      ...identityResults,
      ...controllerResults,
      ...stopResults,
      ...joinResults,
    ];
    failures.push(
      ...finalizationResults
        .filter((entry) => entry.status === "rejected")
        .map((entry) => entry.reason),
    );
    const allJoinsFulfilled =
      [identityResults, stopResults, joinResults].every(
        (results) =>
          results.length === ownershipLedger.length &&
          results.every((entry) => entry.status === "fulfilled"),
      ) &&
      ownershipLedger.every((owner, index) => {
        const identityResult = identityResults[index].value;
        const stopResult = stopResults[index].value;
        const joinResult = joinResults[index].value;
        if (["not-attempted", "no-subject"].includes(owner.acquisition))
          return (
            !owner.child &&
            !owner.identity &&
            identityResult.kind === "absent" &&
            stopResult.kind === "absent" &&
            joinResult.kind === "absent"
          );
        return (
          owner.acquisition === "acquired" &&
          owner.closeBound &&
          owner.identityRetained &&
          owner.stopPublished &&
          owner.joined &&
          identityResult.kind === "owned" &&
          identityResult.owner === owner &&
          stopResult.kind === "published" &&
          joinResult.kind === "joined" &&
          joinResult.identity === owner.identity &&
          joinResult.outcome?.code === 0 &&
          joinResult.outcome?.signal === null
        );
      });
    const exactControllerFinalizationFulfilled =
      controllerResults.length === 1 &&
      controllerResults[0].status === "fulfilled" &&
      controllerResults[0].value.kind ===
        (["not-attempted", "no-subject"].includes(controllerAcquisition) ? "absent" : "finished");
    const everyAcquiredFixtureClosed = ownershipLedger.every(
      (owner) =>
        ["not-attempted", "no-subject"].includes(owner.acquisition) ||
        (owner.acquisition === "acquired" && owner.rawClosed),
    );
    const discoveryResults = await Promise.allSettled([
      (async () =>
        (await readdir(realSuiteRoot)).filter((name) => name.startsWith(caseRootPrefix)).sort())(),
      (async () =>
        [...(await browserTemporaryDirectories())]
          .filter((name) => !beforeBrowserRoots.has(name))
          .sort())(),
    ]);
    failures.push(
      ...discoveryResults
        .filter((entry) => entry.status === "rejected")
        .map((entry) => entry.reason),
    );
    const caseRootNamesAfter =
      discoveryResults[0]?.status === "fulfilled" ? discoveryResults[0].value : [];
    const caseRootNamesBeforeSet = new Set(caseRootNamesBefore);
    const discoveredCaseRootNames = caseRootNamesAfter.filter(
      (name) =>
        !caseRootNamesBeforeSet.has(name) && join(realSuiteRoot, name) !== caseRootOwned?.path,
    );
    const survivingBrowserRootNames =
      discoveryResults[1]?.status === "fulfilled" ? discoveryResults[1].value : [];
    const caseCapabilityAttempt = (async () =>
      await Promise.allSettled(
        discoveredCaseRootNames.map(async (name) => {
          const expected = join(realSuiteRoot, name);
          const resolved = await realpath(expected);
          assert.equal(resolved, expected, "malicious discovered case root escaped the suite root");
          if (caseRootOwned?.path === resolved) return caseRootOwned;
          return captureOwnedDirectory(resolved, `malicious recovered case root ${name}`);
        }),
      ))();
    const browserCapabilityAttempt = (async () =>
      await Promise.allSettled(
        survivingBrowserRootNames.map(async (name) => {
          const expected = join(realSuiteRoot, name);
          const resolved = await realpath(expected);
          assert.equal(
            resolved,
            expected,
            "malicious discovered browser root escaped the suite root",
          );
          return captureOwnedDirectory(resolved, `malicious surviving browser root ${name}`);
        }),
      ))();
    const capabilityBatchResults = await Promise.allSettled([
      caseCapabilityAttempt,
      browserCapabilityAttempt,
    ]);
    failures.push(
      ...capabilityBatchResults
        .filter((entry) => entry.status === "rejected")
        .map((entry) => entry.reason),
    );
    const caseCapabilityResults =
      capabilityBatchResults[0]?.status === "fulfilled" ? capabilityBatchResults[0].value : [];
    const browserCapabilityResults =
      capabilityBatchResults[1]?.status === "fulfilled" ? capabilityBatchResults[1].value : [];
    failures.push(
      ...caseCapabilityResults
        .filter((entry) => entry.status === "rejected")
        .map((entry) => entry.reason),
      ...browserCapabilityResults
        .filter((entry) => entry.status === "rejected")
        .map((entry) => entry.reason),
    );
    const recoveredCaseCapabilities = [
      ...(caseRootOwned ? [caseRootOwned] : []),
      ...caseCapabilityResults
        .filter((entry) => entry.status === "fulfilled")
        .map((entry) => entry.value),
    ];
    const survivingBrowserCapabilities = browserCapabilityResults
      .filter((entry) => entry.status === "fulfilled")
      .map((entry) => entry.value);
    const rootTasks =
      everyAcquiredFixtureClosed && exactControllerFinalizationFulfilled
        ? [
            ...recoveredCaseCapabilities.map(async (owned) => {
              if (await pathExists(owned.path)) await cleanupExactOwnedDirectories([owned]);
              return { kind: "case" };
            }),
            ...survivingBrowserCapabilities.map(async (owned) => {
              if (await pathExists(owned.path)) await cleanupExactOwnedDirectories([owned]);
              return { kind: "surviving-browser" };
            }),
          ]
        : [];
    const rootResults = await Promise.allSettled(rootTasks);
    failures.push(
      ...controllerResults.flatMap((result) =>
        result.status === "fulfilled" && result.value.finishResults
          ? result.value.finishResults
              .filter((finish) => finish.status === "rejected")
              .map((finish) => finish.reason)
          : [],
      ),
    );
    if (!everyAcquiredFixtureClosed || !exactControllerFinalizationFulfilled)
      failures.push(new Error("malicious roots withheld until every acquired subject closed"));
    if (!allJoinsFulfilled)
      failures.push(new Error("malicious exact fixture finalization was incomplete"));
    const residueResults = await Promise.allSettled([
      (async () =>
        assert.deepEqual(
          await postgresTemporaryDirectories(),
          beforePostgresRoots,
          "malicious PostgreSQL roots changed",
        ))(),
      (async () =>
        assert.deepEqual(
          await browserTemporaryDirectories(),
          beforeBrowserRoots,
          "malicious browser roots changed",
        ))(),
      (async () =>
        assert.deepEqual(
          (await readdir(realSuiteRoot)).filter((name) => name.startsWith(caseRootPrefix)).sort(),
          caseRootNamesBefore,
          "malicious case roots changed",
        ))(),
      (async () => assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots))(),
    ]);
    failures.push(
      ...rootResults.filter((entry) => entry.status === "rejected").map((entry) => entry.reason),
      ...residueResults.filter((entry) => entry.status === "rejected").map((entry) => entry.reason),
    );
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "malicious controller lifecycle failed");
  return result;
}

const maliciousRegistrationVariants = Object.freeze([
  "malformed",
  "multiply-linked",
  "wrong-nonce",
  "wrong-nonce-resistant-harness",
  "wrong-parent",
  "wrong-start",
  "wrong-record-uid",
  "wrong-pgid",
  "unrelated-process",
  "leader-gone",
  "changed-parent",
  "executable-substring",
  "wrong-mode",
  "symlink",
]);

describe("HR browser harness contracts", () => {
  it("copies only Git-indexed source and rejects secret or escaping paths", () => {
    assert.doesNotThrow(() =>
      assertSafeTrackedPaths(["apps/web/app/page.tsx", "packages/db/src/index.ts"]),
    );
    for (const path of [".env", "../escape", "/absolute/path", "apps/web/.next/secret"]) {
      assert.throws(() => assertSafeTrackedPaths([path]), /safe Git-indexed path/);
    }
  });

  it("qualifies only a clean worktree at the exact expected SHA", () => {
    const head = "a".repeat(40);
    assert.deepEqual(assertSourceQualification({ expectedSourceSha: head, head, status: "" }), {
      exactSourceQualified: true,
    });
    assert.deepEqual(assertSourceQualification({ head, status: " M package.json" }), {
      exactSourceQualified: false,
    });
    for (const status of [" M package.json", "M  package.json", "?? unexpected.txt"]) {
      assert.throws(
        () => assertSourceQualification({ expectedSourceSha: head, head, status }),
        /clean index and worktree/,
      );
    }
    assert.throws(
      () => assertSourceQualification({ expectedSourceSha: "b".repeat(40), head, status: "" }),
      /match expected source/,
    );
    assert.throws(
      () => assertSourceQualification({ expectedSourceSha: "ABC", head, status: "" }),
      /exact lowercase 40-character SHA/,
    );
  });

  it("creates only a fresh dedicated artifact leaf and never clears an existing sentinel", async () => {
    const parent = await mkdtemp(join(tmpdir(), "esbla-artifact-contract-"));
    const artifactPath = join(parent, "esbla-browser-artifacts-contract");
    try {
      assert.equal(
        await createArtifactDirectory(artifactPath),
        join(await realpath(parent), "esbla-browser-artifacts-contract"),
      );
      const sentinel = join(artifactPath, "sentinel.txt");
      await writeFile(sentinel, "preserve me");
      await assert.rejects(() => createArtifactDirectory(artifactPath), /must not already exist/);
      assert.equal(await readFile(sentinel, "utf8"), "preserve me");
      for (const unsafe of ["/", tmpdir(), homedir(), dirname(repositoryRoot)]) {
        await assert.rejects(() => createArtifactDirectory(unsafe));
      }
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("allocates isolated employee and manager processes without exposing the secret", () => {
    const plan = createProcessPlan({ secret });
    assert.equal(plan.api.host, "127.0.0.1");
    assert.notEqual(plan.employee.label, plan.manager.label);
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(secret));
  });

  it("builds before API and Next start and never invokes development watchers", () => {
    const serialized = JSON.stringify(createProcessPlan({ secret }));
    assert.match(serialized, /next start/);
    assert.doesNotMatch(serialized, /next dev|tsx watch|0\.0\.0\.0/);
  });

  it("declares the bounded lifecycle and teardown sequence without making journey claims", () => {
    assert.deepEqual(lifecycleStages(), [
      "build",
      "migrate",
      "seed",
      "api-ready",
      "employee-web-ready",
      "manager-web-ready",
      "chromium",
      "evidence",
    ]);
    assert.deepEqual(teardownStages(), [
      "chromium",
      "employee-web",
      "manager-web",
      "api",
      "database-pools",
      "postgresql",
      "temporary-state",
    ]);
  });

  it("continues cleanup after synchronous and timeout failures and aggregates labels", async () => {
    const observed = [];
    await assert.rejects(
      () =>
        runCleanupSteps([
          {
            name: "first",
            run: async () => {
              observed.push("first");
              throw new Error("first failed");
            },
          },
          {
            name: "timeout",
            run: async () => {
              observed.push("timeout");
              await withTimeout("injected hang", async () => await new Promise(() => {}), 25);
            },
          },
          {
            name: "last",
            run: async () => {
              observed.push("last");
            },
          },
        ]),
      (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /^first:/);
        assert.match(error.errors[1].message, /^timeout:/);
        return true;
      },
    );
    assert.deepEqual(observed, ["first", "timeout", "last"]);
  });

  it("stops TERM-responsive and TERM-resistant direct children without timers or residue", async () => {
    const cases = [
      {
        child: spawn(
          process.execPath,
          [
            "-e",
            'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready\\n");setInterval(()=>{},1000)',
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
        ignoresTerm: false,
      },
      {
        child: spawn(
          process.execPath,
          [
            "-e",
            'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)',
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
        ignoresTerm: true,
      },
    ];
    for (const { child, ignoresTerm } of cases) {
      const outcome = childOutcome(child, 5_000);
      await new Promise((resolveReady) => child.stdout.once("data", resolveReady));
      await stopChild(child, 100);
      const result = await outcome;
      if (ignoresTerm) assert.equal(result.signal, "SIGKILL");
      else assert.equal(result.code, 0);
      await waitForPidExit(child.pid);
    }
  });

  it("Red H retains exited managed children until close, group absence, and root removal are proved", async () => {
    const harnessSource = await readFile(browserHarness, "utf8");
    const testSource = await readFile(fileURLToPath(import.meta.url), "utf8");
    const observations = [];
    for (const [label, exitCode] of [
      ["exited", 0],
      ["spawn-error", -2],
    ]) {
      const listeners = new Map();
      let completed = false;
      const child = {
        exitCode,
        off(event, listener) {
          if (listeners.get(event) === listener) listeners.delete(event);
          return this;
        },
        once(event, listener) {
          listeners.set(event, listener);
          return this;
        },
        pid: exitCode === 0 ? 424_242 : 424_243,
        signalCode: null,
      };
      const cleanup = stopChild(child, 100).then(() => {
        completed = true;
      });
      await Promise.resolve();
      observations.push({ completedBeforeClose: completed, label });
      // Always release the prospective Green implementation before asserting.
      listeners.get("close")?.(exitCode, null);
      await cleanup;
    }

    const diagnostics = collectManagedChildLifecycleDiagnostics(
      harnessSource,
      testSource,
      "hr-browser-harness",
    );
    assert.equal(
      observations.every((observation) => observation.completedBeforeClose === false) &&
        diagnostics.length === 0,
      true,
      `managed child cleanup or root-removal authority was incomplete: ${JSON.stringify({ diagnostics, observations })}`,
    );
  });

  it("Red H self-defends managed-child close and cooperative-stop cleanup", async () => {
    const harnessSource = canonicalManagedChildLifecycleSource();
    const testSource = await readFile(fileURLToPath(import.meta.url), "utf8");
    assert.deepEqual(
      collectManagedChildLifecycleDiagnostics(harnessSource, testSource, "canonical-managed-child"),
      [],
    );
    const harmlessCallbackRefactor = replaceInNamedTestExactlyOnce(
      testSource,
      "a second signal immediately escalates a resistant child group",
      '    const rootOwned = captureOwnedDirectory(root, "double-signal contract root");\n    const readyPath = join(root, "ready.json");',
      '    const rootOwned = captureOwnedDirectory(root, "double-signal contract root");\n    void rootOwned.path;\n    const readyPath = join(root, "ready.json");',
      "harmless cooperative-stop reference",
    );
    assert.deepEqual(
      collectManagedChildLifecycleDiagnostics(
        harnessSource,
        harmlessCallbackRefactor,
        "harmless-managed-child-refactor",
      ),
      [],
      "cooperative-stop oracle rejected a harmless extra reference",
    );
    const harmlessGateRefactor = replaceInNamedTestExactlyOnce(
      testSource,
      "a second signal immediately escalates a resistant child group",
      "((!wrapper || wrapperClosedProved) && leaderExactExitProved && grandchildExactExitProved) ||\n        unacquiredFixtureAbsenceProved",
      "unacquiredFixtureAbsenceProved ||\n        (grandchildExactExitProved && leaderExactExitProved && (!wrapper || wrapperClosedProved))",
      "harmless root-gate operand reorder",
    );
    assert.deepEqual(
      collectManagedChildLifecycleDiagnostics(
        harnessSource,
        harmlessGateRefactor,
        "harmless-root-gate-refactor",
      ),
      [],
      "root-gate oracle rejected equivalent operand ordering",
    );
    let harmlessEnvelopeRefactor = replaceInNamedTestExactlyOnce(
      testSource,
      "a second signal immediately escalates a resistant child group",
      "    timeout: 45_000,",
      "    timeout: 60_000,",
      "harmless cooperative-stop timeout",
    );
    harmlessEnvelopeRefactor = replaceInNamedTestExactlyCount(
      harmlessEnvelopeRefactor,
      "a second signal immediately escalates a resistant child group",
      ", 10_000)",
      ", 12_000)",
      5,
      "harmless exact-exit wait timeout",
    );
    harmlessEnvelopeRefactor = replaceInNamedTestExactlyCount(
      harmlessEnvelopeRefactor,
      "a second signal immediately escalates a resistant child group",
      '"double-signal contract root"',
      '"alternate double-signal root proof"',
      6,
      "harmless cooperative-stop root label",
    );
    assert.deepEqual(
      collectManagedChildLifecycleDiagnostics(
        harnessSource,
        harmlessEnvelopeRefactor,
        "harmless-envelope-refactor",
      ),
      [],
      "cooperative-stop oracle rejected a safe timeout or consistent root-label refactor",
    );
    let harmlessRoleRename = replaceInNamedTestExactlyCount(
      testSource,
      "a second signal immediately escalates a resistant child group",
      "leaderIdentity",
      "supervisorIdentity",
      6,
      "harmless leader identity rename",
    );
    harmlessRoleRename = replaceInNamedTestExactlyCount(
      harmlessRoleRename,
      "a second signal immediately escalates a resistant child group",
      "leaderExactExitProved",
      "supervisorAbsenceProved",
      5,
      "harmless leader proof rename",
    );
    harmlessRoleRename = replaceInNamedTestExactlyCount(
      harmlessRoleRename,
      "a second signal immediately escalates a resistant child group",
      "cleanupFailures",
      "teardownFailures",
      12,
      "harmless cleanup sink rename",
    );
    assert.deepEqual(
      collectManagedChildLifecycleDiagnostics(
        harnessSource,
        harmlessRoleRename,
        "harmless-role-rename",
      ),
      [],
      "cooperative-stop oracle rejected consistent lifecycle-role renames",
    );
    const harmlessProofGap = replaceInNamedTestExactlyOnce(
      testSource,
      "a second signal immediately escalates a resistant child group",
      "          await waitForExactProcessExit(leaderIdentity, 10_000);\n          leaderExactExitProved = true;",
      "          await waitForExactProcessExit(leaderIdentity, 10_000);\n          void leaderIdentity.pid;\n          leaderExactExitProved = true;",
      "harmless proof receipt no-op",
    );
    assert.deepEqual(
      collectManagedChildLifecycleDiagnostics(
        harnessSource,
        harmlessProofGap,
        "harmless-proof-gap",
      ),
      [],
      "cooperative-stop oracle rejected an inert statement after a completed exact wait",
    );
    const harmlessRootRemovalGap = replaceInNamedTestExactlyOnce(
      testSource,
      "a second signal immediately escalates a resistant child group",
      '          assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          await rmdir(root);',
      '          assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          void rootOwned.path;\n          await rmdir(root);',
      "harmless nonrecursive root-removal no-op",
    );
    assert.deepEqual(
      collectManagedChildLifecycleDiagnostics(
        harnessSource,
        harmlessRootRemovalGap,
        "harmless-root-removal-gap",
      ),
      [],
      "root-gate oracle rejected an inert statement before nonrecursive directory removal",
    );

    const mutations = [
      [
        "managed-child-receipt-contract",
        replaceExactlyOnce(
          harnessSource,
          'child.once("close"',
          'child.once("exit"',
          "managed close-to-exit",
        ),
        testSource,
      ],
      [
        "managed-child-registration-contract",
        replaceExactlyOnce(
          harnessSource,
          "  return child;\n}",
          '  child.once("error", () => signalState.children.delete(child));\n  return child;\n}',
          "managed error release",
        ),
        testSource,
      ],
      [
        "managed-child-stop-contract",
        replaceExactlyOnce(
          harnessSource,
          "export async function stopChild(child, timeoutMs = processStopTimeoutMs) {",
          "export async function stopChild(child, timeoutMs = processStopTimeoutMs) {\n  if (child.exitCode !== null || child.signalCode !== null) return;",
          "managed terminal shortcut",
        ),
        testSource,
      ],
      [
        "managed-child-join-contract",
        replaceExactlyOnce(
          harnessSource,
          "Promise.allSettled(children.map((child) => stopChild(child)))",
          "Promise.all(children.map((child) => stopChild(child)))",
          "managed attempt-all join",
        ),
        testSource,
      ],
      [
        "managed-child-group-contract",
        replaceExactlyOnce(
          harnessSource,
          'spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {',
          'spawnSync("/usr/bin/false", ["-axo", "pid=,pgid="], {',
          "managed group observer",
        ),
        testSource,
      ],
      [
        "managed-child-group-contract",
        replaceExactlyOnce(
          harnessSource,
          "member.pgid === pgid && member.pid !== result.pid",
          "member.pgid === pgid",
          "managed observer self exclusion",
        ),
        testSource,
      ],
      [
        "temporary-root-capture-contract",
        replaceInTopLevelFunctionExactlyOnce(
          harnessSource,
          "captureTemporaryRoot",
          "Number(metadata.mode & 0o777n) !== 0o700",
          "Number(metadata.mode & 0o777n) !== 0o755",
          "temporary root capture mode",
        ),
        testSource,
      ],
      [
        "temporary-root-identity-contract",
        replaceExactlyOnce(
          harnessSource,
          "String(metadata.dev) !== owned.dev",
          "String(metadata.dev) === owned.dev",
          "temporary root device identity",
        ),
        testSource,
      ],
      [
        "managed-child-cleanup-receipt-contract",
        replaceExactlyOnce(
          harnessSource,
          "          const closed = await stopManagedChildren(signalState);",
          '          const closed = await withTimeout("child process cleanup", () => stopManagedChildren(signalState));',
          "managed cleanup nonjoining timeout",
        ),
        testSource,
      ],
      [
        "managed-child-cleanup-receipt-contract",
        replaceExactlyOnce(
          harnessSource,
          "          managedChildrenClosed = true;",
          "          managedChildrenClosed = false;",
          "managed cleanup receipt",
        ),
        testSource,
      ],
      [
        "temporary-root-removal-contract",
        replaceExactlyOnce(
          harnessSource,
          '          if (!managedChildrenClosed) throw new Error("Managed child cleanup is unproved");',
          '          if (false && !managedChildrenClosed) throw new Error("Managed child cleanup is unproved");',
          "temporary root close gate",
        ),
        testSource,
      ],
      [
        "temporary-root-removal-contract",
        replaceExactlyOnce(
          harnessSource,
          "await rm(temporaryRoot, { force: false, recursive: true });",
          "await rm(temporaryRoot, { force: false, recursive: false });",
          "temporary root recursive policy",
        ),
        testSource,
      ],
      [
        "temporary-root-removal-contract",
        replaceExactlyOnce(
          harnessSource,
          "await rm(temporaryRoot, { force: false, recursive: true });",
          "await rm(temporaryRoot, { force: true, recursive: true });",
          "temporary root force policy",
        ),
        testSource,
      ],
      [
        "temporary-root-removal-contract",
        replaceExactlyOnce(
          harnessSource,
          "          await rm(temporaryRoot, { force: false, recursive: true });",
          '          await withTimeout("temporary state removal", async () => {\n            await rm(temporaryRoot, { force: false, recursive: true });\n          });',
          "temporary root nonjoining timeout",
        ),
        testSource,
      ],
      [
        "temporary-root-capture-order-contract",
        replaceExactlyOnce(
          harnessSource,
          "temporaryRootOwned = await captureTemporaryRoot(temporaryRoot);",
          "temporaryRootOwned = undefined;",
          "temporary root capability capture",
        ),
        testSource,
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          '    } finally {\n      try {\n        assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n        await writePrivateStop(stopPath);\n      } catch (error) {\n        cleanupFailures.push(error);\n      }\n      if (grandchildIdentity && !grandchildExactExitProved) {',
          '    } finally {\n      try {\n        assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n        void stopPath;\n      } catch (error) {\n        cleanupFailures.push(error);\n      }\n      if (grandchildIdentity && !grandchildExactExitProved) {',
          "cooperative stop publication",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "await writePrivateStop(stopPath);",
          "if (false) await writePrivateStop(stopPath);",
          "dead cooperative stop publication",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n        await writePrivateStop(stopPath);',
          "void rootOwned;\n        await writePrivateStop(stopPath);",
          "stop publication root capability revalidation",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyCount(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "waitForExactProcessExit(grandchildIdentity",
          "waitForPidExit(grandchildIdentity.pid",
          2,
          "cooperative exact identity wait",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "      await Promise.all([\n        waitForExactProcessExit(leaderIdentity, 10_000),\n        waitForExactProcessExit(grandchildIdentity, 10_000),\n      ]);",
          "      await Promise.all([leaderIdentity, grandchildIdentity]);",
          "identity values substituted for exact exit proofs",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "      await Promise.all([\n        waitForExactProcessExit(leaderIdentity, 10_000),\n        waitForExactProcessExit(grandchildIdentity, 10_000),\n      ]);",
          "      if (0)\n        await Promise.all([\n          waitForExactProcessExit(leaderIdentity, 10_000),\n          waitForExactProcessExit(grandchildIdentity, 10_000),\n        ]);",
          "dead primary identity proof join",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "          await waitForExactProcessExit(grandchildIdentity, 10_000);\n          grandchildExactExitProved = true;",
          "          const proofEnabled = false;\n          if (proofEnabled) await waitForExactProcessExit(grandchildIdentity, 10_000);\n          grandchildExactExitProved = true;",
          "dead fallback identity proof",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "          await waitForExactProcessExit(grandchildIdentity, 10_000);\n          grandchildExactExitProved = true;",
          "          await waitForExactProcessExit(grandchildIdentity, 10_000);\n          false && (grandchildExactExitProved = true);",
          "short-circuited fallback identity receipt",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "rmdir(root)",
          "rm(root, { force: true, recursive: true })",
          "cooperative root capability cleanup",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "await rmdir(root);",
          "if (false) await rmdir(root);",
          "dead cooperative root capability cleanup",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'const rootOwned = captureOwnedDirectory(root, "double-signal contract root");',
          "let rootOwned;",
          "cooperative root capture order",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'const readyPath = join(root, "ready.json");',
          'const readyPath = join(wrapperTemporaryRoot, "ready.json");',
          "ready leaf path outside the owned root",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "await rm(readyPath, { force: false, recursive: false });",
          "await rm(readyPath, { force: true, recursive: false });",
          "cooperative root force policy",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          const rootEntries',
          "void rootOwned;\n          const rootEntries",
          "root inventory capability revalidation",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "          const rootEntries = (await readdir(root)).sort();",
          "          const rootEntries = (await readdir(root), []).sort();",
          "noncausal root inventory expression",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          const rootEntries',
          'assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          await Promise.resolve();\n          const rootEntries',
          "await gap before root inventory",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n            await rm(readyPath',
          "void rootOwned;\n            await rm(readyPath",
          "ready leaf capability revalidation",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'if (rootEntries.includes("ready.json")) {\n            assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n            await rm(readyPath',
          'if (rootEntries.includes("ready.json")) {\n            assert.deepEqual((captureOwnedDirectory(root, "double-signal contract root"), rootOwned), rootOwned);\n            await rm(readyPath',
          "noncausal ready leaf capability expression",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n            await rm(readyPath',
          'assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n            await Promise.resolve();\n            await rm(readyPath',
          "await gap before ready leaf deletion",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n            await rm(stopPath',
          "void rootOwned;\n            await rm(stopPath",
          "stop leaf capability revalidation",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          'rootEntries.filter((entry) => !["grandchild.stop", "ready.json"].includes(entry))',
          "rootEntries.filter(() => false)",
          "cooperative unexpected-root rejection",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "          assert.deepEqual(await readdir(root), []);",
          "          assert.deepEqual((await readdir(root), []), []);",
          "noncausal final empty-directory expression",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          '          assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          await rmdir(root);',
          '          assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          await Promise.resolve();\n          await rmdir(root);',
          "await gap before root deletion",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          '          assert.deepEqual(await readdir(root), []);\n          assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          await rmdir(root);',
          '          assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);\n          await rmdir(root);\n          assert.deepEqual(await readdir(root), []);',
          "root deletion before final empty-directory proof",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "unacquiredFixtureAbsenceProved = true;",
          "unacquiredFixtureAbsenceProved = false;",
          "cooperative unacquired absence receipt",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "          await assertNoOwnedResidue(before, beforeBrowserRoots);\n          unacquiredFixtureAbsenceProved = true;",
          "          const proofEnabled = false;\n          if (proofEnabled) await assertNoOwnedResidue(before, beforeBrowserRoots);\n          unacquiredFixtureAbsenceProved = true;",
          "dead unacquired absence proof",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "((!wrapper || wrapperClosedProved) && leaderExactExitProved && grandchildExactExitProved) ||\n        unacquiredFixtureAbsenceProved",
          "((!wrapper || wrapperClosedProved) && leaderExactExitProved && grandchildExactExitProved) &&\n        unacquiredFixtureAbsenceProved",
          "cooperative alternative absence gate",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "(!wrapper || wrapperClosedProved) && leaderExactExitProved && grandchildExactExitProved",
          "leaderExactExitProved && grandchildExactExitProved",
          "acquired root wrapper receipt gate",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          '      } else {\n        cleanupFailures.push(\n          new Error("double-signal fixture absence was not proved; root cleanup withheld"),\n        );\n      }',
          '      } else {\n        if (Date.now() < 0) {\n          cleanupFailures.push(\n            new Error("double-signal fixture absence was not proved; root cleanup withheld"),\n          );\n        }\n      }',
          "dead false-gate failure sink",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          '      } else {\n        cleanupFailures.push(\n          new Error("double-signal fixture absence was not proved; root cleanup withheld"),\n        );\n      }',
          '      } else {\n        while (true) {}\n        cleanupFailures.push(\n          new Error("double-signal fixture absence was not proved; root cleanup withheld"),\n        );\n      }',
          "unreachable false-gate failure sink",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "      } catch (error) {\n        cleanupFailures.push(error);\n      }\n      if (grandchildIdentity",
          "      } catch (error) {\n        void error;\n      }\n      if (grandchildIdentity",
          "swallowed stop cleanup failure",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "          grandchildExactExitProved = true;\n        } catch (error) {\n          cleanupFailures.push(error);\n        }",
          "          grandchildExactExitProved = true;\n        } catch (error) {\n          void error;\n        }",
          "swallowed fallback cleanup failure",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          '          wrapperClosedProved = wrapper.settled && wrapper.phase === "finalized";\n        } catch (error) {\n          cleanupFailures.push(error);\n        }',
          '          wrapperClosedProved = wrapper.settled && wrapper.phase === "finalized";\n        } catch (error) {\n          void error;\n        }',
          "swallowed wrapper cleanup failure",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "          await rmdir(root);\n        } catch (error) {\n          cleanupFailures.push(error);\n        }",
          "          await rmdir(root);\n        } catch (error) {\n          void error;\n        }",
          "swallowed root cleanup failure",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "(!wrapper || wrapperClosedProved) && !leaderIdentity && !grandchildIdentity",
          "(!wrapper || wrapperClosedProved) && !leaderIdentity",
          "partial leader-only absence gate",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "(!wrapper || wrapperClosedProved) && !leaderIdentity && !grandchildIdentity",
          "(!wrapper || wrapperClosedProved) && !grandchildIdentity",
          "partial grandchild-only absence gate",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "if (wrapper.identity) await waitForExactProcessExit(wrapper.identity, 10_000);",
          "if (false && wrapper.identity) await waitForExactProcessExit(wrapper.identity, 10_000);",
          "dead wrapper identity absence proof",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "if (cleanupFailures.length) throw new AggregateError(cleanupFailures);",
          "if (false && cleanupFailures.length) throw new AggregateError(cleanupFailures);",
          "cleanup-only failure propagation",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "if (primaryFailure && cleanupFailures.length)",
          "if (primaryFailure && cleanupFailures.length < 0)",
          "impossible combined-failure predicate",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "\n    if (primaryFailure && cleanupFailures.length) {",
          "\n    cleanupFailures.splice(0);\n    if (primaryFailure && cleanupFailures.length) {",
          "erased cleanup-failure sink",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "    timeout: 45_000,\n  }, async () => {",
          "    timeout: 45_000,\n    skip: true,\n  }, async () => {",
          "cooperative test registration skip",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "    try {\n      wrapper = spawnSupervisedPostgresWrapper",
          "    try {\n      return;\n      wrapper = spawnSupervisedPostgresWrapper",
          "premature cooperative return",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "    const cleanupFailures = [];\n\n    try {",
          "    const cleanupFailures = [];\n    wrapperClosedProved = true;\n\n    try {",
          "forged wrapper-close receipt",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "    const cleanupFailures = [];\n\n    try {",
          "    const cleanupFailures = [];\n    unacquiredFixtureAbsenceProved = true;\n\n    try {",
          "forged unacquired-absence receipt",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "    const cleanupFailures = [];\n\n    try {",
          "    const cleanupFailures = [];\n    const forgedCleanup = cleanupFailures;\n    forgedCleanup.push = () => 0;\n\n    try {",
          "aliased cleanup-failure sink",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "    const cleanupFailures = [];\n\n    try {",
          "    const cleanupFailures = [];\n    const writePrivateStop = async () => {};\n\n    try {",
          "shadowed cooperative-stop publisher",
        ),
      ],
      [
        "double-signal-cooperative-stop",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "    } catch (error) {\n      primaryFailure = error;\n    } finally {",
          "    } catch (error) {\n      void error;\n    } finally {",
          "swallowed cooperative primary failure",
        ),
      ],
      [
        "double-signal-root-gate",
        harnessSource,
        replaceInNamedTestExactlyOnce(
          testSource,
          "a second signal immediately escalates a resistant child group",
          "    const cleanupFailures = [];\n\n    try {",
          '    const cleanupFailures = [];\n    Object.defineProperty(wrapper, "finish", { value: async () => undefined });\n\n    try {',
          "reflective wrapper-close forgery",
        ),
      ],
    ];

    for (const [category, mutatedHarness, mutatedTest] of mutations) {
      assert.equal(
        collectManagedChildLifecycleDiagnostics(
          mutatedHarness,
          mutatedTest,
          "synthetic-managed-child",
        ).some((entry) => entry.endsWith(`:${category}`)),
        true,
        `managed-child oracle accepted ${category}`,
      );
    }
  });

  it("redacts a secret split across arbitrary adjacent output chunks", () => {
    const output = [];
    const redactor = createStreamingRedactor(secret, (value) => output.push(value));
    redactor.write(`before ${secret.slice(0, 11)}`);
    redactor.write(secret.slice(11, 31));
    redactor.write(`${secret.slice(31)} after`);
    redactor.end();
    assert.equal(output.join(""), "before [REDACTED] after");
    assert.doesNotMatch(output.join(""), new RegExp(secret));
  });

  it("redacts multiple secrets split across adjacent output chunks", () => {
    const endpoint = "ws://127.0.0.1:43123/0123456789abcdef0123456789abcdef";
    const output = [];
    const redactor = createStreamingRedactor([secret, endpoint], (value) => output.push(value));
    redactor.write(`before ${secret.slice(0, 17)}`);
    redactor.write(`${secret.slice(17)} between ${endpoint.slice(0, 23)}`);
    redactor.write(`${endpoint.slice(23)} after`);
    redactor.end();
    assert.equal(output.join(""), "before [REDACTED] between [REDACTED] after");
    assert.doesNotMatch(output.join(""), new RegExp(secret));
    assert.doesNotMatch(output.join(""), new RegExp(endpoint.replaceAll("/", "\\/")));
  });

  it("redacts a BrowserServer bearer token even without its endpoint prefix", () => {
    const token = "0123456789abcdef0123456789abcdef";
    const output = [];
    const redactor = createStreamingRedactor([secret, token], (value) => output.push(value));
    redactor.write(`token ${token.slice(0, 9)}`);
    redactor.write(token.slice(9));
    redactor.end();
    assert.equal(output.join(""), "token [REDACTED]");
  });

  it("accepts only the exact default tokenized loopback BrowserServer endpoint", () => {
    const valid = "ws://127.0.0.1:43123/0123456789abcdef0123456789abcdef";
    assert.equal(assertLoopbackBrowserEndpoint(valid), valid);
    for (const invalid of [
      "http://127.0.0.1:43123/0123456789abcdef0123456789abcdef",
      "ws://localhost:43123/0123456789abcdef0123456789abcdef",
      "ws://[::1]:43123/0123456789abcdef0123456789abcdef",
      "ws://user@127.0.0.1:43123/0123456789abcdef0123456789abcdef",
      "ws://127.0.0.1/0123456789abcdef0123456789abcdef",
      "ws://127.0.0.1:43123/short",
      "ws://127.0.0.1:43123/0123456789abcdef0123456789abcdeg",
      "ws://127.0.0.1:43123/0123456789abcdef0123456789abcdef?query=1",
      "ws://127.0.0.1:43123/0123456789abcdef0123456789abcdef#fragment",
    ]) {
      assert.throws(() => assertLoopbackBrowserEndpoint(invalid), /exact tokenized/);
    }
  });

  it("restores temporary environment values on success and rejection", async () => {
    const absentKey = "ESBLA_TEST_TEMPORARY_ABSENT";
    const presentKey = "ESBLA_TEST_TEMPORARY_PRESENT";
    delete process.env[absentKey];
    process.env[presentKey] = "before";
    assert.equal(
      await withTemporaryEnvironment(
        { [absentKey]: "during", [presentKey]: "during" },
        async () => `${process.env[absentKey]}:${process.env[presentKey]}`,
      ),
      "during:during",
    );
    assert.equal(process.env[absentKey], undefined);
    assert.equal(process.env[presentKey], "before");
    await assert.rejects(
      () =>
        withTemporaryEnvironment({ [presentKey]: "during" }, async () => {
          throw new Error("injected launch rejection");
        }),
      /injected launch rejection/,
    );
    assert.equal(process.env[presentKey], "before");
    delete process.env[presentKey];
  });

  it("scrubs secrets from regular and hidden artifacts and rejects symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "esbla-artifact-secrets-"));
    const outside = join(root, "outside.txt");
    try {
      await writeFile(join(root, "result.json"), `{"endpoint":"${secret}"}`);
      await writeFile(join(root, ".hidden"), `hidden ${secret}`);
      await scrubAndAssertArtifactSecrets(root, [secret]);
      assert.equal(await readFile(join(root, "result.json"), "utf8"), '{"endpoint":"[REDACTED]"}');
      assert.equal(await readFile(join(root, ".hidden"), "utf8"), "hidden [REDACTED]");
      await writeFile(outside, "outside");
      await symlink(outside, join(root, "linked"));
      await assert.rejects(
        () => scrubAndAssertArtifactSecrets(root, [secret]),
        /not a regular file or directory/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("strictly parses the exact browser registration schema", () => {
    const valid = [
      "version=2",
      `nonce=${"a".repeat(64)}`,
      "pid=501",
      "ppid=500",
      "pgid=501",
      "session=0",
      "uid=501",
      "start=Mon Jul 13 02:00:00 2026",
      "parent_start=Mon Jul 13 01:59:59 2026",
      "fd3=open",
      "fd4=open",
      "fd9=open",
      "real=/tmp/browser",
      "",
    ].join("\n");
    assert.equal(parseBrowserRegistration(valid).session, 0);
    assert.throws(() => parseBrowserRegistration(`${valid}extra=value\n`), /exact schema/);
    assert.throws(() => parseBrowserRegistration(valid.replace("pid=501", "pid=0")), /positive/);
    assert.throws(
      () => parseBrowserRegistration(valid.replace("fd4=open", "fd4=open\nfd4=open")),
      /duplicates/,
    );
  });

  it("rejects symlink, wrong-owner, wrong-mode, and multiply linked control files", () => {
    const valid = { isFile: true, isSymbolicLink: false, mode: 0o600, nlink: 1, uid: 501 };
    assert.equal(isSecureControlFileMetadata(valid, 501), true);
    for (const invalid of [
      { ...valid, isSymbolicLink: true },
      { ...valid, uid: 502 },
      { ...valid, mode: 0o644 },
      { ...valid, nlink: 2 },
      { ...valid, isFile: false },
    ]) {
      assert.equal(isSecureControlFileMetadata(invalid, 501), false);
    }
  });

  it("waits for exact one-link ACK publication before browser execution", {
    timeout: 75_000,
  }, async () => {
    const root = await realpath(await mkdtemp(join(wrapperTemporaryRoot, "ack-publication-")));
    const rootOwned = captureOwnedDirectory(root, "ACK publication test root");
    const nonce = "a".repeat(64);
    const ownershipPath = join(root, "browser.ownership");
    const intentPath = join(root, "browser.intent");
    const launcherPath = join(root, "browser-launcher.sh");
    const profileRoot = join(root, "profile");
    const registrationPath = join(root, "browser.registration");
    const ackPath = join(root, "browser.ack");
    const ackTemporaryPath = join(root, ".ack.test");
    const executedPath = join(root, "executed");
    const realSource = `require("node:fs").writeFileSync(${JSON.stringify(
      executedPath,
    )},"executed\\n",{flag:"wx",mode:0o600})`;
    let child;
    let outcome;
    let registration;
    let anchorIdentity;
    let result;
    let primaryError;
    let absenceProved = false;
    const cleanupFailures = [];
    try {
      await mkdir(profileRoot, { mode: 0o700 });
      await writeFile(ownershipPath, "owned\n", { flag: "wx", mode: 0o600 });
      await writeFile(intentPath, `nonce=${nonce}\npid=${process.pid}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(launcherPath, renderBrowserLauncherShimForTest(), {
        flag: "wx",
        mode: 0o700,
      });
      child = spawn(launcherPath, ["-e", realSource], {
        detached: true,
        env: {
          ...process.env,
          ESBLA_BROWSER_CONTROL_NONCE: nonce,
          ESBLA_BROWSER_CONTROL_ROOT: root,
          ESBLA_BROWSER_LAUNCHER: launcherPath,
          ESBLA_BROWSER_OWNERSHIP_TOKEN: ownershipPath,
          ESBLA_BROWSER_PROFILE_ROOT: profileRoot,
          ESBLA_BROWSER_REAL_EXECUTABLE: process.execPath,
          ESBLA_BROWSER_SUPERVISOR_PID: String(process.pid),
        },
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      });
      child.stdio[3]?.resume();
      child.stdio[4]?.resume();
      outcome = childOutcome(child, 70_000);
      const registrationDeadline = Date.now() + 5_000;
      while (!registration && Date.now() < registrationDeadline) {
        try {
          registration = parseBrowserRegistration(await readFile(registrationPath, "utf8"));
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw new Error("browser anchor registration was invalid");
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
      }
      assert.ok(registration, "browser anchor did not publish registration");
      anchorIdentity = captureStableProcessIdentity(registration.pid);
      assert.equal(registration.pid, child.pid);
      assert.equal(registration.pgid, child.pid);
      assert.equal(registration.ppid, process.pid);
      assert.equal(registration.fd3, "open");
      assert.equal(registration.fd4, "open");
      assert.equal(registration.fd9, "open");
      await writeFile(ackTemporaryPath, `nonce=${nonce}\npid=${child.pid}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await link(ackTemporaryPath, ackPath);
      assert.equal(statSync(ackPath).nlink, 2);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      const heldIdentity = captureStableProcessIdentity(child.pid, anchorIdentity);
      assert.equal(heldIdentity.pgid, heldIdentity.pid);
      assert.equal(
        await pathExists(executedPath),
        false,
        "browser executable ran before exact one-link ACK publication",
      );
      unlinkSync(ackTemporaryPath);
      assert.equal(statSync(ackPath).nlink, 1);
      result = await outcome;
      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: 0, signal: null },
        "browser anchor rejected an exact transitional ACK",
      );
      assert.equal(await readFile(executedPath, "utf8"), "executed\n");
    } catch (error) {
      primaryError = error;
    } finally {
      const cleanupAttempt = async (operation) => {
        try {
          await operation();
        } catch (error) {
          cleanupFailures.push(error);
        }
      };
      if (child && outcome) {
        await cleanupAttempt(async () => {
          const liveIdentity = readProcessIdentity(child.pid);
          if (liveIdentity) {
            if (
              !registration ||
              !anchorIdentity ||
              !sameProcessIdentity(anchorIdentity, liveIdentity)
            ) {
              throw new Error("owned browser anchor identity was unproved during release");
            }
            if (!(await pathExists(ackPath))) {
              if (!(await pathExists(ackTemporaryPath))) {
                await writeFile(ackTemporaryPath, `nonce=${nonce}\npid=${registration.pid}\n`, {
                  flag: "wx",
                  mode: 0o600,
                });
              }
              await link(ackTemporaryPath, ackPath);
            }
            if (await pathExists(ackTemporaryPath)) unlinkSync(ackTemporaryPath);
            assert.equal(statSync(ackPath).nlink, 1);
          } else if (await pathExists(ackTemporaryPath)) {
            unlinkSync(ackTemporaryPath);
          }
        });
        await cleanupAttempt(async () => {
          if (result === undefined) result = await outcome;
        });
        child.stdio[3]?.destroy();
        child.stdio[4]?.destroy();
        if (anchorIdentity) {
          await cleanupAttempt(async () => {
            await waitForExactProcessExit(anchorIdentity, 70_000);
            const members = readProcessGroupMembers(anchorIdentity.pgid);
            assert.deepEqual(members, [], "owned browser anchor group remained live");
            absenceProved = true;
          });
        } else if (child.exitCode !== null || child.signalCode !== null) {
          absenceProved = true;
        }
      } else {
        absenceProved = true;
      }
      if (absenceProved) {
        await cleanupAttempt(async () => cleanupExactOwnedDirectories([rootOwned]));
      } else {
        cleanupFailures.push(
          new Error("owned browser anchor absence was not proved; root cleanup was withheld"),
        );
      }
    }
    if (primaryError && cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupFailures],
        "ACK publication regression and cleanup both failed",
      );
    }
    if (primaryError) throw primaryError;
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "ACK publication regression cleanup failed");
    }
  });

  it("treats ESRCH as absent and EPERM or leader ambiguity as fail-closed", () => {
    if (process.platform === "darwin") {
      assert.equal(readProcessDescriptorIdentity(process.pid, 999_999), undefined);
    }
    assert.equal(classifyProcessGroupProbeError({ code: "ESRCH" }), false);
    assert.equal(classifyProcessGroupProbeError({ code: "EPERM" }), true);
    assert.throws(() => classifyProcessGroupProbeError({ code: "EINVAL" }));
    const expected = { pgid: 10, pid: 10, ppid: 9, session: 10, start: "start", uid: 501 };
    assert.equal(classifyRetainedLeader(expected, undefined, false), "absent");
    assert.equal(classifyRetainedLeader(expected, undefined, true), "ambiguous");
    assert.equal(
      classifyRetainedLeader(expected, { ...expected, start: "changed" }, true),
      "changed",
    );
    assert.equal(
      classifyRetainedLeader(expected, { ...expected, pgid: expected.pgid + 1 }, true),
      "changed",
    );
    assert.equal(classifyRetainedLeader(expected, { ...expected }, true), "owned");
    assert.equal(
      classifyRetainedLeader(expected, { ...expected, ppid: expected.ppid + 1 }, true),
      "changed",
    );
    assert.equal(
      classifyRetainedLeader(expected, { ...expected, ppid: expected.ppid + 1 }, true, true),
      "owned",
    );
    assert.equal(
      classifyRetainedLeader(expected, { ...expected, start: "changed" }, true, true),
      "changed",
    );
  });

  it("binds browser-parent drift only to the exact in-memory harness exit receipt", () => {
    const child = { exitCode: null, pid: 501, signalCode: "SIGKILL" };
    const identity = { pid: 501 };
    const receipt = { child, code: null, identity, signal: "SIGKILL" };
    assert.equal(isExactHarnessExitReceipt(receipt, child, identity), true);
    assert.equal(isExactHarnessExitReceipt(receipt, { ...child }, identity), false);
    assert.equal(isExactHarnessExitReceipt(receipt, child, { ...identity }), false);
    assert.equal(
      isExactHarnessExitReceipt({ ...receipt, signal: "SIGTERM" }, child, identity),
      false,
    );
    const runningChild = { exitCode: null, pid: 501, signalCode: null };
    assert.equal(
      isExactHarnessExitReceipt(
        { child: runningChild, code: null, identity, signal: null },
        runningChild,
        identity,
      ),
      false,
    );
  });

  it("accepts the retained executable only as exact argv zero", () => {
    const executable = "/opt/Chrome Browser/chrome";
    assert.equal(commandUsesExactExecutable(executable, executable), true);
    assert.equal(commandUsesExactExecutable(`${executable} --headless`, executable), true);
    assert.equal(commandUsesExactExecutable(`/tmp/prefix${executable}`, executable), false);
    assert.equal(commandUsesExactExecutable(`/usr/bin/node task ${executable}`, executable), false);
    assert.equal(commandUsesExactExecutable(`${executable}-helper`, executable), false);
  });

  it("allows only read-only HTTP requests to the actor's exact origin", () => {
    const employeeOrigin = "http://127.0.0.1:41001";
    assert.equal(
      isExactActorRequest(`${employeeOrigin}/workspace/hr/leave`, "GET", employeeOrigin),
      true,
    );
    assert.equal(isExactActorRequest(`${employeeOrigin}/asset.css`, "HEAD", employeeOrigin), true);
    for (const [url, method] of [
      ["http://127.0.0.1:41002/workspace/my-work", "GET"],
      ["http://localhost:41001/workspace/hr/leave", "GET"],
      [`${employeeOrigin}/workspace/hr/leave`, "POST"],
      ["http://user@127.0.0.1:41001/workspace/hr/leave", "GET"],
      ["ws://127.0.0.1:41001/socket", "GET"],
      ["https://example.test/", "GET"],
    ]) {
      assert.equal(isExactActorRequest(url, method, employeeOrigin), false, `${method} ${url}`);
    }
  });

  it("sanitizes metadata and keeps full-journey restart and production flags false", () => {
    const evidence = sanitizeEvidence({
      fullJourney: true,
      productionAuthentication: true,
      restart: true,
      secret,
    });
    assert.deepEqual(evidence, {
      fullJourney: false,
      productionAuthentication: false,
      restart: false,
      secret: "[REDACTED]",
    });
  });

  it("cleans PostgreSQL on child success, failure, and spawn error", {
    timeout: 90_000,
  }, async () => {
    const before = await postgresTemporaryDirectories();
    const success = await childOutcome(
      spawnPostgresWrapper(process.execPath, ["-e", "process.exit(0)"]),
    );
    assert.equal(success.code, 0, success.stderr);
    await assertNoNewPostgresTemporaryDirectories(before);

    const failure = await childOutcome(
      spawnPostgresWrapper(process.execPath, ["-e", "process.exit(7)"]),
    );
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /exited with code 7/);
    await assertNoNewPostgresTemporaryDirectories(before);

    const spawnError = await childOutcome(
      spawnPostgresWrapper(join(tmpdir(), "esbla-command-that-does-not-exist")),
    );
    assert.equal(spawnError.code, 1);
    assert.match(spawnError.stderr, /ENOENT|failed/i);
    await assertNoNewPostgresTemporaryDirectories(before);
  });

  it("keeps ordinary PostgreSQL-wrapper children free of browser-control environment", {
    timeout: 45_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "esbla-ordinary-wrapper-"));
    const observedPath = join(root, "observed.json");
    const source = `require("node:fs").writeFileSync(${JSON.stringify(observedPath)},JSON.stringify({nonce:process.env.ESBLA_BROWSER_CONTROL_NONCE,root:process.env.ESBLA_BROWSER_CONTROL_ROOT,real:process.env.ESBLA_BROWSER_REAL_EXECUTABLE}))`;
    try {
      const child = spawnOwnedWrapperController(
        process.execPath,
        ["-e", source],
        {
          ESBLA_BROWSER_CONTROL_NONCE: "ambient-nonce",
          ESBLA_BROWSER_CONTROL_ROOT: "/tmp/ambient-control",
          ESBLA_BROWSER_REAL_EXECUTABLE: "/tmp/ambient-browser",
        },
        { superviseBrowser: false },
      );
      const result = await childOutcome(child);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(await readFile(observedPath, "utf8")), {});
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("removes supervised control and profile roots when setup fails before PostgreSQL", async () => {
    const before = await browserTemporaryDirectories();
    const wrapper = spawnOwnedWrapperController(
      process.execPath,
      ["-e", "process.exit(0)"],
      { PATH: "/usr/bin:/bin" },
      { superviseBrowser: true },
    );
    const result = await childOutcome(wrapper);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, new RegExp(wrapperTemporaryRoot.replaceAll("/", "\\/")));
    assert.deepEqual(await browserTemporaryDirectories(), before);
  });

  it("retains replacement directories instead of recursively deleting unproved identity", async () => {
    const original = await mkdtemp(join(wrapperTemporaryRoot, "owned-root-"));
    const moved = `${original}.original`;
    const sentinel = join(original, "sentinel.txt");
    const owned = captureOwnedDirectory(await realpath(original), "test owned root");
    try {
      await rename(original, moved);
      await mkdir(original, { mode: 0o700 });
      await writeFile(sentinel, "must survive");
      await assert.rejects(
        () => cleanupExactOwnedDirectories([owned]),
        /Owned browser state cleanup is incomplete/,
      );
      assert.equal(await readFile(sentinel, "utf8"), "must survive");
      await access(moved);
    } finally {
      await rm(original, { force: true, recursive: true });
      await rm(moved, { force: true, recursive: true });
    }
  });

  it("redacts syntactically valid control paths before realpath validation", async () => {
    const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "early-redaction-"));
    const root = join(caseRoot, "missing-control");
    const launcher = join(root, "browser-launcher.sh");
    const ownership = join(root, "browser.ownership");
    const profile = join(caseRoot, "missing-profile");
    const nonce = "d".repeat(64);
    try {
      const child = spawn(process.execPath, [browserHarness], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ESBLA_BROWSER_CONTROL_NONCE: nonce,
          ESBLA_BROWSER_CONTROL_ROOT: root,
          ESBLA_BROWSER_LAUNCHER: launcher,
          ESBLA_BROWSER_OWNERSHIP_TOKEN: ownership,
          ESBLA_BROWSER_PROFILE_ROOT: profile,
          ESBLA_BROWSER_SUPERVISOR_PID: String(process.pid),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = await childOutcome(child);
      assert.equal(result.code, 1);
      for (const sensitive of [nonce, root, launcher, ownership, profile]) {
        assert.doesNotMatch(result.stderr, new RegExp(sensitive.replaceAll("/", "\\/")));
      }
      assert.match(result.stderr, /\[REDACTED\]/);
    } finally {
      await rm(caseRoot, { force: true, recursive: true });
    }
  });

  it("cancels launch intent when the harness crashes before launcher spawn", {
    timeout: 60_000,
  }, async () => {
    const beforeBrowserRoots = await browserTemporaryDirectories();
    const beforePostgresRoots = await postgresTemporaryDirectories();
    const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "intent-crash-"));
    const readyPath = join(caseRoot, "ready.json");
    const source = [
      'const {linkSync,unlinkSync,writeFileSync}=require("node:fs")',
      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",
      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
      'const tmp=root+"/.intent."+process.pid',
      'writeFileSync(tmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
      'linkSync(tmp,root+"/browser.intent")',
      "unlinkSync(tmp)",
      'for(let attempt=0;attempt<400&&!require("node:fs").existsSync(root+"/harness.retained");attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)',
      'if(!require("node:fs").existsSync(root+"/harness.retained"))process.exit(8)',
      `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({ready:true}))`,
      "process.exit(9)",
    ].join(";");
    try {
      const wrapper = spawnSupervisedPostgresWrapper(process.execPath, ["-e", source]);
      const outcome = childOutcome(wrapper, 60_000);
      await waitForFile(readyPath);
      const result = await outcome;
      assert.equal(result.code, 1);
      assert.deepEqual(await browserTemporaryDirectories(), beforeBrowserRoots, result.stderr);
      await assertNoNewPostgresTemporaryDirectories(beforePostgresRoots);
    } finally {
      await rm(caseRoot, { force: true, recursive: true });
    }
  });

  it("V1C3-AUDIT-002 retains roots for a no-intent detached exact launcher", {
    timeout: 90_000,
  }, async () => {
    const beforeBrowserRoots = await browserTemporaryDirectories();
    const beforePostgresRoots = await postgresTemporaryDirectories();
    const realSuiteRoot = realpathSync(wrapperTemporaryRoot);
    const caseRoot = mkdtempSync(join(realSuiteRoot, "no-intent-launcher-"));
    const caseRootOwned = captureOwnedDirectory(caseRoot, "no-intent launcher case root");
    const readyPath = join(caseRoot, "ready.json");
    const releasePath = join(caseRoot, "release");
    const shimReadyPath = join(caseRoot, "shim.ready");
    const stopPath = join(caseRoot, "shim.stop");
    const signalMarkerPath = join(caseRoot, "shim.signal");
    const shimSource = [
      "#!/bin/sh",
      "set -eu",
      `stop=${JSON.stringify(stopPath)}`,
      `ready=${JSON.stringify(shimReadyPath)}`,
      `signal_marker=${JSON.stringify(signalMarkerPath)}`,
      'trap \'printf "signal\\n" >> "$signal_marker"\' HUP INT TERM',
      ': > "$ready"',
      'while [ ! -f "$stop" ]; do sleep 0.025; done',
      "exit 0",
      "",
    ].join("\n");
    const source = [
      'const {spawn}=require("node:child_process")',
      'const {existsSync,writeFileSync}=require("node:fs")',
      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",
      "const profile=process.env.ESBLA_BROWSER_PROFILE_ROOT",
      "const launcher=process.env.ESBLA_BROWSER_LAUNCHER",
      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
      `const shimSource=${JSON.stringify(shimSource)}`,
      `const shimReadyPath=${JSON.stringify(shimReadyPath)}`,
      `const readyPath=${JSON.stringify(readyPath)}`,
      `const releasePath=${JSON.stringify(releasePath)}`,
      "writeFileSync(launcher,shimSource,{mode:0o700})",
      'const shim=spawn("/bin/sh",[launcher],{detached:true,env:process.env,stdio:"ignore"})',
      "shim.unref()",
      "for(let attempt=0;attempt<800&&!existsSync(shimReadyPath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",
      'if(!existsSync(shimReadyPath))throw new Error("detached shim did not become ready")',
      'writeFileSync(readyPath,JSON.stringify({launcher,nonce,profile,root,shim:shim.pid}),{flag:"wx",mode:0o600})',
      "for(let attempt=0;attempt<800&&!existsSync(releasePath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",
      'if(!existsSync(releasePath))throw new Error("private release was not published")',
      "process.exit(0)",
    ].join(";");

    let wrapperController;
    let ready;
    let shimIdentity;
    let controlOwned;
    let profileOwned;
    let observation;
    let primaryFailure;
    const cleanupFailures = [];
    try {
      const wrapper = spawnSupervisedPostgresWrapper(process.execPath, ["-e", source]);
      wrapperController = wrapper;
      const outcome = childOutcome(wrapper, 90_000);
      ready = await waitForFile(readyPath, 30_000);
      shimIdentity = captureStableProcessIdentity(ready.shim);
      controlOwned = captureOwnedDirectory(
        await realpath(ready.root),
        "no-intent retained control root",
      );
      profileOwned = captureOwnedDirectory(
        await realpath(ready.profile),
        "no-intent retained profile root",
      );
      await writePrivateStop(releasePath);
      const result = await outcome;
      const acquiredShimIdentity = shimIdentity;
      shimIdentity = captureStableProcessIdentity(acquiredShimIdentity.pid);
      assert.equal(shimIdentity.pid, acquiredShimIdentity.pid);
      assert.equal(shimIdentity.pgid, acquiredShimIdentity.pgid);
      assert.equal(shimIdentity.session, acquiredShimIdentity.session);
      assert.equal(shimIdentity.uid, acquiredShimIdentity.uid);
      assert.equal(shimIdentity.start, acquiredShimIdentity.start);
      assert.equal(shimIdentity.command, acquiredShimIdentity.command);
      const shimSessionObservation = readSemanticSessionObservation(shimIdentity);
      const sensitiveValues = Object.freeze([
        ready.nonce,
        ready.root,
        ready.profile,
        ready.launcher,
        realpathSync(browserToolingChromium.executablePath()),
      ]);
      observation = {
        code: result.code,
        rootsRetained:
          (await pathExists(ready.root)) === true && (await pathExists(ready.profile)) === true,
        sensitiveDiagnostic: !diagnosticsExcludeTrackedValues(result.stderr, sensitiveValues),
        sessionLeader:
          shimIdentity.pid === shimIdentity.pgid && isSemanticSessionLeader(shimSessionObservation),
        signal: result.signal,
        survivorDiagnostic: /unregistered browser launcher survived cancellation/i.test(
          result.stderr,
        ),
      };
    } catch (error) {
      primaryFailure = error;
    } finally {
      for (const path of [releasePath, stopPath]) {
        try {
          await writePrivateStop(path);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (shimIdentity) {
        try {
          await waitForExactProcessExit(shimIdentity, 10_000);
          const groupDeadline = Date.now() + 10_000;
          let members = readProcessGroupMembers(shimIdentity.pgid);
          while (members.length > 0 && Date.now() < groupDeadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
            members = readProcessGroupMembers(shimIdentity.pgid);
          }
          assert.deepEqual(members, [], "no-intent detached shim group remained live");
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (wrapperController) {
        try {
          await wrapperController.finish(90_000);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        assert.equal(
          await pathExists(signalMarkerPath),
          false,
          "no-intent detached shim was signaled",
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await cleanupExactOwnedDirectories([caseRootOwned]);
      } catch (error) {
        cleanupFailures.push(error);
      }
      const retainedRoots = [];
      for (const owned of [profileOwned, controlOwned]) {
        if (owned && (await pathExists(owned.path))) retainedRoots.push(owned);
      }
      if (retainedRoots.length > 0) {
        try {
          await cleanupExactOwnedDirectories(retainedRoots);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        await assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (primaryFailure && cleanupFailures.length > 0) {
      throw new AggregateError([primaryFailure, ...cleanupFailures]);
    }
    if (primaryFailure) throw primaryFailure;
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures);
    assert.deepEqual(observation, {
      code: 1,
      rootsRetained: true,
      sensitiveDiagnostic: false,
      sessionLeader: true,
      signal: null,
      survivorDiagnostic: true,
    });
  });

  it("V1C3-AUDIT-003 keeps process-group signaling private, validated, and retained-owner-only", async () => {
    const source = await readFile(withPostgres, "utf8");
    assert.deepEqual(
      collectProcessGroupAuthorityDiagnostics(source, "with-postgres", {
        allowedSourceSha256: authoritativeWithPostgresSourceSha256(),
      }),
      [],
      "generic or unvalidated process-group authority remains",
    );
  });

  it("V1C3-AUDIT-003 self-defends the private process-group authority oracle", async () => {
    const canonical = canonicalProcessGroupAuthoritySource();
    assert.deepEqual(collectProcessGroupAuthorityDiagnostics(canonical, "canonical-authority"), []);
    const mutations = [
      [
        "direct export",
        replaceExactlyOnce(
          canonical,
          "function signalProcessGroup",
          "export function signalProcessGroup",
          "direct signal export",
        ),
      ],
      ["alias export", `${canonical}\nexport { signalProcessGroup as leakedSignalAuthority };`],
      ["default export", `${canonical}\nexport default { processGroupExists };`],
      [
        "spread widening",
        replaceExactlyOnce(
          canonical,
          'new Set(["SIGINT", "SIGTERM", "SIGKILL"])',
          'new Set(["SIGINT", "SIGTERM", ...["SIGKILL", "SIGHUP"]])',
          "spread signal widening",
        ),
      ],
      ["set mutation", `${canonical}\nsupportedProcessGroupSignals.add("SIGHUP");`],
      [
        "dead signal validator",
        replaceExactlyOnce(
          canonical,
          "  assertPositiveProcessGroupId(processGroupId);\n  if (!supportedProcessGroupSignals.has(signal)) {",
          "  if (false) assertPositiveProcessGroupId(processGroupId);\n  if (!supportedProcessGroupSignals.has(signal)) {",
          "dead signal validation",
        ),
      ],
      [
        "dead probe validator",
        replaceExactlyOnce(
          canonical,
          '  assertPositiveProcessGroupId(processGroupId);\n  if (process.platform === "win32") return false;',
          '  if (false) assertPositiveProcessGroupId(processGroupId);\n  if (process.platform === "win32") return false;',
          "dead probe validation",
        ),
      ],
      ["authority alias", `${canonical}\nconst leakedSignal = signalProcessGroup;`],
      ["generic drain", `${canonical}\nfunction drainProcessGroup(){}`],
      [
        "raw group kill",
        `${canonical}\nfunction unrelated(processGroupId){process.kill(-processGroupId,"SIGTERM")}`,
      ],
      [
        "algebraic raw group kill",
        `${canonical}\nfunction unrelated(processGroupId){process.kill(0-processGroupId,"SIGTERM")}`,
      ],
      [
        "computed raw group kill",
        `${canonical}\nfunction unrelated(processGroupId){process[["ki","ll"].join("")](0-processGroupId,"SIGTERM")}`,
      ],
      [
        "aliased process authority",
        `${canonical}\nconst processAlias=process;function unrelated(processGroupId){processAlias.kill(0-processGroupId,"SIGTERM")}`,
      ],
      [
        "unrelated owner",
        `${canonical}\nfunction unrelatedOwner(){signalProcessGroup(1,"SIGTERM")}`,
      ],
      [
        "dead owner call",
        replaceExactlyOnce(
          canonical,
          "  signalProcessGroup(identity.pgid, signal);",
          "  if (false) signalProcessGroup(identity.pgid, signal);",
          "dead retained harness call",
        ),
      ],
      [
        "removed sanitized self-signal diagnostic",
        replaceExactlyOnce(
          canonical,
          "    if (failure) process.stderr.write(`${sanitizeSupervisedFailure(failure)}\\n`);",
          "    void failure;",
          "sanitized self-signal diagnostic",
        ),
      ],
      [
        "dead retained browser boundary guard",
        replaceInTopLevelFunctionExactlyOnce(
          canonical,
          "signalRetainedBrowser",
          '    throw new Error("Retained browser identity changed at the signal boundary");',
          '    if (false) throw new Error("Retained browser identity changed at the signal boundary");',
          "dead retained browser boundary guard",
        ),
      ],
      [
        "dead retained browser kill guard",
        replaceInTopLevelFunctionExactlyOnce(
          canonical,
          "drainRetainedBrowserGroup",
          '    throw new Error("Retained browser identity changed at the SIGKILL boundary");',
          '    if (false) throw new Error("Retained browser identity changed at the SIGKILL boundary");',
          "dead retained browser kill guard",
        ),
      ],
      [
        "dead retained harness FD9 guard",
        replaceInTopLevelFunctionExactlyOnce(
          canonical,
          "signalRetainedHarness",
          '    throw new Error("Retained harness identity changed before group signaling");',
          '    if (false) throw new Error("Retained harness identity changed before group signaling");',
          "dead retained harness FD9 guard",
        ),
      ],
      [
        "dead retained harness boundary guard",
        replaceInTopLevelFunctionExactlyOnce(
          canonical,
          "signalRetainedHarness",
          '    throw new Error("Retained harness identity changed at the signal boundary");',
          '    if (false) throw new Error("Retained harness identity changed at the signal boundary");',
          "dead retained harness boundary guard",
        ),
      ],
    ];
    for (const [name, mutated] of mutations) {
      assert.notDeepEqual(
        collectProcessGroupAuthorityDiagnostics(mutated, "mutated-authority"),
        [],
        name,
      );
    }

    const fullSource = await readFile(withPostgres, "utf8");
    const fullSourceSha256 = sourceSha256(fullSource);
    const [causalWithPostgresRedSourceSha256, exactWithPostgresGreenSourceSha256] =
      authoritativeWithPostgresSourceSha256();
    const expectedSemanticBaseline =
      fullSourceSha256 === causalWithPostgresRedSourceSha256
        ? [
            "full-authority:assertPositiveProcessGroupId-noncanonical",
            "full-authority:closed-signal-set",
            "full-authority:generic-drain-present",
            "full-authority:processGroupExists-noncanonical",
            "full-authority:protected-authority-exported",
            "full-authority:retained-owner-call-multiset",
            "full-authority:signalProcessGroup-noncanonical",
          ]
        : fullSourceSha256 === exactWithPostgresGreenSourceSha256
          ? []
          : undefined;
    assert.ok(expectedSemanticBaseline, "with-postgres source did not match a frozen Red or Green");
    const semanticBaseline = collectProcessGroupAuthorityDiagnostics(fullSource, "full-authority");
    assert.deepEqual(
      semanticBaseline,
      expectedSemanticBaseline,
      "with-postgres semantic baseline changed",
    );
    const baseline = collectProcessGroupAuthorityDiagnostics(fullSource, "full-authority", {
      allowedSourceSha256: authoritativeWithPostgresSourceSha256(),
    });
    assert.deepEqual(baseline, semanticBaseline, "exact source identity changed the baseline");
    assert.equal(
      baseline.some((entry) => entry.endsWith(":alternate-signal-authority")),
      false,
      "authoritative source did not satisfy its closed executable authority contract",
    );
    const harmlessOrdinaryRefactor = replaceInTopLevelFunctionExactlyOnce(
      fullSource,
      "postgresIsRunning",
      "  if (result.status === 0) return true;",
      "  if ((result.status === 0)) return true;",
      "harmless ordinary PostgreSQL refactor",
    );
    assert.deepEqual(
      collectProcessGroupAuthorityDiagnostics(
        harmlessOrdinaryRefactor,
        "harmless-ordinary-refactor",
      ).map((entry) => entry.replace("harmless-ordinary-refactor:", "full-authority:")),
      baseline,
      "process-group oracle rejected an unrelated harmless refactor",
    );
    const harmlessCapabilityRefactor = `${fullSource}\nconst harmlessMetadata={safe:1};const harmlessKey="safe";const harmlessMaximum=globalThis.Math.max(1,2);const harmlessReflection=Reflect.get(harmlessMetadata,"safe");void harmlessMetadata[harmlessKey];void harmlessMaximum;void harmlessReflection;`;
    assert.deepEqual(
      collectProcessGroupAuthorityDiagnostics(
        harmlessCapabilityRefactor,
        "harmless-capability-refactor",
      ).map((entry) => entry.replace("harmless-capability-refactor:", "full-authority:")),
      baseline,
      "process-group oracle rejected benign computed or reflective access",
    );
    const alternateAuthorityMutations = [
      ["retained owner alias", `${fullSource}\nconst leakedOwner=signalRetainedBrowser;`],
      [
        "retained owner export",
        `${fullSource}\nexport { signalRetainedHarness as leakedHarnessSignal };`,
      ],
      ["extra retained owner call", `${fullSource}\nsignalRetainedBrowser("SIGTERM");`],
      ["child kill member", `${fullSource}\nactiveChild?.kill("SIGTERM");`],
      ["external kill executable", `${fullSource}\nspawnSync("/bin/kill",["-TERM","1"]);`],
      ["external pkill executable", `${fullSource}\nspawnSync("/usr/bin/pkill",["-TERM","x"]);`],
      ["shell kill executable", `${fullSource}\nspawnSync("/bin/sh",["-c","kill -TERM 1"]);`],
      [
        "execFile child-process authority",
        `${replaceExactlyOnce(
          fullSource,
          'import { spawn, spawnSync } from "node:child_process";',
          'import { execFile, spawn, spawnSync } from "node:child_process";',
          "execFile import",
        )}\nexecFile("/bin/kill",["-TERM","1"]);`,
      ],
      [
        "node process kill import",
        `${fullSource}\nimport { kill as importedKill } from "node:process";\nimportedKill(1,"SIGTERM");`,
      ],
      ["required node process kill", `${fullSource}\nrequire("node:process").kill(1,"SIGTERM");`],
      ["evaluated signal program", `${fullSource}\neval('process.kill(1,"SIGTERM")');`],
      ["Function signal program", `${fullSource}\nFunction('process.kill(1,"SIGTERM")')();`],
      ["native signal binding", `${fullSource}\nprocess.binding("spawn_sync");`],
      ["internal process kill", `${fullSource}\nprocess._kill(1,"SIGTERM");`],
      [
        "computed child kill member",
        `${fullSource}\nactiveChild[["ki","ll"].join("")]("SIGTERM");`,
      ],
      [
        "computed destructured child kill member",
        `${fullSource}\nconst {[["ki","ll"].join("")]:computedKill}=activeChild;computedKill.call(activeChild,"SIGTERM");`,
      ],
      [
        "computed global evaluator",
        `${fullSource}\nglobalThis[["ev","al"].join("")](["process",".kill(1,\\\"SIGTERM\\\")"].join(""));`,
      ],
      [
        "reflective process kill",
        `${fullSource}\nconst reflectedProcess=Reflect.get(globalThis,"process");Reflect.apply(Reflect.get(reflectedProcess,"kill"),reflectedProcess,[1,"SIGTERM"]);`,
      ],
      [
        "neutral imported stop authority",
        `${fullSource}\nimport { stopChild as neutralStop } from "./hr-browser-harness.mjs";\nawait neutralStop(activeChild);`,
      ],
      [
        "arbitrary imported helper execution",
        `${fullSource}\nimport { withTimeout as importedTimeout } from "./hr-browser-harness.mjs";\nawait importedTimeout("escape", async () => undefined);`,
      ],
      [
        "side-effect data import",
        `${fullSource}\nimport "data:text/javascript,globalThis%2Eprocess%2Ekill(1%2C%22SIGTERM%22)";`,
      ],
      [
        "semicolon shell kill",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "renderBrowserLauncherShim",
          "set -eu",
          `set -eu\ntrue; ${["ki", "ll"].join("")} -TERM 1`,
          "semicolon shell kill",
        ),
      ],
      [
        "conditional shell kill",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "renderBrowserLauncherShim",
          "set -eu",
          `set -eu\ntrue && ${["ki", "ll"].join("")} -TERM 1`,
          "conditional shell kill",
        ),
      ],
      [
        "computed template shell kill",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "renderBrowserLauncherShim",
          "set -eu",
          'set -eu\ntrue; ${"ki" + "ll"} -TERM 1',
          "computed template shell kill",
        ),
      ],
      [
        "dynamic Playwright factory base",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "createBrowserControl",
          '      join(repositoryRoot, "scripts/test/browser-tooling/package.json"),',
          '      join(tmpdir(), "alternate-browser-tooling.cjs"),',
          "dynamic Playwright factory base",
        ),
      ],
      [
        "dynamic Playwright module specifier",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "createBrowserControl",
          '    const { chromium } = playwrightRequire("@playwright/test");',
          '    const { chromium } = playwrightRequire(superviseBrowser ? "@playwright/test" : "./alternate.mjs");',
          "dynamic Playwright module specifier",
        ),
      ],
      [
        "ignored createRequire factory result",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "createBrowserControl",
          '    const playwrightRequire = createRequire(\n      join(repositoryRoot, "scripts/test/browser-tooling/package.json"),\n    );',
          '    createRequire(\n      join(repositoryRoot, "scripts/test/browser-tooling/package.json"),\n    );\n    const playwrightRequire = () => ({ chromium: { executablePath: () => "/bin/true" } });',
          "ignored createRequire factory result",
        ),
      ],
      [
        "returned Chromium capability expansion",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "createBrowserControl",
          '    const { chromium } = playwrightRequire("@playwright/test");',
          '    const { chromium } = playwrightRequire("@playwright/test");\n    await chromium.launch({ executablePath: "/bin/true" });',
          "returned Chromium capability expansion",
        ),
      ],
      [
        "severed Chromium executable provenance",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "createBrowserControl",
          "    const expectedRealExecutable = realpathSync(chromium.executablePath());",
          '    void realpathSync(chromium.executablePath());\n    const expectedRealExecutable = "/bin/true";',
          "severed Chromium executable provenance",
        ),
      ],
      [
        "dead Chromium executable validation",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "createBrowserControl",
          "    accessSync(expectedRealExecutable, fsConstants.X_OK);",
          "    if (false) accessSync(expectedRealExecutable, fsConstants.X_OK);",
          "dead Chromium executable validation",
        ),
      ],
      [
        "substituted downstream Chromium executable",
        replaceInTopLevelFunctionExactlyOnce(
          replaceInTopLevelFunctionExactlyOnce(
            fullSource,
            "createBrowserControl",
            '      join(root, "browser.registration"),\n      expectedRealExecutable,\n    ]) {',
            '      join(root, "browser.registration"),\n      "/bin/true",\n    ]) {',
            "substituted sensitive Chromium executable",
          ),
          "createBrowserControl",
          "      createdAt: metadata.birthtimeMs || metadata.ctimeMs,\n      expectedRealExecutable,\n      harnessOwnership,",
          '      createdAt: metadata.birthtimeMs || metadata.ctimeMs,\n      expectedRealExecutable: "/bin/true",\n      harnessOwnership,',
          "substituted returned Chromium executable",
        ),
      ],
      [
        "command carrier reassignment",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "run",
          "  const { capture = false, ...spawnOptions } = options;\n  const result = spawnSync",
          '  const { capture = false, ...spawnOptions } = options;\n  commandPath = ["/bin", "kill"].join("/");\n  const result = spawnSync',
          "command carrier reassignment",
        ),
      ],
      [
        "argument carrier reassignment",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "run",
          "  const { capture = false, ...spawnOptions } = options;\n  const result = spawnSync",
          '  const { capture = false, ...spawnOptions } = options;\n  commandArgs = ["-TERM", "1"];\n  const result = spawnSync',
          "argument carrier reassignment",
        ),
      ],
      [
        "raw option carrier mutation",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "run",
          "  const { capture = false, ...spawnOptions } = options;\n  const result = spawnSync",
          "  const { capture = false, ...spawnOptions } = options;\n  spawnOptions.shell = true;\n  const result = spawnSync",
          "raw option carrier mutation",
        ),
      ],
      [
        "aliased raw option carrier mutation",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "run",
          "  const { capture = false, ...spawnOptions } = options;\n  const result = spawnSync",
          "  const { capture = false, ...spawnOptions } = options;\n  const escapedSpawnOptions = spawnOptions;\n  escapedSpawnOptions.shell = true;\n  const result = spawnSync",
          "aliased raw option carrier mutation",
        ),
      ],
      [
        "original option parameter mutation",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "run",
          "  const { capture = false, ...spawnOptions } = options;",
          "  options.shell = true;\n  const { capture = false, ...spawnOptions } = options;",
          "original option parameter mutation",
        ),
      ],
      [
        "legacy arguments option mutation",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "run",
          "  const { capture = false, ...spawnOptions } = options;",
          "  if (arguments[2]) arguments[2].shell = true;\n  const { capture = false, ...spawnOptions } = options;",
          "legacy arguments option mutation",
        ),
      ],
      [
        "ordinary raw option carrier mutation",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "runOrdinarySync",
          "  const { capture = false, ...spawnOptions } = options;\n  const result = spawnSync",
          "  const { capture = false, ...spawnOptions } = options;\n  spawnOptions.shell = true;\n  const result = spawnSync",
          "ordinary raw option carrier mutation",
        ),
      ],
      [
        "raw execution ignores command capability",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "run",
          "  const result = spawnSync(commandPath, commandArgs, {",
          `  const result = spawnSync(["/bin", ${JSON.stringify(["ki", "ll"].join(""))}].join("/"), ["-TERM", "1"], {`,
          "raw execution command substitution",
        ),
      ],
      [
        "raw execution enables shell internally",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "run",
          "    timeout: 30_000,\n    ...spawnOptions,",
          "    timeout: 30_000,\n    ...spawnOptions,\n    shell: true,",
          "raw execution shell override",
        ),
      ],
      [
        "pg_ctl signal subcommand",
        replaceExactlyOnce(
          fullSource,
          '        run(executable("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-t", "8", "-w", "stop"], {',
          `        run(executable("pg_ctl"), ["-D", dataDirectory, ${JSON.stringify(["ki", "ll"].join(""))}, "TERM", "1"], {`,
          "pg_ctl signal subcommand",
        ),
      ],
      [
        "dynamic pg_ctl argv carrier",
        replaceExactlyOnce(
          fullSource,
          '        run(executable("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-t", "8", "-w", "stop"], {',
          '        const pgCtlStopArgs = ["-D", dataDirectory, "-m", "fast", "-t", "8", "-w", "stop"];\n        run(executable("pg_ctl"), pgCtlStopArgs, {',
          "dynamic pg_ctl argv carrier",
        ),
      ],
      [
        "unsafe pg_ctl run options",
        replaceExactlyOnce(
          fullSource,
          '        run(executable("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-t", "8", "-w", "stop"], {\n          timeout: 10_000,',
          '        run(executable("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-t", "8", "-w", "stop"], {\n          shell: true,\n          timeout: 10_000,',
          "unsafe pg_ctl run options",
        ),
      ],
      [
        "second psql command",
        replaceExactlyOnce(
          fullSource,
          "      `ALTER SCHEMA public OWNER TO ${migrationRole}`,\n    ]);\n    throwIfInterrupted();\n\n    if (!receivedSignal) {",
          '      `ALTER SCHEMA public OWNER TO ${migrationRole}`,\n      "--command",\n      "SELECT 1",\n    ]);\n    throwIfInterrupted();\n\n    if (!receivedSignal) {',
          "second psql command",
        ),
      ],
      [
        "synthesized run executable",
        replaceExactlyOnce(
          fullSource,
          '    pgBin = run("pg_config", ["--bindir"], { capture: true });',
          '    pgBin = run(["/bin", "kill"].join("/"), ["-TERM", "1"], { capture: true });',
          "synthesized run executable",
        ),
      ],
      [
        "synthesized ordinary executable",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "runOrdinaryWithPostgres",
          '  const pgBin = runOrdinarySync("pg_config", ["--bindir"], { capture: true });',
          '  const pgBin = runOrdinarySync(["/bin", "kill"].join("/"), ["-TERM", "1"], { capture: true });',
          "synthesized ordinary executable",
        ),
      ],
      ["direct signal gateway", `${fullSource}\nhandleSignal("SIGTERM");`],
      ["synthetic process signal event", `${fullSource}\nprocess.emit("SIGTERM");`],
      [
        "recovered signal handler",
        `${fullSource}\nfor(const handler of signalHandlers.values())handler();`,
      ],
      [
        "retained identity trust weakening",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "sameRetainedBrowserIdentity",
          "  return Boolean(",
          "  return Boolean(true ||",
          "retained identity trust weakening",
        ),
      ],
      [
        "weakened browser-root cleanup absence gate",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "cleanupBrowserRoots",
          '  if (activeBrowserIdentity && processGroupExists(activeBrowserIdentity.pgid)) {\n    throw new Error("Browser process-group absence is unproved; owned state was retained");',
          '  if (activeBrowserIdentity && false && processGroupExists(activeBrowserIdentity.pgid)) {\n    throw new Error("Browser process-group absence is unproved; owned state was retained");',
          "weakened browser-root cleanup absence gate",
        ),
      ],
      [
        "dead browser loader chain",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "createBrowserControl",
          '    const playwrightRequire = createRequire(\n      join(repositoryRoot, "scripts/test/browser-tooling/package.json"),\n    );\n    const { chromium } = playwrightRequire("@playwright/test");\n    const expectedRealExecutable = realpathSync(chromium.executablePath());\n    accessSync(expectedRealExecutable, fsConstants.X_OK);',
          '    if (false) {\n      const playwrightRequire = createRequire(\n        join(repositoryRoot, "scripts/test/browser-tooling/package.json"),\n      );\n      const { chromium } = playwrightRequire("@playwright/test");\n      const expectedRealExecutable = realpathSync(chromium.executablePath());\n      accessSync(expectedRealExecutable, fsConstants.X_OK);\n    }',
          "dead browser loader chain",
        ),
      ],
      [
        "aliased supervised-sensitive sink",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "createBrowserControl",
          "    accessSync(expectedRealExecutable, fsConstants.X_OK);",
          "    accessSync(expectedRealExecutable, fsConstants.X_OK);\n    const alternateSensitiveValues = supervisedSensitiveValues;\n    alternateSensitiveValues.add = () => alternateSensitiveValues;",
          "aliased supervised-sensitive sink",
        ),
      ],
      ["cleared supervised-sensitive sink", `${fullSource}\nsupervisedSensitiveValues.clear();`],
      [
        "mutated signal-set intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          "Set.prototype.has = () => true;\n\nif (isMain && !superviseBrowser) {",
          "mutated signal-set intrinsic",
        ),
      ],
      [
        "mutated signal-set add intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          "Set.prototype.add = function () { return this; };\n\nif (isMain && !superviseBrowser) {",
          "mutated signal-set add intrinsic",
        ),
      ],
      [
        "mutated diagnostic-redaction intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          "String.prototype.replaceAll = function () { return this; };\n\nif (isMain && !superviseBrowser) {",
          "mutated diagnostic-redaction intrinsic",
        ),
      ],
      [
        "mutated qualified signal-set intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          "globalThis.Set.prototype.has = () => true;\n\nif (isMain && !superviseBrowser) {",
          "mutated qualified signal-set intrinsic",
        ),
      ],
      [
        "mutated aliased signal-set intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          "const { prototype: setPrototype } = globalThis.Set;\nsetPrototype.has = () => true;\n\nif (isMain && !superviseBrowser) {",
          "mutated aliased signal-set intrinsic",
        ),
      ],
      [
        "mutated reflective diagnostic-redaction intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          'Reflect.set(globalThis.String.prototype, "replaceAll", function () { return this; });\n\nif (isMain && !superviseBrowser) {',
          "mutated reflective diagnostic-redaction intrinsic",
        ),
      ],
      [
        "mutated carrier signal-set intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          "const holder = { prototype: globalThis.Set.prototype };\nholder.prototype.has = () => true;\n\nif (isMain && !superviseBrowser) {",
          "mutated carrier signal-set intrinsic",
        ),
      ],
      [
        "mutated recovered signal-set intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          "const recoveredSetPrototype = Object.getPrototypeOf(new Set());\nrecoveredSetPrototype.has = () => true;\n\nif (isMain && !superviseBrowser) {",
          "mutated recovered signal-set intrinsic",
        ),
      ],
      [
        "mutated computed signal-set intrinsic",
        replaceExactlyOnce(
          fullSource,
          "if (isMain && !superviseBrowser) {",
          'const computedSetMember = "has";\nSet.prototype[computedSetMember] = () => true;\n\nif (isMain && !superviseBrowser) {',
          "mutated computed signal-set intrinsic",
        ),
      ],
      [
        "source whitespace changed",
        replaceExactlyOnce(
          fullSource,
          "const modulePath = fileURLToPath(import.meta.url);",
          "  const modulePath = fileURLToPath(import.meta.url);",
          "source whitespace changed",
        ),
      ],
      [
        "execution surface binding removed",
        replaceExactlyOnce(
          fullSource,
          'import { spawn, spawnSync } from "node:child_process";',
          'import { spawnSync } from "node:child_process";',
          "execution surface binding removed",
        ),
      ],
      [
        "dead setup browser-root cleanup call",
        replaceExactlyOnce(
          fullSource,
          "      try {\n        await cleanupBrowserRoots();\n      } catch (cleanupError) {",
          "      try {\n        if (false) await cleanupBrowserRoots();\n      } catch (cleanupError) {",
          "dead setup browser-root cleanup call",
        ),
      ],
      [
        "dead browser ACK publication",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "monitorBrowserRegistration",
          "      publishBrowserAck(browserControl, identity);",
          "      if (false) publishBrowserAck(browserControl, identity);",
          "dead browser ACK publication",
        ),
      ],
      [
        "alternate asynchronous browser ACK publication",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "runChild",
          "  if (receivedSignal) {\n    return;\n  }\n\n  activeHarnessExitReceipt = undefined;",
          '  if (receivedSignal) {\n    return;\n  }\n\n  if (superviseBrowser) {\n    const { ackPath: alternateAckPath } = browserControl;\n    await writeFile(alternateAckPath, "nonce=x\\npid=1\\n", { flag: "wx", mode: 0o600 });\n  }\n\n  activeHarnessExitReceipt = undefined;',
          "alternate asynchronous browser ACK publication",
        ),
      ],
      [
        "direct browser ACK publication",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "monitorBrowserRegistration",
          "      if (receivedSignal || cancellationPublishedAt) return identity;",
          '      writeFileSync(browserControl.ackPath, "nonce=x\\npid=1\\n");\n      if (receivedSignal || cancellationPublishedAt) return identity;',
          "direct browser ACK publication",
        ),
      ],
      [
        "weakened cancellation ACK guard polarity",
        replaceInTopLevelFunctionExactlyOnce(
          fullSource,
          "monitorBrowserRegistration",
          "if (receivedSignal || cancellationPublishedAt) return identity;",
          "if (receivedSignal && cancellationPublishedAt) return identity;",
          "weakened cancellation ACK guard polarity",
        ),
      ],
      [
        "unsanitized stderr publication",
        `${fullSource}\nprocess.stderr.write(String(signalFailure));`,
      ],
    ];
    for (const [name, mutated] of alternateAuthorityMutations) {
      const mutationDiagnostics = collectProcessGroupAuthorityDiagnostics(
        mutated,
        "mutated-full-authority",
        { allowedSourceSha256: authoritativeWithPostgresSourceSha256() },
      );
      assert.notDeepEqual(mutationDiagnostics, baseline, name);
      assert.equal(
        mutationDiagnostics.some((entry) => entry.endsWith(":alternate-signal-authority")),
        true,
        `${name} bypassed the closed executable authority contract`,
      );
    }
  });

  it("V1C3-AUDIT-004 rejects multiply-linked cancellation and retains roots", {
    timeout: 90_000,
  }, async () => {
    const beforeBrowserRoots = await browserTemporaryDirectories();
    const beforePostgresRoots = await postgresTemporaryDirectories();
    const realSuiteRoot = realpathSync(wrapperTemporaryRoot);
    const caseRoot = mkdtempSync(join(realSuiteRoot, "linked-cancellation-"));
    const caseRootOwned = captureOwnedDirectory(caseRoot, "linked cancellation case root");
    const heldPath = join(caseRoot, "held-cancellation");
    const readyPath = join(caseRoot, "ready.json");
    const releasePath = join(caseRoot, "release");
    const source = [
      'const {existsSync,linkSync,unlinkSync,writeFileSync}=require("node:fs")',
      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",
      "const profile=process.env.ESBLA_BROWSER_PROFILE_ROOT",
      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
      `const heldPath=${JSON.stringify(heldPath)}`,
      `const readyPath=${JSON.stringify(readyPath)}`,
      `const releasePath=${JSON.stringify(releasePath)}`,
      'for(let attempt=0;attempt<800&&!existsSync(root+"/harness.retained");attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)',
      'if(!existsSync(root+"/harness.retained"))throw new Error("harness retention was not published")',
      'writeFileSync(heldPath,"nonce="+nonce+"\\n",{flag:"wx",mode:0o600})',
      'linkSync(heldPath,root+"/browser.cancelled")',
      'const temporary=root+"/.intent."+process.pid',
      'writeFileSync(temporary,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
      'linkSync(temporary,root+"/browser.intent")',
      "unlinkSync(temporary)",
      'writeFileSync(readyPath,JSON.stringify({cancellation:root+"/browser.cancelled",nonce,profile,root}),{flag:"wx",mode:0o600})',
      "for(let attempt=0;attempt<800&&!existsSync(releasePath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",
      'if(!existsSync(releasePath))throw new Error("private release was not published")',
      "process.exit(0)",
    ].join(";");

    let wrapperController;
    let ready;
    let controlOwned;
    let profileOwned;
    let observation;
    let primaryFailure;
    const cleanupFailures = [];
    try {
      const wrapper = spawnSupervisedPostgresWrapper(process.execPath, ["-e", source]);
      wrapperController = wrapper;
      const outcome = childOutcome(wrapper, 90_000);
      ready = await waitForFile(readyPath, 30_000);
      controlOwned = captureOwnedDirectory(
        await realpath(ready.root),
        "linked cancellation retained control root",
      );
      profileOwned = captureOwnedDirectory(
        await realpath(ready.profile),
        "linked cancellation retained profile root",
      );
      const heldBefore = statSync(heldPath, { bigint: true });
      const cancellationBefore = statSync(ready.cancellation, { bigint: true });
      await writePrivateStop(releasePath);
      const result = await outcome;
      const cancellationRetained = await pathExists(ready.cancellation);
      const heldAfter = statSync(heldPath, { bigint: true });
      const cancellationAfter = cancellationRetained
        ? statSync(ready.cancellation, { bigint: true })
        : undefined;
      const sensitiveValues = [
        ready.nonce,
        ready.root,
        ready.profile,
        ready.cancellation,
        heldPath,
      ];
      observation = {
        code: result.code,
        diagnostic: /browser cancellation record is invalid/i.test(result.stderr),
        exactInitialAlias:
          heldBefore.dev === cancellationBefore.dev &&
          heldBefore.ino === cancellationBefore.ino &&
          heldBefore.nlink === 2n &&
          cancellationBefore.nlink === 2n,
        exactRetainedAlias:
          heldAfter.dev === cancellationAfter?.dev &&
          heldAfter.ino === cancellationAfter?.ino &&
          heldAfter.nlink === 2n &&
          cancellationAfter?.nlink === 2n,
        rootsRetained:
          (await pathExists(ready.root)) === true && (await pathExists(ready.profile)) === true,
        sensitiveDiagnostic: sensitiveValues.some((value) => result.stderr.includes(value)),
        signal: result.signal,
      };
    } catch (error) {
      primaryFailure = error;
    } finally {
      try {
        await writePrivateStop(releasePath);
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (wrapperController) {
        try {
          await wrapperController.finish(90_000);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        await cleanupExactOwnedDirectories([caseRootOwned]);
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (ready && (await pathExists(ready.cancellation))) {
        try {
          assert.equal(
            statSync(ready.cancellation, { bigint: true }).nlink,
            1n,
            "cancellation alias remained after exact external-root cleanup",
          );
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      const retainedRoots = [];
      for (const owned of [profileOwned, controlOwned]) {
        if (owned && (await pathExists(owned.path))) retainedRoots.push(owned);
      }
      if (retainedRoots.length > 0) {
        try {
          await cleanupExactOwnedDirectories(retainedRoots);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        await assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (primaryFailure && cleanupFailures.length > 0) {
      throw new AggregateError([primaryFailure, ...cleanupFailures]);
    }
    if (primaryFailure) throw primaryFailure;
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures);
    assert.deepEqual(observation, {
      code: 1,
      diagnostic: true,
      exactInitialAlias: true,
      exactRetainedAlias: true,
      rootsRetained: true,
      sensitiveDiagnostic: false,
      signal: null,
    });
  });

  it("cleans owned state when BrowserServer listen is rejected", {
    timeout: 90_000,
  }, async () => {
    const beforeBrowserRoots = await browserTemporaryDirectories();
    const beforePostgresRoots = await postgresTemporaryDirectories();
    const { port, server } = await listenOnEphemeralPort();
    const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");
    const source = [
      'const {linkSync,unlinkSync,writeFileSync}=require("node:fs")',
      'const {createRequire}=require("node:module")',
      `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,
      'const {chromium}=requirePlaywright("@playwright/test")',
      "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",
      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
      'const tmp=root+"/.intent."+process.pid',
      'writeFileSync(tmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
      'linkSync(tmp,root+"/browser.intent")',
      "unlinkSync(tmp)",
      "process.env.TMPDIR=process.env.ESBLA_BROWSER_PROFILE_ROOT",
      "process.env.ESBLA_BROWSER_REAL_EXECUTABLE=chromium.executablePath()",
      `(async()=>{try{const browser=await chromium.launchServer({executablePath:process.env.ESBLA_BROWSER_LAUNCHER,handleSIGHUP:false,handleSIGINT:false,handleSIGTERM:false,headless:true,host:"127.0.0.1",port:${port}});await browser.close();process.exit(0)}catch{process.exit(7)}})()`,
    ].join(";");
    try {
      const wrapper = spawnSupervisedPostgresWrapper(process.execPath, ["-e", source]);
      const result = await childOutcome(wrapper, 90_000);
      assert.equal(result.code, 1, result.stderr);
      assert.deepEqual(await browserTemporaryDirectories(), beforeBrowserRoots);
      await assertNoNewPostgresTemporaryDirectories(beforePostgresRoots);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it("Red G rejects a mutated semantic session-leader observation", {
    timeout: 150_000,
  }, async () => {
    const beforePostgresRoots = await postgresTemporaryDirectories();
    const beforeBrowserRoots = await browserTemporaryDirectories();
    const beforeSuiteEntries = (await readdir(wrapperTemporaryRoot)).sort();
    const controllerBaseline = Object.freeze({
      active: activeWrapperControllers.size,
      completed: completedWrapperControllers.length,
      descriptors: openWrapperOwnershipDescriptors.size,
      identities: recordedWrapperIdentities.length,
    });
    const boundaryMarker = Object.freeze(Object.create(null));
    const acquisitionReceipts = [];
    let exactOwners = Object.freeze([]);
    let fixturePrivateStopRoot;
    let fixturePrivateStopOwned;
    let signalEvidenceRoot;
    let signalEvidenceOwned;
    let caseRoot;
    let caseRootOwned;
    let helperCallAttempted = false;
    let observedError;
    let orchestrationError;
    let observerReachCount = 0;
    let mutationCount = 0;
    let mutationWasExact = false;
    let stopPublications = Object.freeze([]);
    let exactAbsenceResults = Object.freeze([]);
    let rootCapabilityResults = Object.freeze([]);
    let preCleanupResidueResults = Object.freeze([]);
    let rootCleanupResults = Object.freeze([]);
    let residueResults = Object.freeze([]);
    let exactReceiptOwnerMappings = false;
    let exactStopResults = false;
    let helperCloseAndJoinCompleted = false;
    let exactIdentityAbsenceResults = false;
    let exactRootCapabilityResults = false;
    let preCleanupResidueGreen = false;
    let controllerStateUnchanged = false;

    try {
      signalEvidenceRoot = await realpath(
        await mkdtemp(join(wrapperTemporaryRoot, "red-g-signal-evidence-")),
      );
      signalEvidenceOwned = Object.freeze(
        captureOwnedDirectory(signalEvidenceRoot, "Red G signal evidence root"),
      );
      fixturePrivateStopRoot = await realpath(
        await mkdtemp(join(wrapperTemporaryRoot, "red-g-private-stops-")),
      );
      fixturePrivateStopOwned = Object.freeze(
        captureOwnedDirectory(fixturePrivateStopRoot, "Red G fixture private-stop root"),
      );
      try {
        helperCallAttempted = true;
        await runMalformedCancellationIsolationCase({
          afterFixtureIdentityCapture(owner) {
            if (owner.stopPath !== exactOwners[0]?.stopPath) return;
            mutationCount += 1;
            const retainedIdentity = owner.identity;
            const original = owner.sessionObservation;
            const forgedIdentity = Object.freeze(
              original.platform === "linux"
                ? { ...original.identity, session: original.identity.pid + 1 }
                : { ...original.identity },
            );
            const forged = Object.freeze({
              ...original,
              identity: forgedIdentity,
              state:
                original.platform === "darwin"
                  ? original.state.replaceAll("s", "")
                  : original.state,
            });
            owner.sessionObservation = forged;
            mutationWasExact =
              owner.identity === retainedIdentity &&
              sameProcessIdentity(retainedIdentity, original.identity) &&
              !isSemanticSessionLeader(forged);
          },
          beforeControllerAcquisition() {
            observerReachCount += 1;
            throw boundaryMarker;
          },
          fixturePrivateStopRoot,
          fixtureSignalEvidenceRoot: signalEvidenceRoot,
          async onFixturesCreated(context) {
            caseRoot = context.caseRoot;
            caseRootOwned = Object.freeze(
              captureOwnedDirectory(await realpath(caseRoot), "Red G malformed-case root"),
            );
            for (const [index, fixture] of context.fixtures.entries()) {
              acquisitionReceipts.push(
                independentCooperativeReceipt(
                  fixture,
                  malformedRecoveryExpectedFixtureLabels[index],
                ),
              );
            }
            const ownerResults = await Promise.allSettled(
              acquisitionReceipts.map((receipt) => retainIndependentCooperativeReceipt(receipt)),
            );
            exactOwners = Object.freeze(
              ownerResults
                .filter((result) => result.status === "fulfilled")
                .map((result) => result.value),
            );
            if (ownerResults.some((result) => result.status === "rejected")) {
              throw new Error("independent fixture retention failed");
            }
          },
        });
      } catch (error) {
        observedError = error;
      }
    } catch (error) {
      orchestrationError = error;
    } finally {
      const sealedReceipts = Object.freeze([...acquisitionReceipts]);
      const sealedOwners = Object.freeze([...exactOwners]);
      stopPublications = freezeSettledResults(
        await Promise.allSettled(
          sealedReceipts.map(async (receipt) => {
            assert.equal(
              await pathExists(receipt.stopPath),
              true,
              "helper did not publish a cooperative private stop",
            );
            return Object.freeze({ kind: "published", stopPath: receipt.stopPath });
          }),
        ),
      );
      exactAbsenceResults = freezeSettledResults(
        await Promise.allSettled(
          sealedOwners.map(async (owner) => {
            await waitForExactProcessExit(owner.identity, 10_000);
            assert.equal(
              sameProcessIdentity(owner.identity, readProcessIdentity(owner.identity.pid, 1_000)),
              false,
            );
            assert.equal(await pathExists(owner.signalMarkerPath), false);
            return Object.freeze({
              identityAbsent: true,
              pid: owner.identity.pid,
              signalAbsent: true,
            });
          }),
        ),
      );
      const cleanupRoots = Object.freeze(
        [
          { label: "Red G malformed-case root", owned: caseRootOwned, path: caseRoot },
          {
            label: "Red G fixture private-stop root",
            owned: fixturePrivateStopOwned,
            path: fixturePrivateStopRoot,
          },
          {
            label: "Red G signal evidence root",
            owned: signalEvidenceOwned,
            path: signalEvidenceRoot,
          },
        ].map((root) => Object.freeze(root)),
      );
      rootCapabilityResults = freezeSettledResults(
        await Promise.allSettled(
          cleanupRoots.map(async (root) => {
            if (!root.path || !(await pathExists(root.path))) {
              return Object.freeze({ kind: "absent" });
            }
            assert.equal(root.owned?.path, await realpath(root.path));
            return Object.freeze({ kind: "owned", owned: root.owned });
          }),
        ),
      );
      preCleanupResidueResults = freezeSettledResults(
        await Promise.allSettled([
          assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots),
          (async () => assert.equal(caseRoot ? await pathExists(caseRoot) : false, false))(),
        ]),
      );
      exactReceiptOwnerMappings =
        helperCallAttempted &&
        sealedReceipts.length === 2 &&
        sealedOwners.length === 2 &&
        new Set(sealedReceipts.map((receipt) => receipt.childPid)).size === 2 &&
        new Set(sealedOwners.map((owner) => owner.identity.pid)).size === 2 &&
        sealedOwners.every((owner, index) => {
          const receipt = sealedReceipts[index];
          return (
            owner.child === receipt.child &&
            owner.childPid === receipt.childPid &&
            owner.closeOutcome === receipt.closeOutcome &&
            owner.handlerReadyPath === receipt.handlerReadyPath &&
            owner.label === receipt.label &&
            owner.signalMarkerPath === receipt.signalMarkerPath &&
            owner.stopPath === receipt.stopPath &&
            owner.identity.pid === receipt.childPid &&
            sameProcessIdentity(owner.identity, owner.sessionObservation.identity) &&
            isSemanticSessionLeader(owner.sessionObservation)
          );
        });
      exactStopResults =
        stopPublications.length === 2 &&
        stopPublications.every(
          (result, index) =>
            result.status === "fulfilled" &&
            result.value?.kind === "published" &&
            result.value.stopPath === sealedReceipts[index].stopPath,
        );
      exactIdentityAbsenceResults =
        exactAbsenceResults.length === 2 &&
        exactAbsenceResults.every(
          (result, index) =>
            result.status === "fulfilled" &&
            result.value?.identityAbsent === true &&
            result.value.pid === sealedOwners[index].identity.pid &&
            result.value.signalAbsent === true,
        );
      exactRootCapabilityResults =
        rootCapabilityResults.length === 3 &&
        rootCapabilityResults[0].status === "fulfilled" &&
        rootCapabilityResults[0].value?.kind === "absent" &&
        rootCapabilityResults[1].status === "fulfilled" &&
        rootCapabilityResults[1].value?.kind === "owned" &&
        rootCapabilityResults[2].status === "fulfilled" &&
        rootCapabilityResults[2].value?.kind === "owned";
      preCleanupResidueGreen =
        preCleanupResidueResults.length === 2 &&
        preCleanupResidueResults.every((result) => result.status === "fulfilled");
      controllerStateUnchanged =
        activeWrapperControllers.size === controllerBaseline.active &&
        completedWrapperControllers.length === controllerBaseline.completed &&
        openWrapperOwnershipDescriptors.size === controllerBaseline.descriptors &&
        recordedWrapperIdentities.length === controllerBaseline.identities;
      helperCloseAndJoinCompleted =
        observedError === boundaryMarker ||
        (observedError instanceof Error &&
          observedError.message.startsWith("retained semantic session-leader evidence is invalid"));
      const cleanupSafetyEligible =
        exactStopResults &&
        helperCloseAndJoinCompleted &&
        exactIdentityAbsenceResults &&
        exactRootCapabilityResults &&
        preCleanupResidueGreen &&
        controllerStateUnchanged;
      const ownedRoots = cleanupSafetyEligible
        ? Object.freeze([fixturePrivateStopOwned, signalEvidenceOwned])
        : Object.freeze([]);
      rootCleanupResults = freezeSettledResults(
        await Promise.allSettled(
          (ownedRoots ?? []).map(async (owned) => {
            if (!(await pathExists(owned.path))) return Object.freeze({ kind: "absent" });
            await cleanupExactOwnedDirectories([owned]);
            return Object.freeze({ kind: "cleaned" });
          }),
        ),
      );
      residueResults = freezeSettledResults(
        await Promise.allSettled([
          assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots),
          (async () =>
            assert.deepEqual((await readdir(wrapperTemporaryRoot)).sort(), beforeSuiteEntries))(),
          (async () => assert.equal(caseRoot ? await pathExists(caseRoot) : false, false))(),
          (async () =>
            assert.equal(
              fixturePrivateStopRoot ? await pathExists(fixturePrivateStopRoot) : false,
              false,
            ))(),
          (async () =>
            assert.equal(
              signalEvidenceRoot ? await pathExists(signalEvidenceRoot) : false,
              false,
            ))(),
        ]),
      );
    }

    const exactSemanticError =
      observedError instanceof Error &&
      observedError.message.startsWith("retained semantic session-leader evidence is invalid");
    const allSettledGreen = (results) =>
      results.length > 0 && results.every((result) => result.status === "fulfilled");
    const acceptance = Object.freeze({
      causalRejectionBeforeController:
        observerReachCount === 0 && observedError !== boundaryMarker && exactSemanticError,
      controllerStateUnchanged,
      helperCloseAndJoinCompleted,
      identityAbsenceResultsExact: exactIdentityAbsenceResults,
      mutationExactOnce: mutationCount === 1 && mutationWasExact,
      orchestrationClean: orchestrationError === undefined,
      postCleanupResidueGreen: allSettledGreen(residueResults),
      preCleanupResidueGreen,
      receiptOwnerCountsExact: acquisitionReceipts.length === 2 && exactOwners.length === 2,
      receiptOwnerMappingsExact: exactReceiptOwnerMappings,
      rootCapabilitiesExact: exactRootCapabilityResults,
      rootCleanupGreen: rootCleanupResults.length === 2 && allSettledGreen(rootCleanupResults),
      stopResultsExact: exactStopResults,
    });
    assert.deepEqual(
      acceptance,
      Object.freeze(Object.fromEntries(Object.keys(acceptance).map((key) => [key, true]))),
      "retained semantic session-leader evidence was not rejected before controller acquisition",
    );
  });

  it("Red G safely finalizes every fixture after pre-retention failure", {
    timeout: 150_000,
  }, async () => {
    const beforePostgresRoots = await postgresTemporaryDirectories();
    const beforeBrowserRoots = await browserTemporaryDirectories();
    const setupError = new Error("injected first-retention setup failure");
    let signalEvidenceRoot;
    let signalEvidenceOwned;
    let fixturePrivateStopRoot;
    let fixturePrivateStopOwned;
    const acquisitionReceipts = [];
    const acquisitionSlots = [];
    const expectedFixtureLabels = malformedRecoveryExpectedFixtureLabels;
    const independentOwnerAttempts = [];
    let exactOwners = Object.freeze([]);
    let rawFixtures = Object.freeze([]);
    let caseRoot;
    let caseRootOwned;
    let exactFirstOwner;
    let exactFirstOwnerInvocationCount = 0;
    let everyTargetInvocationWasExact = true;
    let observedError;
    let bodyFailure;
    let helperCallAttempted = false;
    let exactOwnerSet = false;
    let rawFixtureSet = false;
    let secondSlotUnretainedAtFailure = false;
    let uutFinalizedAcquiredSlots = false;
    let causalSnapshot = Object.freeze({
      avoidedReplay: false,
      gatedRootRemoval: false,
      joinedBothExactOwners: false,
      publishedEveryPrivateStop: false,
      preservedSetupError: false,
      provedUnretainedFinalization: false,
      publishedImmediateReceipts: false,
    });
    const observationFailures = [];
    const recoveryFailures = [];
    try {
      signalEvidenceRoot = await mkdtemp(join(wrapperTemporaryRoot, "red-g-signal-evidence-"));
      signalEvidenceOwned = Object.freeze(
        captureOwnedDirectory(await realpath(signalEvidenceRoot), "Red G signal evidence root"),
      );
      signalEvidenceRoot = signalEvidenceOwned.path;
      fixturePrivateStopRoot = await mkdtemp(join(wrapperTemporaryRoot, "red-g-private-stops-"));
      fixturePrivateStopOwned = Object.freeze(
        captureOwnedDirectory(
          await realpath(fixturePrivateStopRoot),
          "Red G fixture private-stop root",
        ),
      );
      fixturePrivateStopRoot = fixturePrivateStopOwned.path;

      try {
        helperCallAttempted = true;
        await runMalformedCancellationIsolationCase({
          async afterFixtureIdentityCapture(owner) {
            if (owner.stopPath !== exactFirstOwner?.stopPath) return;
            exactFirstOwnerInvocationCount += 1;
            everyTargetInvocationWasExact &&=
              owner.child === exactFirstOwner.child &&
              owner.child?.pid === exactFirstOwner.childPid &&
              (owner.closeState?.outcome ?? owner.close) === exactFirstOwner.closeOutcome &&
              owner.handlerReadyPath === exactFirstOwner.handlerReadyPath &&
              owner.signalMarkerPath === exactFirstOwner.signalMarkerPath &&
              sameProcessIdentity(owner.identity, exactFirstOwner.identity);
            if (exactFirstOwnerInvocationCount === 1) throw setupError;
          },
          fixturePrivateStopRoot,
          fixtureSignalEvidenceRoot: signalEvidenceRoot,
          onCaseRootAcquired(context) {
            caseRootOwned = Object.freeze(context.caseRootOwned);
            caseRoot = caseRootOwned.path;
          },
          onFixtureAcquired(receipt, slot) {
            const independentReceipt = independentCooperativeReceipt(
              receipt,
              expectedFixtureLabels[acquisitionReceipts.length],
            );
            acquisitionReceipts.push(independentReceipt);
            acquisitionSlots.push(slot);
            rawFixtures = Object.freeze([...acquisitionSlots]);
            const owner = retainIndependentCooperativeReceiptImmediately(independentReceipt);
            exactOwners = Object.freeze([...exactOwners, owner]);
            exactFirstOwner ??= owner;
            const ownerAttempt = Promise.resolve(owner);
            independentOwnerAttempts.push(ownerAttempt);
            if (acquisitionReceipts.length === 2) {
              secondSlotUnretainedAtFailure = acquisitionSlots.every(
                (candidate) =>
                  candidate.acquisition === "acquired" &&
                  candidate.identity === undefined &&
                  candidate.identityRetained === false &&
                  candidate.joined === false &&
                  candidate.stopPublished === false,
              );
              throw setupError;
            }
          },
          async onFixturesCreated(context) {
            rawFixtures = Object.freeze([...context.fixtures]);
            caseRootOwned = Object.freeze(
              captureOwnedDirectory(await realpath(context.caseRoot), "Red G malformed-case root"),
            );
            caseRoot = caseRootOwned.path;
            for (const [index, fixture] of rawFixtures.entries()) {
              const receipt = independentCooperativeReceipt(fixture, expectedFixtureLabels[index]);
              acquisitionReceipts.push(receipt);
              const ownerAttempt = retainIndependentCooperativeReceipt(receipt);
              void ownerAttempt.catch(() => {});
              independentOwnerAttempts.push(ownerAttempt);
            }
            const retentionResults = await Promise.allSettled(independentOwnerAttempts);
            exactOwners = Object.freeze(
              retentionResults
                .filter((result) => result.status === "fulfilled")
                .map((result) => result.value),
            );
            exactFirstOwner = exactOwners[0];
            const retentionFailures = retentionResults
              .filter((result) => result.status === "rejected")
              .map((result) => result.reason);
            if (retentionFailures.length > 0) {
              throw new AggregateError(retentionFailures, "Red G fixture retention failed");
            }
          },
        });
      } catch (error) {
        observedError = error;
      }

      const independentOwnerResults = await Promise.allSettled(independentOwnerAttempts);
      observationFailures.push(
        ...independentOwnerResults
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      );
      if (exactOwners.length === 0) {
        exactOwners = Object.freeze(
          independentOwnerResults
            .filter((result) => result.status === "fulfilled")
            .map((result) => result.value),
        );
        exactFirstOwner = exactOwners[0];
      }

      rawFixtureSet =
        rawFixtures.length === 2 &&
        new Set(rawFixtures.map((fixture) => fixture.stopPath)).size === rawFixtures.length &&
        new Set(rawFixtures.map((fixture) => fixture.child)).size === rawFixtures.length &&
        new Set(rawFixtures.map((fixture) => fixture.child?.pid)).size === rawFixtures.length &&
        new Set(rawFixtures.map((fixture) => fixture.closeState ?? fixture.close)).size ===
          rawFixtures.length &&
        rawFixtures.every(
          (fixture) =>
            fixture.child &&
            typeof (fixture.closeState?.outcome ?? fixture.close)?.then === "function" &&
            typeof fixture.handlerReadyPath === "string" &&
            typeof fixture.signalMarkerPath === "string" &&
            typeof fixture.stopPath === "string",
        );
      exactOwnerSet =
        rawFixtureSet &&
        exactOwners.length === rawFixtures.length &&
        exactOwners.every((owner, index) => {
          const fixture = rawFixtures[index];
          return (
            owner.child === fixture.child &&
            owner.childPid === fixture.child.pid &&
            owner.closeOutcome === (fixture.closeState?.outcome ?? fixture.close) &&
            owner.handlerReadyPath === fixture.handlerReadyPath &&
            owner.signalMarkerPath === fixture.signalMarkerPath &&
            owner.stopPath === fixture.stopPath &&
            owner.identity.pid === fixture.child.pid &&
            owner.identity.ppid === malformedRecoveryParentPid &&
            owner.identity.pid === owner.identity.pgid
          );
        });
      const uutStopPublicationResults = await Promise.allSettled(
        rawFixtures.map((fixture) => pathExists(fixture.stopPath)),
      );
      observationFailures.push(
        ...uutStopPublicationResults
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      );
      const uutPublishedEveryPrivateStop =
        rawFixtures.length === 2 &&
        uutStopPublicationResults.length === rawFixtures.length &&
        uutStopPublicationResults.every(
          (result) => result.status === "fulfilled" && result.value === true,
        );
      const liveBeforeRecovery = exactOwners.map((owner) => {
        try {
          return sameProcessIdentity(
            owner.identity,
            readProcessIdentity(owner.identity.pid, 1_000),
          );
        } catch (error) {
          observationFailures.push(error);
          return true;
        }
      });
      let rootPresentBeforeRecovery = true;
      try {
        rootPresentBeforeRecovery = caseRoot ? await pathExists(caseRoot) : false;
      } catch (error) {
        observationFailures.push(error);
      }
      const errorTreeIncludes = (error, expected) =>
        error === expected ||
        (error instanceof AggregateError &&
          error.errors.some((nested) => errorTreeIncludes(nested, expected)));
      const setupErrorPreserved = errorTreeIncludes(observedError, setupError);
      const bothExactOwnersJoined =
        exactOwnerSet &&
        liveBeforeRecovery.length === rawFixtures.length &&
        liveBeforeRecovery.every((live) => !live);
      uutFinalizedAcquiredSlots =
        acquisitionSlots.length === 2 &&
        acquisitionSlots.every(
          (slot) =>
            slot.acquisition === "acquired" &&
            slot.identityRetained === true &&
            slot.stopPublished === true &&
            slot.rawClosed === true &&
            slot.joined === true,
        );
      causalSnapshot = Object.freeze({
        avoidedReplay: exactFirstOwnerInvocationCount === 0 && everyTargetInvocationWasExact,
        gatedRootRemoval:
          Boolean(caseRootOwned) &&
          (bothExactOwnersJoined ? !rootPresentBeforeRecovery : rootPresentBeforeRecovery),
        joinedBothExactOwners: bothExactOwnersJoined,
        publishedEveryPrivateStop: uutPublishedEveryPrivateStop,
        preservedSetupError: setupErrorPreserved,
        provedUnretainedFinalization: secondSlotUnretainedAtFailure && uutFinalizedAcquiredSlots,
        publishedImmediateReceipts:
          acquisitionReceipts.length === 2 && acquisitionSlots.length === 2,
      });
    } catch (error) {
      bodyFailure = error;
    } finally {
      const sealedAcquisitionReceipts = Object.freeze([...acquisitionReceipts]);
      const sealedExactOwners = Object.freeze([...exactOwners]);
      const stopPublications = freezeSettledResults(
        await Promise.allSettled(
          sealedAcquisitionReceipts.map(async (receipt) => {
            await writePrivateStop(receipt.stopPath);
            return Object.freeze({ kind: "published", stopPath: receipt.stopPath });
          }),
        ),
      );
      const closeJoins = freezeSettledResults(
        await Promise.allSettled(
          sealedAcquisitionReceipts.map(async (receipt) => {
            const outcome = await settleIndependentCooperativeReceipt(receipt);
            assert.deepEqual(outcome, { code: 0, signal: null });
            assert.equal(
              await pathExists(receipt.signalMarkerPath),
              false,
              "cooperative fixture was signaled",
            );
            return Object.freeze({
              code: outcome.code,
              pid: receipt.childPid,
              signal: outcome.signal,
              signalAbsent: true,
            });
          }),
        ),
      );
      const exactAbsenceResults = freezeSettledResults(
        await Promise.allSettled(
          sealedExactOwners.map(async (owner) => {
            await waitForExactProcessExit(owner.identity, 10_000);
            assert.equal(
              sameProcessIdentity(owner.identity, readProcessIdentity(owner.identity.pid, 1_000)),
              false,
              "cooperative fixture retained its exact identity",
            );
            assert.equal(
              await pathExists(owner.signalMarkerPath),
              false,
              "cooperative fixture was signaled",
            );
            return Object.freeze({
              identityAbsent: true,
              pid: owner.identity.pid,
              signalAbsent: true,
            });
          }),
        ),
      );
      recoveryFailures.push(
        ...stopPublications
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
        ...closeJoins
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
        ...exactAbsenceResults
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      );

      const cleanupRoots = Object.freeze(
        [
          {
            label: "Red G malformed-case root",
            owned: caseRootOwned,
            path: caseRoot,
          },
          {
            label: "Red G fixture private-stop root",
            owned: fixturePrivateStopOwned,
            path: fixturePrivateStopRoot,
          },
          {
            label: "Red G signal evidence root",
            owned: signalEvidenceOwned,
            path: signalEvidenceRoot,
          },
        ].map((root) => Object.freeze(root)),
      );
      const rootCapabilityResults = Object.freeze(
        (
          await Promise.allSettled(
            cleanupRoots.map(async (root) => {
              if (!root.path || !(await pathExists(root.path))) {
                return Object.freeze({ kind: "absent" });
              }
              if (root.owned) {
                assert.equal(
                  root.owned.path,
                  root.path,
                  `${root.label} capability did not bind the requested root`,
                );
                return Object.freeze({ kind: "owned", owned: root.owned });
              }
              assert.equal(
                helperCallAttempted,
                false,
                `${root.label} capability was lost after helper execution began`,
              );
              return Object.freeze({
                kind: "owned",
                owned: Object.freeze(
                  captureOwnedDirectory(await realpath(root.path), `${root.label} recovery`),
                ),
              });
            }),
          )
        ).map((result) => Object.freeze(result)),
      );
      const ownedRoots = malformedRecoveryRootCleanupPlan({
        acquisitionReceipts: sealedAcquisitionReceipts,
        cleanupRoots,
        closeJoins,
        exactAbsenceResults,
        exactOwners: sealedExactOwners,
        helperCallAttempted,
        rootCapabilityResults,
        stopPublications,
      });
      const rootCleanupAuthorized = ownedRoots !== undefined;
      recoveryFailures.push(
        ...rootCapabilityResults
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      );
      const rootCleanupResults = await Promise.allSettled(
        rootCleanupAuthorized
          ? ownedRoots.map(async (owned) => {
              if (!(await pathExists(owned.path))) return { kind: "absent" };
              await cleanupExactOwnedDirectories([owned]);
              return { kind: "cleaned" };
            })
          : [],
      );
      if (!rootCleanupAuthorized && helperCallAttempted) {
        recoveryFailures.push(
          new Error("Red G destructive cleanup was withheld until exact finalization completed"),
        );
      }
      recoveryFailures.push(
        ...rootCleanupResults
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      );

      const residueResults = await Promise.allSettled([
        assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots),
        (async () =>
          assert.equal(
            signalEvidenceRoot ? await pathExists(signalEvidenceRoot) : false,
            false,
            "signal evidence root remained after exact cleanup",
          ))(),
        (async () =>
          assert.equal(
            fixturePrivateStopRoot ? await pathExists(fixturePrivateStopRoot) : false,
            false,
            "fixture private-stop root remained after exact cleanup",
          ))(),
        (async () =>
          assert.equal(
            caseRoot ? await pathExists(caseRoot) : false,
            false,
            "malformed-case root remained after exact cleanup",
          ))(),
      ]);
      recoveryFailures.push(
        ...residueResults
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      );
    }
    const postBodyFailures = [...observationFailures, ...recoveryFailures];
    if (postBodyFailures.length > 0) {
      throw new AggregateError(
        bodyFailure ? [bodyFailure, ...postBodyFailures] : postBodyFailures,
        "Red G safety cleanup failed",
      );
    }
    if (bodyFailure) throw bodyFailure;
    assert.equal(
      causalSnapshot.preservedSetupError &&
        causalSnapshot.avoidedReplay &&
        causalSnapshot.joinedBothExactOwners &&
        causalSnapshot.publishedEveryPrivateStop &&
        causalSnapshot.gatedRootRemoval &&
        causalSnapshot.provedUnretainedFinalization &&
        causalSnapshot.publishedImmediateReceipts,
      true,
      "pre-retention fixture finalization was not failure-safe",
    );
  });

  it("Red G accepts both valid bounded-finish envelope arms", {
    timeout: 30_000,
  }, () => {
    const boundedError = createWrapperCloseDeadlineError();
    const contaminatedBoundedError = Object.assign(
      new Error("wrapper close deadline exceeded", { cause: new Error("raw diagnostics") }),
      {
        code: "ERR_WRAPPER_CLOSE_DEADLINE",
        stderr: "raw diagnostics",
      },
    );
    const contaminatedStackError = Object.assign(new Error("wrapper close deadline exceeded"), {
      code: "ERR_WRAPPER_CLOSE_DEADLINE",
    });
    contaminatedStackError.stack =
      "Error: wrapper close deadline exceeded\n    at raw-diagnostic-location";
    let getterExecutions = 0;
    let proxyTrapExecutions = 0;
    const getterKindEnvelope = Object.defineProperty({ value: { code: 1, signal: null } }, "kind", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterExecutions += 1;
        return "fulfilled";
      },
    });
    const getterErrorEnvelope = Object.defineProperty({ kind: "rejected" }, "error", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterExecutions += 1;
        return boundedError;
      },
    });
    const getterCodeError = Object.assign(new Error("wrapper close deadline exceeded"), {
      code: "ERR_WRAPPER_CLOSE_DEADLINE",
    });
    getterCodeError.stack = "Error: wrapper close deadline exceeded";
    Object.defineProperty(getterCodeError, "code", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterExecutions += 1;
        return "ERR_WRAPPER_CLOSE_DEADLINE";
      },
    });
    const getterMessageError = Object.assign(new Error("wrapper close deadline exceeded"), {
      code: "ERR_WRAPPER_CLOSE_DEADLINE",
    });
    getterMessageError.stack = "Error: wrapper close deadline exceeded";
    Object.defineProperty(getterMessageError, "message", {
      configurable: true,
      enumerable: false,
      get: () => {
        getterExecutions += 1;
        return "wrapper close deadline exceeded";
      },
    });
    const getterStackError = Object.assign(new Error("wrapper close deadline exceeded"), {
      code: "ERR_WRAPPER_CLOSE_DEADLINE",
    });
    Object.defineProperty(getterStackError, "stack", {
      configurable: true,
      enumerable: false,
      get: () => {
        getterExecutions += 1;
        return "Error: wrapper close deadline exceeded";
      },
    });
    const getterCauseError = Object.assign(new Error("wrapper close deadline exceeded"), {
      code: "ERR_WRAPPER_CLOSE_DEADLINE",
    });
    getterCauseError.stack = "Error: wrapper close deadline exceeded";
    Object.defineProperty(getterCauseError, "cause", {
      configurable: true,
      enumerable: false,
      get: () => {
        getterExecutions += 1;
        return new Error("raw diagnostics");
      },
    });
    class SyntheticDeadlineError extends Error {}
    const subclassError = Object.assign(
      new SyntheticDeadlineError("wrapper close deadline exceeded"),
      { code: "ERR_WRAPPER_CLOSE_DEADLINE" },
    );
    subclassError.stack = "Error: wrapper close deadline exceeded";
    const proxyHandler = {
      get(target, key, receiver) {
        proxyTrapExecutions += 1;
        if (key === "value") return { code: 0, signal: "SIGKILL" };
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyTrapExecutions += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf() {
        proxyTrapExecutions += 1;
        throw new Error("proxy getPrototypeOf trap executed");
      },
      ownKeys(target) {
        proxyTrapExecutions += 1;
        return Reflect.ownKeys(target);
      },
    };
    const forwardingProxyEnvelope = new Proxy(
      { kind: "fulfilled", value: { code: 1, signal: null } },
      proxyHandler,
    );
    const forwardingProxyValue = new Proxy({ code: 1, signal: null }, proxyHandler);
    const forwardingProxyError = new Proxy(boundedError, proxyHandler);
    assert.equal(
      isValidBoundedFinishEnvelope({
        kind: "fulfilled",
        value: { code: 1, signal: null },
      }),
      true,
    );
    assert.equal(isValidBoundedFinishEnvelope({ error: boundedError, kind: "rejected" }), true);
    for (const invalid of [
      { kind: "deadline" },
      { kind: "fulfilled", value: { code: 0, signal: null } },
      { kind: "fulfilled", value: { code: 1, signal: "SIGKILL" } },
      {
        kind: "fulfilled",
        value: { code: 1, signal: null, stderr: "unexpected diagnostics" },
      },
      {
        kind: "fulfilled",
        value: Object.assign(Object.create(null), { code: 1, signal: null }),
      },
      {
        kind: "fulfilled",
        value: Object.defineProperty({ signal: null }, "code", { enumerable: true, get: () => 1 }),
      },
      {
        kind: "fulfilled",
        value: Object.assign({ code: 1, signal: null }, { [Symbol("raw")]: "diagnostics" }),
      },
      {
        kind: "fulfilled",
        raw: "diagnostics",
        value: { code: 1, signal: null },
      },
      Object.assign(
        { kind: "fulfilled", value: { code: 1, signal: null } },
        { [Symbol("raw")]: "diagnostics" },
      ),
      { error: new Error("raw diagnostics"), kind: "rejected" },
      { error: contaminatedBoundedError, kind: "rejected" },
      { error: contaminatedStackError, kind: "rejected" },
      getterKindEnvelope,
      getterErrorEnvelope,
      { error: getterCodeError, kind: "rejected" },
      { error: getterMessageError, kind: "rejected" },
      { error: getterStackError, kind: "rejected" },
      { error: getterCauseError, kind: "rejected" },
      { error: subclassError, kind: "rejected" },
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("proxy trap executed");
          },
        },
      ),
      forwardingProxyEnvelope,
      { kind: "fulfilled", value: forwardingProxyValue },
      { error: forwardingProxyError, kind: "rejected" },
      {
        error: {
          code: "ERR_WRAPPER_CLOSE_DEADLINE",
          message: "wrapper close deadline exceeded",
        },
        kind: "rejected",
      },
    ]) {
      assert.equal(isValidBoundedFinishEnvelope(invalid), false);
    }
    assert.equal(getterExecutions, 0, "bounded-envelope validation executed an accessor");
    assert.equal(proxyTrapExecutions, 0, "bounded-envelope validation executed a proxy trap");
  });

  it("Red G self-defends the exact signal-authority oracle", {
    timeout: 150_000,
  }, () => {
    const canonical = canonicalSignalContractSource();
    assert.deepEqual(
      collectBlindSignalDiagnostics(canonical, "synthetic-signal", "signal-only"),
      [],
      "signal oracle rejected its exact canonical contract",
    );
    const shadowedCapabilityFile = ts.createSourceFile(
      "shadowed-capability-control",
      "function safe(globalThis,Object,process,Set,eval,Function){const {assign}=Object;const evaluator=globalThis.eval;const binding=process.binding;const prototype=Set.prototype;let assigned;({location:assigned}=globalThis);const holder={};holder.e=()=>{};let local;local||=()=>{};function nested(value=globalThis.eval){var globalThis={eval(){}};return value}void assign;void evaluator;void binding;void prototype;void assigned;void holder;void local;void nested;void eval;void Function}",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    assert.deepEqual(
      capabilityAliasEscapeNodes(
        shadowedCapabilityFile,
        shadowedCapabilityFile,
        signalCapabilityAliasPathValues(),
        evaluatorCapabilityPathValues(),
      ),
      [],
      "capability-alias oracle treated lexical shadows as global authority",
    );
    const benignCapabilityFile = ts.createSourceFile(
      "benign-capability-control",
      "const {location}=globalThis;let assigned;({location:assigned}=globalThis);const holder={};holder.e=()=>{};let local;local??=()=>{};const localCallable=()=>{};const bound=globalThis.eval.call.bind(localCallable);function body(){var globalThis={location:1};return globalThis.location}void location;void assigned;void holder;void local;void bound;void body",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    assert.deepEqual(
      capabilityAliasEscapeNodes(
        benignCapabilityFile,
        benignCapabilityFile,
        signalCapabilityAliasPathValues(),
        evaluatorCapabilityPathValues(),
      ),
      [],
      "capability-alias oracle rejected benign members and inert assignments",
    );
    const preciseShadowControlsFile = ts.createSourceFile(
      "precise-shadow-controls",
      `function computed(globalThis,Object){const {[JSON.parse('"eval"')]:e}=globalThis;const {[JSON.parse('"assign"')]:a}=Object;e("synthetic");a({},{});}function parameter(globalThis,evaluator=globalThis.eval){evaluator("synthetic");}function body(){var globalThis={eval(){}};const evaluator=globalThis.eval;evaluator("synthetic");}`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    assert.deepEqual(
      capabilityAliasEscapeNodes(
        preciseShadowControlsFile,
        preciseShadowControlsFile,
        signalCapabilityAliasPathValues(),
        evaluatorCapabilityPathValues(),
      ),
      [],
      "capability-alias oracle rejected precise lexical shadow controls",
    );
    const whollyAllowedFile = ts.createSourceFile(
      "wholly-allowed-capability-control",
      "{const evaluator=globalThis.eval;evaluator('synthetic');}",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const whollyAllowedBlock = whollyAllowedFile.statements.find(ts.isBlock);
    assert.ok(whollyAllowedBlock, "wholly allowed capability control block was missing");
    assert.deepEqual(
      capabilityAliasEscapeNodes(
        whollyAllowedFile,
        whollyAllowedFile,
        evaluatorCapabilityPathValues(),
        evaluatorCapabilityPathValues(),
        [whollyAllowedBlock],
      ),
      [],
      "capability-alias oracle rejected acquisition and use inside one allowed subtree",
    );
    const allowedAcquisitionFile = ts.createSourceFile(
      "allowed-capability-control",
      "let evaluator;{evaluator=globalThis.eval;}evaluator('synthetic')",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const allowedAcquisitionBlock = allowedAcquisitionFile.statements.find(ts.isBlock);
    assert.ok(allowedAcquisitionBlock, "allowed capability control block was missing");
    assert.notDeepEqual(
      capabilityAliasEscapeNodes(
        allowedAcquisitionFile,
        allowedAcquisitionFile,
        evaluatorCapabilityPathValues(),
        evaluatorCapabilityPathValues(),
        [allowedAcquisitionBlock],
      ),
      [],
      "allowed acquisition suppressed a later capability escape",
    );
    const canonicalFacade = canonicalExecutableFacadeProvenanceSource();
    const integratedCanonicalFacadeFile = ts.createSourceFile(
      "integrated-canonical-facade",
      canonicalFacade,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    assert.deepEqual(
      integratedCanonicalFacadeFile.parseDiagnostics,
      [],
      "integrated executable-facade source was not syntactically valid",
    );
    assert.equal(
      abruptSignalAuthorization(integratedCanonicalFacadeFile).exact,
      true,
      "integrated executable-facade source failed abrupt signal authorization",
    );
    assert.deepEqual(
      collectBlindSignalDiagnostics(canonicalFacade, "synthetic-facade", "full"),
      [],
      "signal oracle rejected its exact executable-facade contract",
    );
    const canonicalFacadeWhitespaceVariant = canonicalFacade
      .split("\n")
      .map((line, index) => (index % 2 === 0 ? `  ${line}` : `\t${line}`))
      .join("\n");
    assert.deepEqual(
      collectBlindSignalDiagnostics(canonicalFacadeWhitespaceVariant, "synthetic-facade", "full"),
      [],
      "signal oracle rejected a whitespace-only executable-facade variant",
    );
    assert.equal(
      collectBlindSignalDiagnostics(canonicalFacade, "synthetic-facade", undefined).some((entry) =>
        entry.endsWith(":executable-facade-provenance"),
      ),
      true,
      "signal oracle silently downgraded an omitted facade mode",
    );
    const replaceFacadeTextExactlyOnce = (source, needle, replacement) => {
      assert.equal(
        source.split(needle).length - 1,
        1,
        "executable-facade mutation needle was not exact-once",
      );
      const mutated = source.replace(needle, replacement);
      assert.notEqual(mutated, source, "executable-facade mutation was a no-op");
      return mutated;
    };
    const mutateFacadeOwner = (name, mutate) => {
      const start = canonicalFacade.indexOf(`async function ${name}`);
      assert.notEqual(start, -1, `canonical facade owner missing: ${name}`);
      const boundaries = [
        canonicalFacade.indexOf("\nasync function ", start + 1),
        canonicalFacade.indexOf('\ndescribe("HR browser harness contracts"', start + 1),
      ].filter((index) => index > start);
      const end = Math.min(...boundaries);
      assert.equal(Number.isFinite(end), true, `canonical facade owner boundary missing: ${name}`);
      const owner = canonicalFacade.slice(start, end);
      const mutatedOwner = mutate(owner);
      assert.notEqual(mutatedOwner, owner, `canonical facade owner mutation was a no-op: ${name}`);
      return `${canonicalFacade.slice(0, start)}${mutatedOwner}${canonicalFacade.slice(end)}`;
    };
    const malformedFacadeCall =
      'controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000})';
    const mutateMalformedFacadeCall = (replacement) =>
      mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
        replaceFacadeTextExactlyOnce(owner, malformedFacadeCall, replacement),
      );
    const mutateMalformedFacadeProgram = (program) =>
      mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) => {
        const declarations = [...owner.matchAll(/const source=\[[\s\S]*?\]\.join\(";"\);/g)];
        assert.equal(declarations.length, 1, "malformed facade carrier was not exact-once");
        return replaceFacadeTextExactlyOnce(
          owner,
          declarations[0][0],
          `const source=${JSON.stringify(program)};`,
        );
      });
    const forwardedLoopHeader =
      'for(const signal of ["SIGINT","SIGTERM"]){it(`forwards ${signal}, drains the complete child group, and preserves signal exit semantics`';
    const preRegistrationLoopHeader =
      'for(const signal of ["SIGINT","SIGTERM"]){it(`cancels a real BrowserServer launch before registration on ${signal}`';
    const forwardedRegistration = `${forwardedLoopHeader},{timeout:45_000},async()=>{`;
    const realBrowserConsumerHeader =
      'for(const [label,signal,secondSignal] of [["single SIGINT","SIGINT",false,false],["single SIGTERM","SIGTERM",false,false],["second-signal escalation","SIGTERM",true,false]]){';
    const abruptRegistration =
      'it("owns and drains real Chromium after exact parent-delivered post-ACK harness SIGKILL",{timeout:90_000},runAbruptHarnessCrashCase);';
    const affectedFacadeControlPathMutations = [
      {
        call: 'wrapper=spawnSupervisedPostgresWrapper(process.execPath,["-e",source])',
        owner: "runRealBrowserSignalCase",
      },
      {
        call: 'controller=await spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:70_000})',
        owner: "runAbruptHarnessCrashCase",
      },
    ].flatMap(({ call, owner }) =>
      [
        `return;${call}`,
        `throw new Error("blocked");${call}`,
        `while(true){}${call}`,
        `if(false){${call}}`,
      ].map((replacement) => ({
        category: "executable-facade-provenance",
        source: mutateFacadeOwner(owner, (ownerSource) =>
          replaceFacadeTextExactlyOnce(ownerSource, call, replacement),
        ),
      })),
    );
    const facadeMutations = [
      ...affectedFacadeControlPathMutations,
      {
        category: "executable-facade-provenance",
        source: `${canonicalFacade}\nspawnPostgresWrapper(process.execPath,["-e","process.exit(0)"]);`,
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(`${malformedFacadeCall};${malformedFacadeCall}`),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          malformedFacadeCall.replace("operationTimeoutMs:35_000", "operationTimeoutMs:34_999"),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          'const acquire=spawnOwnedWrapperController;controller=acquire(process.execPath,["-e",source],{},{operationTimeoutMs:35_000})',
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeProgram(
          'return Reflect["g"+"et"](process,"ki"+"ll")(424242,"SIGTERM")',
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeProgram("void 0;process.exit(0)"),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(`if(false){${malformedFacadeCall}}`),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(`return;${malformedFacadeCall}`),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(`throw new Error("blocked");${malformedFacadeCall}`),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          "async function runRealBrowserSignalCase",
          "async function* runRealBrowserSignalCase",
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          forwardedRegistration,
          `${forwardedLoopHeader},{timeout:45_000,skip:true},async()=>{`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          forwardedRegistration,
          `${forwardedLoopHeader},{timeout:45_000},async function*(){`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            'catch(error){controllerAcquisition="no-subject";throw error}',
            'finally{controllerAcquisition="no-subject"}',
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            "claimed=await retainCooperativeFixture(fixtureSlots[0])",
            'claimed=await retainCooperativeFixture(fixtureSlots[0]);Object["assign"](claimed["identity"],{pid:1})',
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            "claimed=await retainCooperativeFixture(fixtureSlots[0])",
            "if(false){claimed=await retainCooperativeFixture(fixtureSlots[0])}",
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            "claimed=await retainCooperativeFixture(fixtureSlots[0])",
            "try{claimed=await retainCooperativeFixture(fixtureSlots[0])}finally{}",
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runRealBrowserSignalCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            "  const signalBehavior = !signal",
            '  signal="SIGTERM";\n  const signalBehavior = !signal',
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMaliciousRegistrationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            `const source=${canonicalMaliciousVariantSourceInitializer()};`,
            `variant="malformed";const source=${canonicalMaliciousVariantSourceInitializer()};`,
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(`const never=process.exit(0);${malformedFacadeCall}`),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `(()=>{throw new Error("blocked")})();${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `(()=>{throw new Error("blocked")}).call(undefined);${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `Reflect.apply((()=>{throw new Error("blocked")}),undefined,[]);${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `Reflect.construct((function(){throw new Error("blocked")}),[]);${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `(()=>{throw new Error("blocked")}).bind(null)();${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `(0,()=>{throw new Error("blocked")})();${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          '(()=>{throw new Error("blocked")})`tag`;' + malformedFacadeCall,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `new (function(){throw new Error("blocked")})();${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(`await new Promise(()=>{});${malformedFacadeCall}`),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `await new Promise((_resolve)=>{});${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `await new Promise((_resolve)=>{void 0});${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(
          `await new Promise((resolve)=>{void resolve});${malformedFacadeCall}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateMalformedFacadeCall(`{while(true){}}${malformedFacadeCall}`),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            "claimed=await retainCooperativeFixture(fixtureSlots[0])",
            "claimed=await retainCooperativeFixture(fixtureSlots[0]);Object.assign(claimed.identity,{pid:1})",
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            "claimed=await retainCooperativeFixture(fixtureSlots[0])",
            "claimed=await retainCooperativeFixture(fixtureSlots[0]);const identityAlias=claimed.identity;identityAlias.pid=1",
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            "claimed=await retainCooperativeFixture(fixtureSlots[0])",
            "claimed=await retainCooperativeFixture(fixtureSlots[0]);delete claimed.identity.pid",
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          'it("removes supervised control and profile roots when setup fails before PostgreSQL"',
          'return;it("removes supervised control and profile roots when setup fails before PostgreSQL"',
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          'it("removes supervised control and profile roots when setup fails before PostgreSQL"',
          'while(true){};it("removes supervised control and profile roots when setup fails before PostgreSQL"',
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          forwardedLoopHeader,
          `return;${forwardedLoopHeader}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          forwardedLoopHeader,
          `while(true){};${forwardedLoopHeader}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          preRegistrationLoopHeader,
          `while(true){};${preRegistrationLoopHeader}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          realBrowserConsumerHeader,
          `return;${realBrowserConsumerHeader}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          realBrowserConsumerHeader,
          `while(true){};${realBrowserConsumerHeader}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(canonicalFacade, abruptRegistration, ""),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          abruptRegistration,
          `while(true){};${abruptRegistration}`,
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          abruptRegistration,
          abruptRegistration.replace("{timeout:90_000}", "{timeout:90_000,skip:true}"),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: mutateFacadeOwner("runMalformedCancellationIsolationCase", (owner) =>
          replaceFacadeTextExactlyOnce(
            owner,
            "claimed=await retainCooperativeFixture(fixtureSlots[0])",
            "claimed=await retainCooperativeFixture(fixtureSlots[1])",
          ),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          'spawnPostgresWrapper(process.execPath,["-e","process.exit(0)"])',
          'spawnPostgresWrapper(process.execPath,["-e","process.exit(9)"])',
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          forwardedLoopHeader,
          forwardedLoopHeader.replace("for(const signal", "for(var signal"),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          preRegistrationLoopHeader,
          preRegistrationLoopHeader.replace("for(const signal", "for(var signal"),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          realBrowserConsumerHeader,
          realBrowserConsumerHeader.replace("for(const [", "for(var ["),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          forwardedLoopHeader,
          forwardedLoopHeader.replace('["SIGINT","SIGTERM"]', '["SIGTERM","SIGINT"]'),
        ),
      },
      {
        category: "executable-facade-provenance",
        source: replaceFacadeTextExactlyOnce(
          canonicalFacade,
          preRegistrationLoopHeader,
          preRegistrationLoopHeader.replace('["SIGINT","SIGTERM"]', '["SIGINT","SIGKILL"]'),
        ),
      },
      {
        category: "executable-facade-multiset",
        source: canonicalSignalContractSource(),
      },
    ];
    for (const mutation of facadeMutations) {
      assert.notEqual(mutation.source, canonicalFacade, "executable-facade mutation was a no-op");
      const findings = collectBlindSignalDiagnostics(mutation.source, "synthetic-facade", "full");
      assert.equal(
        findings.some((entry) => entry.endsWith(`:${mutation.category}`)),
        true,
        "signal oracle accepted executable-facade authority drift",
      );
      assert.equal(
        findings.every((entry) => /^synthetic-facade:[0-9]+:[a-z0-9-]+$/.test(entry)),
        true,
        "executable-facade diagnostics exposed source content",
      );
    }
    const abruptRelationCarrierMutationKeys = Object.freeze([
      "wrapper",
      "harness",
      "browser",
      "chromium",
      "harness-parent",
      "harness-leader",
      "browser-parent",
      "browser-leader",
      "session",
      "uid",
      "chromium-parent",
      "chromium-group",
      "chromium-session",
      "chromium-uid",
      "chromium-executable",
      "ack",
      "harness-live",
      "browser-live",
      "fd5",
      "fd9",
      "anchor-fd3",
      "anchor-fd4",
      "chromium-fd3",
      "chromium-fd4",
      "chromium-fd9",
      "return",
    ]);
    assert.deepEqual(
      sealedAbruptRelationCarrierManifest().map(({ key }) => key),
      abruptRelationCarrierMutationKeys,
      "abrupt relation carrier mutation coverage drifted from the sealed manifest",
    );
    const mutationContracts = [
      ["parse ambiguity", "parse-error"],
      ["computed access", "blind-signal-call"],
      ["internal kill access", "blind-signal-call"],
      ["opaque computed access", "blind-signal-call"],
      ["optional access", "blind-signal-call"],
      ["aliased access", "blind-signal-call"],
      ["reflected access", "kill-reference-escape"],
      ["aliased reflected access", "kill-reference-escape"],
      ["destructured reflected access", "kill-reference-escape"],
      ["process binding shadow", "process-binding-shadow"],
      ["counterfeit process identity helper", "signal-helper-provenance"],
      ["counterfeit stable identity helper", "signal-helper-provenance"],
      ["global process replacement", "process-binding-shadow"],
      ["aliased global process replacement", "signal-helper-provenance"],
      ["aliased object mutator", "signal-helper-provenance"],
      ["destructured conditional object mutator", "signal-helper-provenance"],
      ["projected object mutator", "signal-helper-provenance"],
      ["computed destructured object mutator", "signal-helper-provenance"],
      ["assigned destructured object mutator", "signal-helper-provenance"],
      ["array-assigned object mutator", "signal-helper-provenance"],
      ["member-stored object mutator", "signal-helper-provenance"],
      ["logical-assigned object mutator", "signal-helper-provenance"],
      ["call-bound evaluator", "signal-helper-provenance"],
      ["aliased assert authority", "signal-helper-provenance"],
      ["sequence-wrapped assert authority", "signal-helper-provenance"],
      ["logical-wrapped assert authority", "signal-helper-provenance"],
      ["awaited assert authority", "signal-helper-provenance"],
      ["yielded assert authority", "signal-helper-provenance"],
      ["spread assert authority", "signal-helper-provenance"],
      ["defaulted assert authority", "signal-helper-provenance"],
      ["iterated assert authority", "signal-helper-provenance"],
      ["thrown assert authority", "signal-helper-provenance"],
      ["class-field assert authority", "signal-helper-provenance"],
      ["tagged assert authority", "signal-helper-provenance"],
      ["projected assert authority", "signal-helper-provenance"],
      ["nested projected assert authority", "signal-helper-provenance"],
      ["callback-carried assert authority", "signal-helper-provenance"],
      ["literal intrinsic recovery", "signal-helper-provenance"],
      ["subclass intrinsic recovery", "signal-helper-provenance"],
      ["prototype intrinsic recovery", "signal-helper-provenance"],
      ["dynamic authority import", "signal-helper-provenance"],
      ["aliased builtin-module loader", "signal-helper-provenance"],
      ["comma-wrapped builtin loader", "signal-helper-provenance"],
      ["nested destructured native loaders", "signal-helper-provenance"],
      ["transitive main-module loader", "signal-helper-provenance"],
      ["aliased intrinsic prototype", "signal-helper-provenance"],
      ["shadowed clock authority", "signal-helper-provenance"],
      ["computed global process replacement", "process-binding-shadow"],
      ["reflected global process replacement", "process-binding-shadow"],
      ["assigned global process replacement", "process-binding-shadow"],
      ["external signal command", "external-signal-command"],
      ["external signal command via call", "external-signal-command"],
      ["external pkill command", "external-signal-command"],
      ["external shell signal command", "external-signal-command"],
      ["allowlisted probe shell", "external-signal-command"],
      ["unresolved external command", "external-signal-command"],
      ["native binding loader", "signal-helper-provenance"],
      ["aliased native binding loader", "signal-helper-provenance"],
      ["projected native binding loader", "signal-helper-provenance"],
      ["main-module require loader", "signal-helper-provenance"],
      ["aliased child-process import", "signal-helper-provenance"],
      ["static module loader import", "signal-helper-provenance"],
      ["counterfeit cooperative spawn owner", "external-signal-command"],
      ["counterfeit browser harness path", "external-signal-command"],
      ["embedded child-process command", "external-signal-command"],
      ["embedded shell signal command", "external-signal-command"],
      ["projected controller ledger", "signal-helper-provenance"],
      ["callback controller ledger", "signal-helper-provenance"],
      ["called controller ledger method", "signal-helper-provenance"],
      ["whitespace-obscured access", "blind-signal-call"],
      ["prefixed builder bypass", "blind-signal-call"],
      ["prefixed aliased eval bypass", "kill-reference-escape"],
      ["prefixed assigned eval bypass", "kill-reference-escape"],
      ["nested embedded program", "embedded-signal-program"],
      ["duplicate allowed call", "signal-call-multiset"],
      ["abrupt missing repeated relation", "abrupt-harness-authorization"],
      ...abruptRelationCarrierMutationKeys.map((key) => [
        `abrupt missing relation carrier ${key}`,
        "abrupt-harness-authorization",
      ]),
      ["abrupt unreachable branch", "abrupt-harness-authorization"],
      ["abrupt preceding return", "abrupt-harness-authorization"],
      ["abrupt preceding throw", "abrupt-harness-authorization"],
      ["abrupt preceding infinite loop", "abrupt-harness-authorization"],
      ["abrupt destructured assert shadow", "abrupt-harness-authorization"],
      ["abrupt assert method replacement", "abrupt-harness-authorization"],
      ["controller without immediate verification", "controller-verification"],
      ["controller permits unledgered hard kill", "controller-verification"],
      ["controller drops post-spawn setup failure", "controller-verification"],
      ["controller delays acquisition ledger", "controller-verification"],
      ["controller tolerates missing live identity", "controller-verification"],
      ["controller restarts retention budget", "controller-verification"],
      ["controller counts retention after probes", "controller-verification"],
      ["controller conflates no subject", "controller-verification"],
      ["controller loses unbound close polling", "controller-verification"],
      ["controller loses absolute outcome bound", "controller-verification"],
      ["controller skips setup termination", "controller-verification"],
      ["controller caches recovery rejection", "controller-verification"],
      ["controller drops setup recovery aggregate", "controller-verification"],
    ];
    for (const [mutation, category] of mutationContracts) {
      const source = syntheticSignalMutationSource(mutation);
      assert.notEqual(source, canonical, "signal mutation was a no-op");
      const findings = collectBlindSignalDiagnostics(source, "synthetic-signal", "signal-only");
      assert.equal(
        findings.some((entry) => entry.endsWith(`:${category}`)),
        true,
        "signal oracle accepted an unsafe mutation",
      );
      assert.equal(
        findings.every((entry) => /^synthetic-signal:[0-9]+:[a-z0-9-]+$/.test(entry)),
        true,
        "signal diagnostics exposed source content",
      );
    }
    assert.deepEqual(
      collectBlindSignalDiagnostics(
        `${canonical}\nconst inertSignalProse="process cleanup documentation (SIGKILL)";void inertSignalProse;`,
        "synthetic-signal",
        "signal-only",
      ),
      [],
      "signal oracle rejected inert documentation",
    );
    const whitespaceVariant = canonical
      .split("\n")
      .map((line, index) => (index % 2 === 0 ? `  ${line}` : `\t${line}`))
      .join("\n");
    assert.deepEqual(
      collectBlindSignalDiagnostics(whitespaceVariant, "synthetic-signal", "signal-only"),
      [],
      "signal oracle rejected a whitespace-only canonical variant",
    );
  });

  it("Red G requires the exact authorized signal-call multiset", {
    timeout: 30_000,
  }, async () => {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    assert.deepEqual(
      collectBlindSignalDiagnostics(source, "hr-browser-harness.test.mjs", "full"),
      [],
      "signal authority escaped the exact probe, controller, or abrupt-harness contract",
    );
    const ackOuterBarrierNeedle = [
      '  it("waits for exact one-link ACK publication before browser execution", {',
      "    timeout: 75_000,",
      "  }, async () => {",
      '    const root = await realpath(await mkdtemp(join(wrapperTemporaryRoot, "ack-publication-")));',
    ].join("\n");
    assert.equal(
      source.split(ackOuterBarrierNeedle).length - 1,
      1,
      "ACK outer-barrier mutation anchor was not exact-once",
    );
    const unreachableAckRegistration = source.replace(
      ackOuterBarrierNeedle,
      `${ackOuterBarrierNeedle}\n    return;`,
    );
    assert.equal(
      collectBlindSignalDiagnostics(
        unreachableAckRegistration,
        "synthetic-ack-outer-barrier",
        "full",
      ).some((entry) => entry.endsWith(":external-signal-command")),
      true,
      "signal oracle accepted an unreachable ACK publication spawn",
    );
  });

  it("Red G self-defends the suite-finalizer structural oracle", {
    timeout: 30_000,
  }, () => {
    const canonical = canonicalSuiteFinalizerSource();
    assert.deepEqual(collectSuiteFinalizerDiagnostics(canonical, "synthetic-finalizer"), []);
    const mutations = [
      "const broken =",
      canonical.replace(
        "after(async()=>{",
        'throw new Error("blocked before suite finalizer registration");after(async()=>{',
      ),
      canonical.replace("after(async()=>{", "while(true){}after(async()=>{"),
      canonical.replace(
        'const controllerResults=await Promise.allSettled([...activeWrapperControllers].map(async(controller)=>{const finishResults=await Promise.allSettled([controller.finish(suiteFinalizerFinishTimeoutMs)]);const verificationResults=await Promise.allSettled([(async()=>assert.equal(controller.phase,"finalized","suite controller did not finalize"))(),(async()=>assert.equal(controller.settled,true,"suite controller did not settle"))(),(async()=>assert.equal(activeWrapperControllers.has(controller),false,"suite controller remained active"))()]);return{finishResults,verificationResults}}));',
        'const controllerResults=[];for(const controller of activeWrapperControllers){controllerResults.push({status:"fulfilled",value:await controller.finish(suiteFinalizerFinishTimeoutMs)})}',
      ),
      canonical.replace(
        'const controllerFinishResults=controllerResults.flatMap((result)=>result.status==="fulfilled"?result.value.finishResults:[]);',
        "const controllerFinishResults=[];",
      ),
      canonical.replace(
        'const controllerVerificationResults=controllerResults.flatMap((result)=>result.status==="fulfilled"?result.value.verificationResults:[]);',
        "const controllerVerificationResults=[];",
      ),
      canonical.replace(
        "sameProcessIdentity(identity,readProcessIdentity(identity.pid,1_000)),false",
        "pidExists(identity.pid),false",
      ),
      canonical.replace("controller.finish(suiteFinalizerFinishTimeoutMs)", "controller.finish()"),
      canonical.replace(
        "controller.finish(suiteFinalizerFinishTimeoutMs)",
        "controller.finish(Number.MAX_SAFE_INTEGER)",
      ),
      canonical.replace(
        "const suiteFinalizerFinishTimeoutMs=75_000;",
        "const suiteFinalizerFinishTimeoutMs=Infinity;",
      ),
      canonical.replace(
        "const descriptorResults=await Promise.allSettled([...openWrapperOwnershipDescriptors].map(async(descriptor)=>{closeSync(descriptor);openWrapperOwnershipDescriptors.delete(descriptor)}));",
        "const descriptorResults=[];",
      ),
      canonical.replace(
        'const processResults=await Promise.allSettled(recordedWrapperIdentities.map(async(identity)=>assert.equal(sameProcessIdentity(identity,readProcessIdentity(identity.pid,1_000)),false,"wrapper identity remained live")));',
        "const processResults=[];",
      ),
      canonical.replace(
        "const ownedRootResults=await Promise.allSettled([(async()=>assert.deepEqual(await postgresTemporaryDirectories(),new Set()))(),(async()=>assert.deepEqual(await browserTemporaryDirectories(),new Set()))()]);",
        "const ownedRootResults=[];",
      ),
      canonical.replace(
        'if(failures.length>0)throw new AggregateError(failures.map((failure)=>failure.reason),"suite finalization failed")',
        "if(failures.length>0)throw failures[0].reason",
      ),
      canonical.replace(
        "await rmdir(wrapperTemporaryRoot)",
        "await rm(wrapperTemporaryRoot,{force:true,recursive:true})",
      ),
      `${canonical}\nafter(async()=>{})`,
      canonical.replace(
        'import {after} from "node:test";',
        'import {after as nodeAfter} from "node:test";const after=nodeAfter;',
      ),
      `${canonical}\nconst hiddenAfter=after;hiddenAfter(async()=>{});`,
      `${canonical}\n[after][0](async()=>{});`,
      `${canonical}\nafter.call(undefined,async()=>{});`,
      `${canonical}\nafter?.(async()=>{});`,
      `${canonical}\nafter\`hidden tagged finalizer\`;`,
      canonical.replace(
        'import {after} from "node:test";',
        'import {after,after as hiddenAfter} from "node:test";',
      ),
      `${canonical}\nactiveWrapperControllers.clear();openWrapperOwnershipDescriptors.clear();completedWrapperControllers.splice(0);recordedWrapperIdentities.splice(0);`,
      `${canonical}\n[activeWrapperControllers][0].clear();`,
      `${canonical}\nactiveWrapperControllers.forEach((_value,_same,self)=>self.clear());`,
      `${canonical}\nactiveWrapperControllers.clear.call(activeWrapperControllers);`,
      `${canonical}\nactiveWrapperControllers.clear?.();`,
      canonical.replace(
        "const activeWrapperControllers=new Set();",
        "let activeWrapperControllers=new Set();",
      ),
      canonical.replace(
        "function readProcessIdentity(pid, timeoutMs = 1_000) {",
        "function readProcessIdentity(pid, timeoutMs = 5_000) {",
      ),
    ];
    for (const source of mutations) {
      assert.notEqual(source, canonical, "suite-finalizer mutation was a no-op");
      const findings = collectSuiteFinalizerDiagnostics(source, "synthetic-finalizer");
      assert.equal(findings.length > 0, true, "suite-finalizer oracle accepted an unsafe mutation");
      assert.equal(
        findings.every((entry) => /^synthetic-finalizer:[0-9]+:[a-z0-9-]+$/.test(entry)),
        true,
        "suite-finalizer diagnostics exposed source content",
      );
    }
    const whitespaceVariant = canonical
      .split("\n")
      .map((line, index) => (index % 2 === 0 ? `  ${line}` : `\t${line}`))
      .join("\n");
    assert.deepEqual(
      collectSuiteFinalizerDiagnostics(whitespaceVariant, "synthetic-finalizer"),
      [],
      "suite-finalizer oracle rejected a whitespace-only variant",
    );
  });

  it("Red G requires attempt-all exact-identity suite finalization", {
    timeout: 30_000,
  }, async () => {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    assert.deepEqual(
      collectSuiteFinalizerDiagnostics(source, "hr-browser-harness.test.mjs"),
      [],
      "suite finalization is not attempt-all and exact-identity bounded",
    );
  });

  it("Red G self-defends failure-safe malformed fixture cleanup", {
    timeout: 30_000,
  }, async () => {
    const canonical = canonicalMalformedFixtureCleanupSource();
    assert.deepEqual(
      collectMalformedFixtureCleanupDiagnostics(canonical, "synthetic-fixture-cleanup"),
      [],
    );
    const recoveryReceipts = Object.freeze(
      [0, 1].map((index) => {
        const child = Object.freeze({ pid: 70_000 + index });
        const closeOutcome = Promise.resolve({ code: 0, signal: null });
        return Object.freeze({
          child,
          childPid: child.pid,
          closeOutcome,
          handlerReadyPath: `/private/handler-${index}`,
          label: malformedRecoveryExpectedFixtureLabels[index],
          signalMarkerPath: `/private/signal-${index}`,
          stopPath: `/private/stop-${index}`,
        });
      }),
    );
    const recoveryOwners = Object.freeze(
      recoveryReceipts.map((receipt, index) => {
        const identity = Object.freeze({
          command: `synthetic fixture ${index}`,
          pgid: receipt.childPid,
          pid: receipt.childPid,
          ppid: malformedRecoveryParentPid,
          session: receipt.childPid,
          start: "Mon Jan 01 00:00:00 2001",
          uid: 1_000 + index,
        });
        return Object.freeze({
          ...receipt,
          identity,
          sessionObservation: Object.freeze({
            identity,
            pid: receipt.childPid,
            platform: process.platform,
            state: "s",
          }),
        });
      }),
    );
    const legacyUnlabeledFixture = Object.freeze({
      child: recoveryReceipts[0].child,
      close: recoveryReceipts[0].closeOutcome,
      handlerReadyPath: recoveryReceipts[0].handlerReadyPath,
      signalMarkerPath: recoveryReceipts[0].signalMarkerPath,
      stopPath: recoveryReceipts[0].stopPath,
    });
    assert.equal(
      independentCooperativeReceipt(legacyUnlabeledFixture, "claimed").label,
      "claimed",
      "sealed slot label did not cover the legacy unlabeled fixture",
    );
    const mismatchedLabeledFixture = Object.freeze({
      ...legacyUnlabeledFixture,
      label: "sentinel",
    });
    assert.throws(
      () => independentCooperativeReceipt(mismatchedLabeledFixture, "claimed"),
      /did not match its sealed slot/,
      "a supplied fixture label overrode its sealed slot",
    );
    const fulfilled = (value) => Object.freeze({ status: "fulfilled", value });
    const replaceFrozenEntry = (values, index, value) =>
      Object.freeze(values.map((entry, position) => (position === index ? value : entry)));
    const ownedRoot = (path, index) =>
      Object.freeze({
        dev: `device-${index}`,
        ino: `inode-${index}`,
        label: `synthetic root ${index}`,
        path,
      });
    const unfrozenOwnedRoot = (path, index) => ({
      dev: `device-${index}`,
      ino: `inode-${index}`,
      label: `synthetic mutable root ${index}`,
      path,
    });
    const recoveryEvidence = (ownerCount) => {
      const exactOwners = Object.freeze(recoveryOwners.slice(0, ownerCount));
      const cleanupRoots = Object.freeze(
        ["/private/case-root", "/private/private-stop-root", "/private/signal-evidence-root"].map(
          (path, index) =>
            Object.freeze({
              label: `synthetic cleanup root ${index}`,
              owned: ownedRoot(path, index),
              path,
            }),
        ),
      );
      return {
        acquisitionReceipts: recoveryReceipts,
        cleanupRoots,
        closeJoins: Object.freeze(
          recoveryReceipts.map((receipt) =>
            fulfilled(
              Object.freeze({
                code: 0,
                pid: receipt.childPid,
                signal: null,
                signalAbsent: true,
              }),
            ),
          ),
        ),
        exactAbsenceResults: Object.freeze(
          exactOwners.map((owner) =>
            fulfilled(
              Object.freeze({
                identityAbsent: true,
                pid: owner.identity.pid,
                signalAbsent: true,
              }),
            ),
          ),
        ),
        exactOwners,
        helperCallAttempted: true,
        rootCapabilityResults: Object.freeze(
          cleanupRoots.map((root) =>
            fulfilled(Object.freeze({ kind: "owned", owned: root.owned })),
          ),
        ),
        stopPublications: Object.freeze(
          recoveryReceipts.map((receipt) =>
            fulfilled(Object.freeze({ kind: "published", stopPath: receipt.stopPath })),
          ),
        ),
      };
    };
    for (const ownerCount of [0, 1, 2]) {
      const evidence = recoveryEvidence(ownerCount);
      const plan = malformedRecoveryRootCleanupPlan(evidence);
      assert.deepEqual(
        plan,
        evidence.cleanupRoots.map((root) => root.owned),
        `exact ${ownerCount}-owner recovery evidence was rejected`,
      );
      assert.equal(Object.isFrozen(plan), true, "authorized cleanup plan was mutable");
      plan.forEach((owned, index) => {
        assert.equal(owned, evidence.cleanupRoots[index].owned);
      });
    }
    const rejectedStop = recoveryEvidence(1);
    rejectedStop.stopPublications = replaceFrozenEntry(
      rejectedStop.stopPublications,
      0,
      Object.freeze({
        reason: new Error("stop publication failed"),
        status: "rejected",
      }),
    );
    const signaledClose = recoveryEvidence(1);
    signaledClose.closeJoins = replaceFrozenEntry(
      signaledClose.closeJoins,
      0,
      fulfilled(
        Object.freeze({
          code: null,
          pid: recoveryReceipts[0].childPid,
          signal: "SIGTERM",
          signalAbsent: false,
        }),
      ),
    );
    const missingIdentityAbsence = recoveryEvidence(1);
    missingIdentityAbsence.exactAbsenceResults = replaceFrozenEntry(
      missingIdentityAbsence.exactAbsenceResults,
      0,
      fulfilled(
        Object.freeze({
          identityAbsent: false,
          pid: recoveryOwners[0].identity.pid,
          signalAbsent: true,
        }),
      ),
    );
    const rejectedIdentityAbsence = recoveryEvidence(1);
    rejectedIdentityAbsence.exactAbsenceResults = replaceFrozenEntry(
      rejectedIdentityAbsence.exactAbsenceResults,
      0,
      Object.freeze({
        reason: new Error("identity absence failed"),
        status: "rejected",
      }),
    );
    const duplicateOwner = recoveryEvidence(2);
    duplicateOwner.exactOwners = Object.freeze([recoveryOwners[0], recoveryOwners[0]]);
    duplicateOwner.exactAbsenceResults = Object.freeze([
      duplicateOwner.exactAbsenceResults[0],
      duplicateOwner.exactAbsenceResults[0],
    ]);
    const mismatchedOwner = recoveryEvidence(1);
    mismatchedOwner.exactOwners = Object.freeze([
      Object.freeze({ ...recoveryOwners[0], stopPath: "/private/wrong-stop" }),
    ]);
    const missingRootCapability = recoveryEvidence(1);
    missingRootCapability.cleanupRoots = replaceFrozenEntry(
      missingRootCapability.cleanupRoots,
      0,
      Object.freeze({
        ...missingRootCapability.cleanupRoots[0],
        owned: undefined,
      }),
    );
    const sparseReceipts = recoveryEvidence(0);
    sparseReceipts.acquisitionReceipts = new Array(2);
    sparseReceipts.acquisitionReceipts[1] = recoveryReceipts[1];
    const sparseStops = recoveryEvidence(1);
    sparseStops.stopPublications = new Array(2);
    const sparseCloses = recoveryEvidence(1);
    sparseCloses.closeJoins = new Array(2);
    const sparseAbsence = recoveryEvidence(1);
    sparseAbsence.exactAbsenceResults = new Array(1);
    const sparseOwners = recoveryEvidence(1);
    sparseOwners.exactOwners = new Array(1);
    sparseOwners.exactAbsenceResults = new Array(1);
    const sparseRoots = recoveryEvidence(1);
    sparseRoots.cleanupRoots = new Array(3);
    const sparseRootResults = recoveryEvidence(1);
    sparseRootResults.rootCapabilityResults = new Array(3);
    const oversizedRootResults = recoveryEvidence(1);
    oversizedRootResults.rootCapabilityResults = Object.freeze([
      ...oversizedRootResults.rootCapabilityResults,
      oversizedRootResults.rootCapabilityResults[0],
    ]);
    const mismatchedRoot = recoveryEvidence(1);
    const wrongOwnedRoot = ownedRoot("/private/wrong-root", 9);
    mismatchedRoot.cleanupRoots = replaceFrozenEntry(
      mismatchedRoot.cleanupRoots,
      0,
      Object.freeze({
        ...mismatchedRoot.cleanupRoots[0],
        owned: wrongOwnedRoot,
      }),
    );
    mismatchedRoot.rootCapabilityResults = replaceFrozenEntry(
      mismatchedRoot.rootCapabilityResults,
      0,
      fulfilled(Object.freeze({ kind: "owned", owned: wrongOwnedRoot })),
    );
    const rejectedRootCapability = recoveryEvidence(1);
    rejectedRootCapability.rootCapabilityResults = replaceFrozenEntry(
      rejectedRootCapability.rootCapabilityResults,
      0,
      Object.freeze({
        reason: new Error("root capability failed"),
        status: "rejected",
      }),
    );
    const duplicateRootTarget = recoveryEvidence(1);
    duplicateRootTarget.cleanupRoots = replaceFrozenEntry(
      duplicateRootTarget.cleanupRoots,
      2,
      duplicateRootTarget.cleanupRoots[1],
    );
    duplicateRootTarget.rootCapabilityResults = replaceFrozenEntry(
      duplicateRootTarget.rootCapabilityResults,
      2,
      duplicateRootTarget.rootCapabilityResults[1],
    );
    const asPreHelperEvidence = (evidence) => {
      evidence.acquisitionReceipts = Object.freeze([]);
      evidence.closeJoins = Object.freeze([]);
      evidence.exactAbsenceResults = Object.freeze([]);
      evidence.exactOwners = Object.freeze([]);
      evidence.helperCallAttempted = false;
      evidence.stopPublications = Object.freeze([]);
      return evidence;
    };
    const preHelperCapture = asPreHelperEvidence(recoveryEvidence(0));
    const recoveredRoot = ownedRoot(preHelperCapture.cleanupRoots[0].path, 10);
    preHelperCapture.cleanupRoots = replaceFrozenEntry(
      preHelperCapture.cleanupRoots,
      0,
      Object.freeze({
        ...preHelperCapture.cleanupRoots[0],
        owned: undefined,
      }),
    );
    preHelperCapture.rootCapabilityResults = replaceFrozenEntry(
      preHelperCapture.rootCapabilityResults,
      0,
      fulfilled(Object.freeze({ kind: "owned", owned: recoveredRoot })),
    );
    const preHelperPlan = malformedRecoveryRootCleanupPlan(preHelperCapture);
    assert.deepEqual(
      preHelperPlan,
      [
        recoveredRoot,
        preHelperCapture.cleanupRoots[1].owned,
        preHelperCapture.cleanupRoots[2].owned,
      ],
      "pre-helper recovered capability was not selected for exact deletion",
    );
    assert.equal(Object.isFrozen(preHelperPlan), true, "pre-helper cleanup plan was mutable");
    assert.equal(preHelperPlan?.[0], recoveredRoot, "recovered capability identity changed");
    const partialPreHelperCapture = asPreHelperEvidence(recoveryEvidence(0));
    partialPreHelperCapture.cleanupRoots = replaceFrozenEntry(
      partialPreHelperCapture.cleanupRoots,
      0,
      Object.freeze({
        ...partialPreHelperCapture.cleanupRoots[0],
        owned: undefined,
        path: undefined,
      }),
    );
    partialPreHelperCapture.rootCapabilityResults = replaceFrozenEntry(
      partialPreHelperCapture.rootCapabilityResults,
      0,
      fulfilled(Object.freeze({ kind: "absent" })),
    );
    const partialPreHelperPlan = malformedRecoveryRootCleanupPlan(partialPreHelperCapture);
    assert.deepEqual(
      partialPreHelperPlan,
      [
        partialPreHelperCapture.cleanupRoots[1].owned,
        partialPreHelperCapture.cleanupRoots[2].owned,
      ],
      "partial pre-helper setup selected an absent root for deletion",
    );
    const rejectedPreHelperCapability = asPreHelperEvidence(recoveryEvidence(0));
    rejectedPreHelperCapability.rootCapabilityResults = replaceFrozenEntry(
      rejectedPreHelperCapability.rootCapabilityResults,
      0,
      Object.freeze({
        reason: new Error("pre-helper root capability failed"),
        status: "rejected",
      }),
    );
    const sparsePreHelperEvidence = asPreHelperEvidence(recoveryEvidence(0));
    sparsePreHelperEvidence.rootCapabilityResults = new Array(3);
    const nonemptyPreHelperEvidence = recoveryEvidence(0);
    nonemptyPreHelperEvidence.helperCallAttempted = false;
    const nonBooleanPostHelperEvidence = recoveryEvidence(1);
    nonBooleanPostHelperEvidence.helperCallAttempted = "true";
    const nonBooleanPreHelperEvidence = asPreHelperEvidence(recoveryEvidence(0));
    nonBooleanPreHelperEvidence.helperCallAttempted = 0;
    const mismatchedPreHelperRoot = asPreHelperEvidence(recoveryEvidence(0));
    mismatchedPreHelperRoot.cleanupRoots = replaceFrozenEntry(
      mismatchedPreHelperRoot.cleanupRoots,
      0,
      Object.freeze({
        ...mismatchedPreHelperRoot.cleanupRoots[0],
        owned: undefined,
      }),
    );
    mismatchedPreHelperRoot.rootCapabilityResults = replaceFrozenEntry(
      mismatchedPreHelperRoot.rootCapabilityResults,
      0,
      fulfilled(
        Object.freeze({
          kind: "owned",
          owned: ownedRoot("/private/wrong-recovered-root", 11),
        }),
      ),
    );
    const mutableHelperCapability = recoveryEvidence(1);
    const mutableHelperOwned = unfrozenOwnedRoot(mutableHelperCapability.cleanupRoots[0].path, 12);
    mutableHelperCapability.cleanupRoots = replaceFrozenEntry(
      mutableHelperCapability.cleanupRoots,
      0,
      Object.freeze({
        ...mutableHelperCapability.cleanupRoots[0],
        owned: mutableHelperOwned,
      }),
    );
    mutableHelperCapability.rootCapabilityResults = replaceFrozenEntry(
      mutableHelperCapability.rootCapabilityResults,
      0,
      fulfilled(Object.freeze({ kind: "owned", owned: mutableHelperOwned })),
    );
    const mutablePreHelperCapability = asPreHelperEvidence(recoveryEvidence(0));
    const mutablePreHelperOwned = unfrozenOwnedRoot(
      mutablePreHelperCapability.cleanupRoots[0].path,
      13,
    );
    mutablePreHelperCapability.cleanupRoots = replaceFrozenEntry(
      mutablePreHelperCapability.cleanupRoots,
      0,
      Object.freeze({
        ...mutablePreHelperCapability.cleanupRoots[0],
        owned: undefined,
      }),
    );
    mutablePreHelperCapability.rootCapabilityResults = replaceFrozenEntry(
      mutablePreHelperCapability.rootCapabilityResults,
      0,
      fulfilled(Object.freeze({ kind: "owned", owned: mutablePreHelperOwned })),
    );
    const mutableCleanupRootArray = recoveryEvidence(1);
    mutableCleanupRootArray.cleanupRoots = [...mutableCleanupRootArray.cleanupRoots];
    const mutableCleanupRootRecord = recoveryEvidence(1);
    mutableCleanupRootRecord.cleanupRoots = replaceFrozenEntry(
      mutableCleanupRootRecord.cleanupRoots,
      0,
      { ...mutableCleanupRootRecord.cleanupRoots[0] },
    );
    const mutableRootResultArray = recoveryEvidence(1);
    mutableRootResultArray.rootCapabilityResults = [
      ...mutableRootResultArray.rootCapabilityResults,
    ];
    const mutableRootResultEnvelope = recoveryEvidence(1);
    mutableRootResultEnvelope.rootCapabilityResults = replaceFrozenEntry(
      mutableRootResultEnvelope.rootCapabilityResults,
      0,
      {
        status: "fulfilled",
        value: mutableRootResultEnvelope.rootCapabilityResults[0].value,
      },
    );
    const mutableRootResultValue = recoveryEvidence(1);
    mutableRootResultValue.rootCapabilityResults = replaceFrozenEntry(
      mutableRootResultValue.rootCapabilityResults,
      0,
      Object.freeze({
        status: "fulfilled",
        value: {
          kind: "owned",
          owned: mutableRootResultValue.cleanupRoots[0].owned,
        },
      }),
    );
    let getterExecutions = 0;
    let proxyTrapExecutions = 0;
    const frozenGetterRecord = (value, key) => {
      const record = { ...value };
      delete record[key];
      Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        get() {
          getterExecutions += 1;
          return value[key];
        },
      });
      return Object.freeze(record);
    };
    const proxyHandler = {
      get(target, key, receiver) {
        proxyTrapExecutions += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyTrapExecutions += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf() {
        proxyTrapExecutions += 1;
        throw new Error("proxy getPrototypeOf trap executed");
      },
      isExtensible(target) {
        proxyTrapExecutions += 1;
        return Reflect.isExtensible(target);
      },
      ownKeys(target) {
        proxyTrapExecutions += 1;
        return Reflect.ownKeys(target);
      },
    };
    const getterOuterEvidence = recoveryEvidence(1);
    const getterOuterCleanupRoots = getterOuterEvidence.cleanupRoots;
    delete getterOuterEvidence.cleanupRoots;
    Object.defineProperty(getterOuterEvidence, "cleanupRoots", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return getterOuterCleanupRoots;
      },
    });
    const proxyOuterEvidence = new Proxy(recoveryEvidence(1), proxyHandler);
    const nonPlainOuterEvidence = Object.assign(
      Object.create({ hidden: true }),
      recoveryEvidence(1),
    );
    const symbolOuterEvidence = {
      ...recoveryEvidence(1),
      [Symbol("hidden")]: true,
    };
    const extraOuterEvidence = { ...recoveryEvidence(1), extra: true };
    const replaceReceiptAuthority = (evidence, updates) => {
      const receipt = Object.freeze({
        ...evidence.acquisitionReceipts[0],
        ...updates,
      });
      evidence.acquisitionReceipts = replaceFrozenEntry(evidence.acquisitionReceipts, 0, receipt);
      evidence.exactOwners = replaceFrozenEntry(
        evidence.exactOwners,
        0,
        Object.freeze({
          ...evidence.exactOwners[0],
          child: receipt.child,
          childPid: receipt.childPid,
          closeOutcome: receipt.closeOutcome,
        }),
      );
    };
    const replaceOwnerSessionObservation = (
      evidence,
      sessionObservation,
      identity = evidence.exactOwners[0].identity,
    ) => {
      evidence.exactOwners = replaceFrozenEntry(
        evidence.exactOwners,
        0,
        Object.freeze({
          ...evidence.exactOwners[0],
          identity,
          sessionObservation,
        }),
      );
    };
    const postHelperEvidenceWithReceiptCount = (receiptCount) => {
      const evidence = recoveryEvidence(receiptCount);
      evidence.acquisitionReceipts = Object.freeze(
        evidence.acquisitionReceipts.slice(0, receiptCount),
      );
      evidence.closeJoins = Object.freeze(evidence.closeJoins.slice(0, receiptCount));
      evidence.stopPublications = Object.freeze(evidence.stopPublications.slice(0, receiptCount));
      return evidence;
    };
    const replaceRecoveryLabels = (evidence, receiptLabels, ownerLabels = receiptLabels) => {
      evidence.acquisitionReceipts = Object.freeze(
        evidence.acquisitionReceipts.map((receipt, index) =>
          Object.freeze({ ...receipt, label: receiptLabels[index] }),
        ),
      );
      evidence.exactOwners = Object.freeze(
        evidence.exactOwners.map((owner, index) =>
          Object.freeze({ ...owner, label: ownerLabels[index] }),
        ),
      );
      return evidence;
    };
    const emptyPostHelperEvidence = postHelperEvidenceWithReceiptCount(0);
    const partialPostHelperEvidence = postHelperEvidenceWithReceiptCount(1);
    const wrongOrderLabelEvidence = replaceRecoveryLabels(
      recoveryEvidence(2),
      Object.freeze(["sentinel", "claimed"]),
    );
    const duplicateLabelEvidence = replaceRecoveryLabels(
      recoveryEvidence(2),
      Object.freeze(["claimed", "claimed"]),
    );
    const ownerLabelMismatchEvidence = replaceRecoveryLabels(
      recoveryEvidence(1),
      malformedRecoveryExpectedFixtureLabels,
      Object.freeze(["sentinel"]),
    );
    const simulatedLiveProcessPid = malformedRecoveryParentPid + 1;
    assert.notEqual(
      simulatedLiveProcessPid,
      malformedRecoveryParentPid,
      "synthetic live PID source did not drift",
    );
    const forgedParentEvidence = recoveryEvidence(1);
    const forgedParentOwner = forgedParentEvidence.exactOwners[0];
    const forgedParentIdentity = Object.freeze({
      ...forgedParentOwner.identity,
      ppid: simulatedLiveProcessPid,
    });
    replaceOwnerSessionObservation(
      forgedParentEvidence,
      Object.freeze({
        ...forgedParentOwner.sessionObservation,
        identity: forgedParentIdentity,
      }),
      forgedParentIdentity,
    );
    const getterChildEvidence = recoveryEvidence(1);
    const getterChild = {};
    Object.defineProperty(getterChild, "pid", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return getterChildEvidence.acquisitionReceipts[0].childPid;
      },
    });
    replaceReceiptAuthority(getterChildEvidence, { child: Object.freeze(getterChild) });
    const getterCloseOutcomeEvidence = recoveryEvidence(1);
    const getterCloseOutcome = {};
    // biome-ignore lint/suspicious/noThenProperty: This adversarial fixture must exercise an accessor-bearing thenable.
    Object.defineProperty(getterCloseOutcome, "then", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return Promise.prototype.then;
      },
    });
    replaceReceiptAuthority(getterCloseOutcomeEvidence, {
      closeOutcome: Object.freeze(getterCloseOutcome),
    });
    const getterIdentityEvidence = recoveryEvidence(1);
    getterIdentityEvidence.exactOwners = replaceFrozenEntry(
      getterIdentityEvidence.exactOwners,
      0,
      Object.freeze({
        ...getterIdentityEvidence.exactOwners[0],
        identity: frozenGetterRecord(getterIdentityEvidence.exactOwners[0].identity, "pid"),
      }),
    );
    const proxyChildEvidence = recoveryEvidence(1);
    replaceReceiptAuthority(proxyChildEvidence, {
      child: new Proxy(proxyChildEvidence.acquisitionReceipts[0].child, proxyHandler),
    });
    const proxyCloseOutcomeEvidence = recoveryEvidence(1);
    replaceReceiptAuthority(proxyCloseOutcomeEvidence, {
      closeOutcome: new Proxy(
        proxyCloseOutcomeEvidence.acquisitionReceipts[0].closeOutcome,
        proxyHandler,
      ),
    });
    const proxyIdentityEvidence = recoveryEvidence(1);
    proxyIdentityEvidence.exactOwners = replaceFrozenEntry(
      proxyIdentityEvidence.exactOwners,
      0,
      Object.freeze({
        ...proxyIdentityEvidence.exactOwners[0],
        identity: new Proxy(proxyIdentityEvidence.exactOwners[0].identity, proxyHandler),
      }),
    );
    const nullSessionObservationEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(nullSessionObservationEvidence, null);
    const nullSessionIdentityEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      nullSessionIdentityEvidence,
      Object.freeze({
        ...nullSessionIdentityEvidence.exactOwners[0].sessionObservation,
        identity: null,
      }),
    );
    const mutableSessionObservationEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(mutableSessionObservationEvidence, {
      ...mutableSessionObservationEvidence.exactOwners[0].sessionObservation,
    });
    const mutableSessionIdentityEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      mutableSessionIdentityEvidence,
      Object.freeze({
        ...mutableSessionIdentityEvidence.exactOwners[0].sessionObservation,
        identity: {
          ...mutableSessionIdentityEvidence.exactOwners[0].sessionObservation.identity,
        },
      }),
    );
    const getterSessionObservationEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      getterSessionObservationEvidence,
      frozenGetterRecord(
        getterSessionObservationEvidence.exactOwners[0].sessionObservation,
        "state",
      ),
    );
    const getterSessionIdentityEvidence = recoveryEvidence(1);
    const getterSessionIdentityObservation =
      getterSessionIdentityEvidence.exactOwners[0].sessionObservation;
    replaceOwnerSessionObservation(
      getterSessionIdentityEvidence,
      Object.freeze({
        ...getterSessionIdentityObservation,
        identity: frozenGetterRecord(getterSessionIdentityObservation.identity, "pid"),
      }),
    );
    const proxySessionObservationEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      proxySessionObservationEvidence,
      new Proxy(proxySessionObservationEvidence.exactOwners[0].sessionObservation, proxyHandler),
    );
    const proxySessionIdentityEvidence = recoveryEvidence(1);
    const proxySessionIdentityObservation =
      proxySessionIdentityEvidence.exactOwners[0].sessionObservation;
    replaceOwnerSessionObservation(
      proxySessionIdentityEvidence,
      Object.freeze({
        ...proxySessionIdentityObservation,
        identity: new Proxy(proxySessionIdentityObservation.identity, proxyHandler),
      }),
    );
    const symbolSessionObservationEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      symbolSessionObservationEvidence,
      Object.freeze({
        ...symbolSessionObservationEvidence.exactOwners[0].sessionObservation,
        [Symbol("hidden")]: true,
      }),
    );
    const symbolSessionIdentityEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      symbolSessionIdentityEvidence,
      Object.freeze({
        ...symbolSessionIdentityEvidence.exactOwners[0].sessionObservation,
        identity: Object.freeze({
          ...symbolSessionIdentityEvidence.exactOwners[0].sessionObservation.identity,
          [Symbol("hidden")]: true,
        }),
      }),
    );
    const customPrototypeSessionObservationEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      customPrototypeSessionObservationEvidence,
      Object.freeze(
        Object.assign(
          Object.create({ hidden: true }),
          customPrototypeSessionObservationEvidence.exactOwners[0].sessionObservation,
        ),
      ),
    );
    const customPrototypeSessionIdentityEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      customPrototypeSessionIdentityEvidence,
      Object.freeze({
        ...customPrototypeSessionIdentityEvidence.exactOwners[0].sessionObservation,
        identity: Object.freeze(
          Object.assign(
            Object.create({ hidden: true }),
            customPrototypeSessionIdentityEvidence.exactOwners[0].sessionObservation.identity,
          ),
        ),
      }),
    );
    const mismatchedSessionIdentityEvidence = recoveryEvidence(1);
    const mismatchedSessionIdentityObservation =
      mismatchedSessionIdentityEvidence.exactOwners[0].sessionObservation;
    replaceOwnerSessionObservation(
      mismatchedSessionIdentityEvidence,
      Object.freeze({
        ...mismatchedSessionIdentityObservation,
        identity: Object.freeze({
          ...mismatchedSessionIdentityObservation.identity,
          command: "different synthetic fixture",
        }),
      }),
    );
    const mismatchedSessionPidEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      mismatchedSessionPidEvidence,
      Object.freeze({
        ...mismatchedSessionPidEvidence.exactOwners[0].sessionObservation,
        pid: mismatchedSessionPidEvidence.exactOwners[0].identity.pid + 1,
      }),
    );
    const unsupportedSessionPlatformEvidence = recoveryEvidence(1);
    replaceOwnerSessionObservation(
      unsupportedSessionPlatformEvidence,
      Object.freeze({
        ...unsupportedSessionPlatformEvidence.exactOwners[0].sessionObservation,
        platform: "unsupported",
      }),
    );
    const mutatedSessionLeaderEvidence = recoveryEvidence(1);
    const mutatedSessionLeaderOwner = mutatedSessionLeaderEvidence.exactOwners[0];
    const mutatedSessionLeaderObservation = mutatedSessionLeaderOwner.sessionObservation;
    if (process.platform === "darwin") {
      replaceOwnerSessionObservation(
        mutatedSessionLeaderEvidence,
        Object.freeze({ ...mutatedSessionLeaderObservation, state: "R" }),
      );
    } else {
      const nonLeaderIdentity = Object.freeze({
        ...mutatedSessionLeaderOwner.identity,
        session: mutatedSessionLeaderOwner.identity.pid + 1,
      });
      replaceOwnerSessionObservation(
        mutatedSessionLeaderEvidence,
        Object.freeze({
          ...mutatedSessionLeaderObservation,
          identity: nonLeaderIdentity,
        }),
        nonLeaderIdentity,
      );
    }
    const prototypeGetter = {};
    Object.defineProperty(prototypeGetter, "child", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return recoveryReceipts[0].child;
      },
    });
    const frozenPrototypeGetter = Object.freeze(prototypeGetter);
    const prototypeReceiptEvidence = recoveryEvidence(1);
    replaceReceiptAuthority(prototypeReceiptEvidence, {
      ["__proto__"]: frozenPrototypeGetter,
    });
    const prototypeOwnerEvidence = recoveryEvidence(1);
    prototypeOwnerEvidence.exactOwners = replaceFrozenEntry(
      prototypeOwnerEvidence.exactOwners,
      0,
      Object.freeze({
        ...prototypeOwnerEvidence.exactOwners[0],
        ["__proto__"]: frozenPrototypeGetter,
      }),
    );
    const getterArrayEvidence = recoveryEvidence(1);
    const getterRootArray = [...getterArrayEvidence.cleanupRoots];
    Object.defineProperty(getterRootArray, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return getterArrayEvidence.cleanupRoots[0];
      },
    });
    getterArrayEvidence.cleanupRoots = Object.freeze(getterRootArray);
    const getterRootEvidence = recoveryEvidence(1);
    getterRootEvidence.cleanupRoots = replaceFrozenEntry(
      getterRootEvidence.cleanupRoots,
      0,
      frozenGetterRecord(getterRootEvidence.cleanupRoots[0], "path"),
    );
    const getterCapabilityEvidence = recoveryEvidence(1);
    const getterCapability = frozenGetterRecord(
      getterCapabilityEvidence.cleanupRoots[0].owned,
      "path",
    );
    getterCapabilityEvidence.cleanupRoots = replaceFrozenEntry(
      getterCapabilityEvidence.cleanupRoots,
      0,
      Object.freeze({ ...getterCapabilityEvidence.cleanupRoots[0], owned: getterCapability }),
    );
    getterCapabilityEvidence.rootCapabilityResults = replaceFrozenEntry(
      getterCapabilityEvidence.rootCapabilityResults,
      0,
      fulfilled(Object.freeze({ kind: "owned", owned: getterCapability })),
    );
    const getterEnvelopeEvidence = recoveryEvidence(1);
    getterEnvelopeEvidence.rootCapabilityResults = replaceFrozenEntry(
      getterEnvelopeEvidence.rootCapabilityResults,
      0,
      frozenGetterRecord(getterEnvelopeEvidence.rootCapabilityResults[0], "value"),
    );
    const getterValueEvidence = recoveryEvidence(1);
    getterValueEvidence.rootCapabilityResults = replaceFrozenEntry(
      getterValueEvidence.rootCapabilityResults,
      0,
      fulfilled(frozenGetterRecord(getterValueEvidence.rootCapabilityResults[0].value, "owned")),
    );
    const proxyArrayEvidence = recoveryEvidence(1);
    proxyArrayEvidence.cleanupRoots = new Proxy(proxyArrayEvidence.cleanupRoots, proxyHandler);
    const proxyRootEvidence = recoveryEvidence(1);
    proxyRootEvidence.cleanupRoots = replaceFrozenEntry(
      proxyRootEvidence.cleanupRoots,
      0,
      new Proxy(proxyRootEvidence.cleanupRoots[0], proxyHandler),
    );
    const proxyCapabilityEvidence = recoveryEvidence(1);
    const proxyCapability = new Proxy(proxyCapabilityEvidence.cleanupRoots[0].owned, proxyHandler);
    proxyCapabilityEvidence.cleanupRoots = replaceFrozenEntry(
      proxyCapabilityEvidence.cleanupRoots,
      0,
      Object.freeze({ ...proxyCapabilityEvidence.cleanupRoots[0], owned: proxyCapability }),
    );
    proxyCapabilityEvidence.rootCapabilityResults = replaceFrozenEntry(
      proxyCapabilityEvidence.rootCapabilityResults,
      0,
      fulfilled(Object.freeze({ kind: "owned", owned: proxyCapability })),
    );
    const proxyEnvelopeEvidence = recoveryEvidence(1);
    proxyEnvelopeEvidence.rootCapabilityResults = replaceFrozenEntry(
      proxyEnvelopeEvidence.rootCapabilityResults,
      0,
      new Proxy(proxyEnvelopeEvidence.rootCapabilityResults[0], proxyHandler),
    );
    const proxyValueEvidence = recoveryEvidence(1);
    proxyValueEvidence.rootCapabilityResults = replaceFrozenEntry(
      proxyValueEvidence.rootCapabilityResults,
      0,
      Object.freeze({
        status: "fulfilled",
        value: new Proxy(proxyValueEvidence.rootCapabilityResults[0].value, proxyHandler),
      }),
    );
    const symbolRootEvidence = recoveryEvidence(1);
    symbolRootEvidence.cleanupRoots = replaceFrozenEntry(
      symbolRootEvidence.cleanupRoots,
      0,
      Object.freeze({
        ...symbolRootEvidence.cleanupRoots[0],
        [Symbol("hidden")]: true,
      }),
    );
    const customPrototypeRootEvidence = recoveryEvidence(1);
    customPrototypeRootEvidence.cleanupRoots = replaceFrozenEntry(
      customPrototypeRootEvidence.cleanupRoots,
      0,
      Object.freeze(
        Object.assign(Object.create({ hidden: true }), customPrototypeRootEvidence.cleanupRoots[0]),
      ),
    );
    assert.equal(
      malformedRecoveryRootCleanupPlan(mutableHelperCapability),
      undefined,
      "mutable helper capability was selected for deletion",
    );
    assert.equal(
      malformedRecoveryRootCleanupPlan(mutablePreHelperCapability),
      undefined,
      "mutable pre-helper capability was selected for deletion",
    );
    for (const [id, evidence] of [
      ["rejected stop", rejectedStop],
      ["signaled close", signaledClose],
      ["missing identity absence", missingIdentityAbsence],
      ["rejected identity absence", rejectedIdentityAbsence],
      ["duplicate owner", duplicateOwner],
      ["mismatched owner", mismatchedOwner],
      ["empty post-helper receipt ledger", emptyPostHelperEvidence],
      ["partial post-helper receipt ledger", partialPostHelperEvidence],
      ["wrong ordered receipt labels", wrongOrderLabelEvidence],
      ["duplicate receipt labels", duplicateLabelEvidence],
      ["owner label mismatch", ownerLabelMismatchEvidence],
      ["missing root capability", missingRootCapability],
      ["sparse receipts", sparseReceipts],
      ["sparse stops", sparseStops],
      ["sparse closes", sparseCloses],
      ["sparse identity absence", sparseAbsence],
      ["sparse owners", sparseOwners],
      ["sparse cleanup roots", sparseRoots],
      ["sparse root results", sparseRootResults],
      ["oversized root results", oversizedRootResults],
      ["mismatched root capability", mismatchedRoot],
      ["rejected root capability", rejectedRootCapability],
      ["duplicate root target", duplicateRootTarget],
      ["rejected pre-helper capability", rejectedPreHelperCapability],
      ["sparse pre-helper evidence", sparsePreHelperEvidence],
      ["nonempty pre-helper fixture evidence", nonemptyPreHelperEvidence],
      ["nonboolean post-helper evidence", nonBooleanPostHelperEvidence],
      ["nonboolean pre-helper evidence", nonBooleanPreHelperEvidence],
      ["mismatched pre-helper recovered root", mismatchedPreHelperRoot],
      ["mutable helper capability", mutableHelperCapability],
      ["mutable pre-helper recovered capability", mutablePreHelperCapability],
      ["mutable cleanup-root array", mutableCleanupRootArray],
      ["mutable cleanup-root record", mutableCleanupRootRecord],
      ["mutable root-result array", mutableRootResultArray],
      ["mutable root-result envelope", mutableRootResultEnvelope],
      ["mutable root-result value", mutableRootResultValue],
      ["getter-bearing receipt child", getterChildEvidence],
      ["getter-bearing receipt close outcome", getterCloseOutcomeEvidence],
      ["getter-bearing owner identity", getterIdentityEvidence],
      ["proxy receipt child", proxyChildEvidence],
      ["proxy receipt close outcome", proxyCloseOutcomeEvidence],
      ["proxy owner identity", proxyIdentityEvidence],
      ["drifted live PID source forged owner parent", forgedParentEvidence],
      ["null owner session observation", nullSessionObservationEvidence],
      ["null session-observation identity", nullSessionIdentityEvidence],
      ["mutable owner session observation", mutableSessionObservationEvidence],
      ["mutable session-observation identity", mutableSessionIdentityEvidence],
      ["getter-bearing owner session observation", getterSessionObservationEvidence],
      ["getter-bearing session-observation identity", getterSessionIdentityEvidence],
      ["proxy owner session observation", proxySessionObservationEvidence],
      ["proxy session-observation identity", proxySessionIdentityEvidence],
      ["symbol-bearing owner session observation", symbolSessionObservationEvidence],
      ["symbol-bearing session-observation identity", symbolSessionIdentityEvidence],
      ["custom-prototype owner session observation", customPrototypeSessionObservationEvidence],
      ["custom-prototype session-observation identity", customPrototypeSessionIdentityEvidence],
      ["mismatched session-observation identity", mismatchedSessionIdentityEvidence],
      ["mismatched session-observation PID", mismatchedSessionPidEvidence],
      ["unsupported session-observation platform", unsupportedSessionPlatformEvidence],
      ["mutated semantic session leader", mutatedSessionLeaderEvidence],
      ["prototype-bearing receipt", prototypeReceiptEvidence],
      ["prototype-bearing owner", prototypeOwnerEvidence],
      ["getter-bearing array index", getterArrayEvidence],
      ["getter-bearing root", getterRootEvidence],
      ["getter-bearing capability", getterCapabilityEvidence],
      ["getter-bearing result envelope", getterEnvelopeEvidence],
      ["getter-bearing result value", getterValueEvidence],
      ["proxy array", proxyArrayEvidence],
      ["proxy root", proxyRootEvidence],
      ["proxy capability", proxyCapabilityEvidence],
      ["proxy result envelope", proxyEnvelopeEvidence],
      ["proxy result value", proxyValueEvidence],
      ["symbol-bearing root", symbolRootEvidence],
      ["custom-prototype root", customPrototypeRootEvidence],
      ["getter-bearing outer evidence", getterOuterEvidence],
      ["proxy outer evidence", proxyOuterEvidence],
      ["nonplain outer evidence", nonPlainOuterEvidence],
      ["symbol-bearing outer evidence", symbolOuterEvidence],
      ["extra outer evidence", extraOuterEvidence],
    ]) {
      assert.equal(
        malformedRecoveryRootCleanupPlan(evidence),
        undefined,
        `unsafe recovery evidence was authorized: ${id}`,
      );
    }
    let childLifecycleGetterExecutions = 0;
    const lifecycleGetterChild = {};
    Object.defineProperty(lifecycleGetterChild, "pid", {
      configurable: true,
      enumerable: true,
      value: recoveryReceipts[0].childPid,
      writable: true,
    });
    for (const key of ["exitCode", "signalCode", "stdin", "stdout", "stderr"]) {
      Object.defineProperty(lifecycleGetterChild, key, {
        configurable: true,
        enumerable: true,
        get() {
          childLifecycleGetterExecutions += 1;
          return null;
        },
      });
    }
    const lifecycleOutcome = await settleIndependentCooperativeReceipt(
      Object.freeze({
        ...recoveryReceipts[0],
        child: Object.freeze(lifecycleGetterChild),
      }),
      100,
    );
    assert.deepEqual(
      lifecycleOutcome,
      { code: 0, signal: null },
      "native close outcome did not control cooperative settlement",
    );
    assert.equal(
      childLifecycleGetterExecutions,
      0,
      "cooperative settlement read mutable child lifecycle state",
    );
    const getterCloseResult = { signal: null };
    Object.defineProperty(getterCloseResult, "code", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return 0;
      },
    });
    const frozenGetterCloseResult = Object.freeze(getterCloseResult);
    const frozenExtraCloseResult = Object.freeze({ code: 0, extra: true, signal: null });
    await assert.rejects(
      () =>
        settleIndependentCooperativeReceipt(
          Object.freeze({
            ...recoveryReceipts[0],
            closeOutcome: Promise.resolve(frozenGetterCloseResult),
          }),
          100,
        ),
      /close result was not exact data/,
      "getter-bearing resolved close result was trusted",
    );
    await assert.rejects(
      () =>
        settleIndependentCooperativeReceipt(
          Object.freeze({
            ...recoveryReceipts[0],
            closeOutcome: Promise.resolve(frozenExtraCloseResult),
          }),
          100,
        ),
      /close result was not exact data/,
      "extra resolved close authority was trusted",
    );
    await assert.rejects(
      () =>
        settleIndependentCooperativeReceipt(
          Object.freeze({
            ...recoveryReceipts[0],
            closeOutcome: new Promise(() => {}),
          }),
          25,
        ),
      /close exceeded its bound/,
      "never-settling close outcome escaped its local bound",
    );
    assert.equal(getterExecutions, 0, "recovery validation executed an accessor");
    assert.equal(proxyTrapExecutions, 0, "recovery validation executed a proxy trap");
    const mutations = [
      "const broken =",
      canonical.replace(
        "try{\ncaseRoot=await mkdtemp",
        'caseRoot=await mkdtemp(join(wrapperTemporaryRoot,"malformed-case-"));\ntry{\ncaseRoot=await mkdtemp',
      ),
      canonical.replace("try{\ncaseRoot=await mkdtemp", "try{\nreturn;\ncaseRoot=await mkdtemp"),
      canonical.replace(
        "await onFixturesCreated?.({caseRoot,fixtures:fixtureSlots});\nclaimed=await retainCooperativeFixture",
        "await onFixturesCreated?.({caseRoot,fixtures:fixtureSlots});\nreturn;\nclaimed=await retainCooperativeFixture",
      ),
      canonical.replace(
        "await onFixturesCreated?.({caseRoot,fixtures:fixtureSlots});\nclaimed=await retainCooperativeFixture",
        'await onFixturesCreated?.({caseRoot,fixtures:fixtureSlots});\n(()=>{throw new Error("stop")})();\nclaimed=await retainCooperativeFixture',
      ),
      canonical.replace(
        "const ownerResults=await Promise.allSettled(",
        "const ownerResults=await Promise.all(",
      ),
      canonical.replace(
        "const stopPublicationResults=await Promise.allSettled(",
        "const stopPublicationResults=await Promise.all(",
      ),
      canonical.replace(
        "const exactJoinResults=await Promise.allSettled(",
        "const exactJoinResults=await Promise.all(",
      ),
      canonical.replace(
        "}catch(error){hasPrimaryFailure=true;primaryFailure=error}finally{",
        "}finally{",
      ),
      canonical.replace(
        'throw new AggregateError([...(hasPrimaryFailure?[primaryFailure]:[]),...cleanupFailures],"Red F isolation cleanup was incomplete")',
        "throw cleanupFailures[0]",
      ),
      canonical.replace(
        "const caseRootResults=await Promise.allSettled(everyAcquiredFixtureClosed&&exactControllerFinalizationFulfilled?",
        "const caseRootResults=await Promise.allSettled(true?",
      ),
      canonical.replace(
        "await cleanupExactOwnedDirectories([caseRootOwned])",
        "await rm(caseRoot,{force:true,recursive:true})",
      ),
      canonical.replace(
        'async function writePrivateStop(path){try{await writeFile(path,"stop\\n",{flag:"wx",mode:0o600})}catch(error){if(error?.code!=="EEXIST")throw error}}',
        "async function writePrivateStop(){}",
      ),
      canonical.replace(
        "async function runMalformedCancellationIsolationCase({afterFixtureIdentityCapture,beforeControllerAcquisition,fixturePrivateStopRoot,fixtureSignalEvidenceRoot,onCaseRootAcquired,onFixtureAcquired,onFixturesCreated}={}){",
        "async function runMalformedCancellationIsolationCase({afterFixtureIdentityCapture,beforeControllerAcquisition,fixturePrivateStopRoot,fixtureSignalEvidenceRoot,onCaseRootAcquired,onFixtureAcquired,onFixturesCreated,spawnCooperativeFixture=()=>{}}={}){",
      ),
      canonical.replace(
        "slot.child=spawn(process.execPath",
        "const hiddenChild=spawn(process.execPath",
      ),
      canonical.replace('slot.acquisition="no-subject"', 'slot.acquisition="acquired"'),
      canonical.replace(
        "function refreshCooperativeClose(subject){if(!subject.child||subject.closeState.observed)return;if(subject.child.exitCode!==null||subject.child.signalCode!==null)publishCooperativeClose(subject,{code:subject.child.exitCode,signal:subject.child.signalCode})}",
        "function refreshCooperativeClose(){}",
      ),
      canonical.replace(
        'assert.equal(await pathExists(slot.signalMarkerPath),false,"cooperative fixture was signaled");slot.signalAbsent=true;',
        "slot.signalAbsent=true;",
      ),
      canonical.replace(
        "try{onFixtureAcquired?.(slot.receipt,slot)}catch(error){acquisitionHookError=error}observeChildClose(slot)",
        "observeChildClose(slot);try{onFixtureAcquired?.(slot.receipt,slot)}catch(error){acquisitionHookError=error}",
      ),
      canonical.replace(
        'const ownerResults=await Promise.allSettled(fixtureSlots.map(async(slot)=>{if(["not-attempted","no-subject"].includes(slot.acquisition))return{kind:"absent"};const owner=await retainCooperativeFixture(slot);return{kind:"owned",owner}}));\nconst stopPublicationResults=await Promise.allSettled(fixtureSlots.map((slot)=>publishCooperativeFixtureStop(slot)));',
        'const stopPublicationResults=await Promise.allSettled(fixtureSlots.map((slot)=>publishCooperativeFixtureStop(slot)));\nconst ownerResults=await Promise.allSettled(fixtureSlots.map(async(slot)=>{if(["not-attempted","no-subject"].includes(slot.acquisition))return{kind:"absent"};const owner=await retainCooperativeFixture(slot);return{kind:"owned",owner}}));',
      ),
      canonical.replace(
        'caseRoot=await mkdtemp(join(wrapperTemporaryRoot,"malformed-case-"));',
        'if(false){caseRoot=await mkdtemp(join(wrapperTemporaryRoot,"malformed-case-"))}',
      ),
      canonical.replace(
        'spawnCooperativeFixture(fixtureSlots[1],caseRoot,"sentinel",fixtureSignalEvidenceRoot??caseRoot,fixturePrivateStopRoot??caseRoot,[],onFixtureAcquired);',
        'function neverAcquireSentinel(){spawnCooperativeFixture(fixtureSlots[1],caseRoot,"sentinel",fixtureSignalEvidenceRoot??caseRoot,fixturePrivateStopRoot??caseRoot,[],onFixtureAcquired)}',
      ),
      canonical.replace(
        'try{controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});controllerAcquisition=controller.phase}catch(error){controllerAcquisition="no-subject";throw error}',
        'controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});controllerAcquisition=controller.phase;',
      ),
      canonical.replace(
        'try{controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});controllerAcquisition=controller.phase}catch(error){controllerAcquisition="no-subject";throw error}',
        'const acquireSyntheticController=spawnOwnedWrapperController;try{controller=acquireSyntheticController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});controllerAcquisition=controller.phase}catch(error){controllerAcquisition="no-subject";throw error}',
      ),
      `${canonical}\nfunction spawnOwnedWrapperController(){return{phase:"finalized"}}`,
      canonical.replace(
        "const beforePostgresRoots=await postgresTemporaryDirectories();",
        "const beforePostgresRoots=new Set();",
      ),
    ];
    const mutationCategories = [
      "parse-error",
      "fixture-cleanup-acquisition-protocol-invalid",
      "fixture-cleanup-acquisition-protocol-invalid",
      "fixture-cleanup-acquisition-protocol-invalid",
      "fixture-cleanup-acquisition-protocol-invalid",
      "fixture-cleanup-all-settled-missing",
      "fixture-cleanup-all-settled-missing",
      "fixture-cleanup-all-settled-missing",
      "fixture-cleanup-all-settled-missing",
      "fixture-cleanup-aggregate-invalid",
      "fixture-cleanup-all-settled-missing",
      "fixture-cleanup-all-settled-missing",
      "fixture-cleanup-helper-provenance",
      "fixture-cleanup-target-missing",
      "fixture-cleanup-helper-provenance",
      "fixture-cleanup-helper-provenance",
      "fixture-cleanup-helper-provenance",
      "fixture-cleanup-helper-provenance",
      "fixture-cleanup-helper-provenance",
      "fixture-cleanup-all-settled-missing",
      "fixture-cleanup-acquisition-protocol-invalid",
      "fixture-cleanup-acquisition-protocol-invalid",
      "fixture-cleanup-acquisition-protocol-invalid",
      "fixture-cleanup-acquisition-protocol-invalid",
      "fixture-cleanup-helper-provenance",
      "fixture-cleanup-acquisition-state-invalid",
    ];
    assert.equal(
      mutationCategories.length,
      mutations.length,
      "fixture-cleanup mutation category manifest drifted",
    );
    for (const [index, source] of mutations.entries()) {
      assert.notEqual(source, canonical, "fixture-cleanup mutation was a no-op");
      const findings = collectMalformedFixtureCleanupDiagnostics(
        source,
        "synthetic-fixture-cleanup",
      );
      assert.equal(
        findings.some((entry) => entry.endsWith(`:${mutationCategories[index]}`)),
        true,
        "fixture-cleanup oracle did not report the causal mutation category",
      );
      assert.equal(
        findings.every((entry) => /^synthetic-fixture-cleanup:[0-9]+:[a-z0-9-]+$/.test(entry)),
        true,
        "fixture-cleanup diagnostics exposed source content",
      );
    }
    const whitespaceVariant = canonical
      .split("\n")
      .map((line, index) => (index % 2 === 0 ? `  ${line}` : `\t${line}`))
      .join("\n");
    assert.deepEqual(
      collectMalformedFixtureCleanupDiagnostics(whitespaceVariant, "synthetic-fixture-cleanup"),
      [],
      "fixture-cleanup oracle rejected a whitespace-only variant",
    );
  });

  it("Red G requires attempt-all exact-join malformed fixture cleanup", {
    timeout: 30_000,
  }, async () => {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    assert.deepEqual(
      collectMalformedFixtureCleanupDiagnostics(source, "hr-browser-harness.test.mjs"),
      [],
      "malformed fixture cleanup is not attempt-all, aggregated, and exact-join gated",
    );
  });

  it("Red G self-defends independent malicious-registration deadlines", {
    timeout: 150_000,
  }, () => {
    const canonical = canonicalMaliciousDeadlineSource();
    assert.deepEqual(collectMaliciousDeadlineDiagnostics(canonical, "synthetic-malicious"), []);
    const firstVariant = maliciousRegistrationVariantContract[0];
    const firstRegistration = `it(${JSON.stringify(`denies malicious registration: ${firstVariant}`)},{timeout:150_000},async()=>{await runMaliciousRegistrationCase(${JSON.stringify(firstVariant)})})`;
    const registrationEnvelopeMutations = [
      {
        id: "direct exit before malicious registration",
        source: canonical.replace(
          'describe("malicious registration contracts",()=>{',
          'process.exit(0);\ndescribe("malicious registration contracts",()=>{',
        ),
      },
      {
        id: "IIFE exit before malicious registration",
        source: canonical.replace(
          'describe("malicious registration contracts",()=>{',
          '(()=>process.exit(0))();\ndescribe("malicious registration contracts",()=>{',
        ),
      },
      {
        id: "unbounded await before malicious registration",
        source: canonical.replace(
          'describe("malicious registration contracts",()=>{',
          'await new Promise(()=>{});\ndescribe("malicious registration contracts",()=>{',
        ),
      },
      {
        id: "helper-mediated top-level exit",
        source: canonical.replace(
          'describe("HR browser harness contracts",()=>{',
          'function exitBeforeRegistration(){process.exit(0)}\nexitBeforeRegistration();\ndescribe("HR browser harness contracts",()=>{',
        ),
      },
      {
        id: "initializer-mediated top-level exit",
        source: canonical.replace(
          'describe("HR browser harness contracts",()=>{',
          'function exitBeforeRegistration(){process.exit(0)}\nconst exitedDuringInitialization=exitBeforeRegistration();\ndescribe("HR browser harness contracts",()=>{',
        ),
      },
      {
        id: "direct HR callback helper execution",
        source: canonical
          .replace('it("registration shell",()=>{})', "exitBeforeRegistration()")
          .replace(
            'describe("HR browser harness contracts",()=>{',
            'function exitBeforeRegistration(){process.exit(0)}\ndescribe("HR browser harness contracts",()=>{',
          ),
      },
      {
        id: "HR title helper execution",
        source: canonical
          .replace('it("registration shell",()=>{})', "it(exitBeforeRegistration(),()=>{})")
          .replace(
            'describe("HR browser harness contracts",()=>{',
            'function exitBeforeRegistration(){process.exit(0)}\ndescribe("HR browser harness contracts",()=>{',
          ),
      },
      {
        id: "HR options helper execution",
        source: canonical.replace(
          'it("registration shell",()=>{})',
          'it("registration shell",{timeout:registrationDeadline()},()=>{})',
        ),
      },
      {
        id: "HR callback factory execution",
        source: canonical.replace(
          'it("registration shell",()=>{})',
          'it("registration shell",registrationCallbackFactory())',
        ),
      },
      {
        id: "class static initializer execution",
        source: canonical.replace(
          'describe("HR browser harness contracts",()=>{',
          'class ExitBeforeRegistration{static{process.exit(0)}}\ndescribe("HR browser harness contracts",()=>{',
        ),
      },
      {
        id: "conditional top-level execution",
        source: canonical.replace(
          'describe("HR browser harness contracts",()=>{',
          'if(true)process.exit(0);\ndescribe("HR browser harness contracts",()=>{',
        ),
      },
      {
        id: "loop-local named callback shadow",
        source: canonical.replace(
          'for(const signal of ["SIGINT","SIGTERM"]){it(`registration shell ${signal}`,{timeout:30_000},async()=>{})}',
          'for(const runAbruptHarnessCrashCase of ["not-a-function"]){it(`registration shell ${runAbruptHarnessCrashCase}`,{timeout:30_000},runAbruptHarnessCrashCase)}',
        ),
      },
      {
        id: "call-bearing loop iterable",
        source: canonical.replace(
          'for(const signal of ["SIGINT","SIGTERM"]){',
          "for(const signal of registrationValues()){",
        ),
      },
      {
        id: "spread-bearing loop iterable",
        source: canonical.replace(
          'for(const signal of ["SIGINT","SIGTERM"]){',
          'for(const signal of [...["SIGINT","SIGTERM"]]){',
        ),
      },
      {
        id: "post-registration exit",
        source: `${canonical}\nprocess.exit(0);`,
      },
    ];
    for (const mutation of registrationEnvelopeMutations) {
      assert.notEqual(
        mutation.source,
        canonical,
        `malicious registration-envelope mutation was a no-op: ${mutation.id}`,
      );
      const findings = collectMaliciousDeadlineDiagnostics(
        mutation.source,
        "synthetic-malicious-envelope",
      );
      assert.equal(
        findings.includes("synthetic-malicious-envelope:1:malicious-independent-deadlines-missing"),
        true,
        `malicious registration envelope accepted: ${mutation.id}`,
      );
      assert.equal(
        findings.every((entry) => /^synthetic-malicious-envelope:[0-9]+:[a-z0-9-]+$/.test(entry)),
        true,
        `malicious registration-envelope diagnostics exposed source content: ${mutation.id}`,
      );
    }
    const mutations = [
      "const broken =",
      canonical.replace(firstRegistration, ""),
      canonical.replace(firstRegistration, `${firstRegistration}\n${firstRegistration}`),
      canonical.replace("timeout:150_000", "timeout:90_000"),
      canonical.replace(firstRegistration, firstRegistration.replace("it(", "it.only(")),
      canonical.replace(firstRegistration, `if(false){${firstRegistration}}`),
      canonical.replace(
        firstRegistration,
        `function registerSyntheticMaliciousCase(){${firstRegistration}}`,
      ),
      canonical.replace(
        'describe("malicious registration contracts",()=>{',
        'describe("malicious registration contracts",{skip:true},()=>{',
      ),
      canonical.replace(
        'describe("malicious registration contracts",()=>{',
        'describe("malicious registration contracts",{concurrency:true},()=>{',
      ),
      canonical.replace(
        'describe("malicious registration contracts",()=>{',
        'describe("malicious registration contracts",()=>{const it=()=>{};',
      ),
      canonical.replace(
        'describe("malicious registration contracts",()=>{',
        'describe("malicious registration contracts",()=>{return;',
      ),
      canonical.replace(
        'describe("malicious registration contracts",()=>{',
        'describe("malicious registration contracts",function*(){',
      ),
      canonical.replace(
        'describe("malicious registration contracts",()=>{',
        'describe("malicious registration contracts",async function*(){',
      ),
      canonical.replace(
        `runMaliciousRegistrationCase(${JSON.stringify(firstVariant)})`,
        'runMaliciousRegistrationCase("wrong-variant")',
      ),
      `${canonical}\nit("shared malicious registrations",{timeout:150_000},async()=>{for(const variant of maliciousRegistrationVariants){await runMaliciousRegistrationCase(variant)}})`,
      `${canonical}\nit("renamed shared cases",{timeout:150_000},async()=>{for(const variant of maliciousRegistrationVariants){await alternateCase(variant)}})`,
      `${canonical}\nconst renamedVariants=maliciousRegistrationVariants;it("renamed shared cases",{timeout:150_000},async()=>{for(const variant of renamedVariants){await alternateCase(variant)}})`,
      `${canonical}\nconst renamedVariants=maliciousRegistrationVariants.slice();it("renamed shared cases",{timeout:150_000},async()=>{for(const variant of renamedVariants){await alternateCase(variant)}})`,
      `${canonical}\nmaliciousRegistrationVariants.forEach((variant)=>it("extra "+variant,{timeout:150_000},async()=>alternateCase(variant)));`,
      canonical.replace(
        "const maliciousRegistrationVariants=Object.freeze(",
        "let maliciousRegistrationVariants=(",
      ),
      canonical.replace(
        JSON.stringify(maliciousRegistrationVariantContract),
        JSON.stringify(maliciousRegistrationVariantContract.slice(1)),
      ),
      canonical.replace(
        JSON.stringify(maliciousRegistrationVariantContract),
        JSON.stringify([
          maliciousRegistrationVariantContract[1],
          maliciousRegistrationVariantContract[0],
          ...maliciousRegistrationVariantContract.slice(2),
        ]),
      ),
      canonical.replace(
        JSON.stringify(maliciousRegistrationVariantContract),
        JSON.stringify(["substituted-variant", ...maliciousRegistrationVariantContract.slice(1)]),
      ),
      canonical.replace("operationTimeoutMs:35_000", "operationTimeoutMs:70_000"),
      canonical.replace("waitForFile(readyPath,30_000)", "waitForFile(readyPath,60_000)"),
      canonical.replace("childOutcome(controller,73_000)", "childOutcome(controller,150_000)"),
      canonical.replace(
        "Promise.allSettled(ownershipLedger.map",
        "Promise.all(ownershipLedger.map",
      ),
      canonical.replace(
        "const rootTasks=everyAcquiredFixtureClosed&&exactControllerFinalizationFulfilled?",
        "const rootTasks=true?",
      ),
      `${canonical}\nimport {chromium as hiddenChromium} from "./browser-tooling/node_modules/@playwright/test/./index.mjs";hiddenChromium.executablePath=()=>"/counterfeit";`,
      `${canonical}\nimport {chromium as hiddenChromium} from "./browser-tooling/node_modules/@playwright/test/index.mjs?hidden";hiddenChromium.executablePath=()=>"/counterfeit";`,
      `${canonical}\nimport {chromium as hiddenChromium} from ${JSON.stringify(new URL("./browser-tooling/node_modules/@playwright/test/index.mjs", import.meta.url).href)};hiddenChromium.executablePath=()=>"/counterfeit";`,
      canonical.replace(
        'import {chromium as browserToolingChromium} from "./browser-tooling/node_modules/@playwright/test/index.mjs";',
        'import {chromium as browserToolingChromium,chromium as hiddenChromium} from "./browser-tooling/node_modules/@playwright/test/index.mjs";hiddenChromium.executablePath=()=>"/counterfeit";',
      ),
      `${canonical}\nconst leakedExecutable=browserToolingChromium.executablePath();console.error(leakedExecutable);`,
      `${canonical}\nconst hiddenBrowser=browserToolingChromium.launch();void hiddenBrowser;`,
      `${canonical}\nimport vm from "node:vm";vm.runInThisContext('Array.prototype.every=()=>true');`,
      `${canonical}\nimport repl from "node:repl";void repl;`,
      `${canonical}\nimport inspector from "node:inspector";void inspector;`,
      canonical +
        '\nimport "data:text/javascript,import%20%7Bit%7D%20from%20%22node%3Atest%22%3Bit(%22hidden%22%2C()%3D%3E%7B%7D)";',
      canonical +
        '\nimport {chromium as hiddenChromium} from "./browser-tooling/node_modules/.pnpm/@playwright+test@1.61.1/node_modules/@playwright/test/index.mjs";hiddenChromium.executablePath=()=>"/counterfeit";',
      canonical +
        '\nimport {chromium as hiddenChromium} from "./browser-tooling/node_modules/@PLAYWRIGHT/TEST/INDEX.MJS";hiddenChromium.executablePath=()=>"/counterfeit";',
      canonical +
        '\nimport {chromium as hiddenChromium} from "@playwright/test";hiddenChromium.executablePath=()=>"/counterfeit";',
      canonical +
        '\nimport {chromium as hiddenChromium} from "./browser-tooling/node_modules/.pnpm/node_modules/playwright/test.mjs";hiddenChromium.executablePath=()=>"/counterfeit";',
      canonical +
        '\nimport {strict as hiddenAssert} from "node:assert";hiddenAssert.equal=()=>{};hiddenAssert.deepEqual=()=>{};',
      canonical +
        '\nimport {Session as HiddenSession} from "node:inspector/promises";void HiddenSession;',
      canonical + '\nexport * from "node:inspector/promises";',
      canonical +
        '\nimport hiddenInspector=require("node:inspector/promises");void hiddenInspector;',
      canonical.replace(
        "async function runMaliciousRegistrationCase(variant){",
        "async function runMaliciousRegistrationCase(variant){if(false)return;",
      ),
      canonical.replace(
        'import {after,describe,it} from "node:test";',
        'import {after,describe,it as nodeIt} from "node:test";const it=nodeIt;',
      ),
      `${canonical}\nconst hiddenRun=runMaliciousRegistrationCase;it("hidden unbounded case",async()=>await hiddenRun("malformed"));`,
      `${canonical}\nconst hiddenVariant="malformed";it("hidden unbounded case",async()=>await runMaliciousRegistrationCase.call(undefined,hiddenVariant));`,
      `${canonical}\nconst hiddenVariant="malformed";it("hidden unbounded case",async()=>await runMaliciousRegistrationCase.apply(undefined,[hiddenVariant]));`,
      `${canonical}\nconst hiddenRun=runMaliciousRegistrationCase.valueOf();it("hidden unbounded case",async()=>await hiddenRun("malformed"));`,
      `${canonical}\nconst hiddenIt=it.valueOf();hiddenIt("hidden unbounded case",async()=>await runMaliciousRegistrationCase("malformed"));`,
      `${canonical}\n[it][0]("hidden unbounded case",async()=>await [runMaliciousRegistrationCase][0]("malformed"));`,
      `${canonical}\n[[it]][0][0]("nested hidden case",async()=>await [[runMaliciousRegistrationCase]][0][0]("malformed"));`,
      `${canonical}\nit.call(undefined,"hidden call case",async()=>await runMaliciousRegistrationCase("malformed"));`,
      `${canonical}\nit?.("hidden optional case",async()=>await runMaliciousRegistrationCase("malformed"));`,
      `${canonical}\nit\`hidden tagged case\`;`,
      `${canonical}\neval('it("hidden unbounded case",async()=>await runMaliciousRegistrationCase("malformed"))');`,
      `${canonical}\nglobalThis[JSON.parse('"eval"')]('it("hidden unbounded case",async()=>{})');`,
      `${canonical}\nbrowserToolingChromium.executablePath=()=>"/counterfeit";`,
      `${canonical}\nconst hiddenChromium=browserToolingChromium;hiddenChromium.executablePath=()=>"/counterfeit";`,
      `${canonical}\nconst hiddenChromium=browserToolingChromium.valueOf();hiddenChromium.executablePath=()=>"/counterfeit";`,
      `${canonical}\nconst hiddenChromium=browserToolingChromium["valueOf"]();hiddenChromium.executablePath=()=>"/counterfeit";`,
      `${canonical}\nbrowserToolingChromium.__defineGetter__("executablePath",()=>()=>"/counterfeit");`,
      `${canonical}\nbrowserToolingChromium.__defineSetter__("executablePath",()=>{});`,
      `${canonical}\nvoid browserToolingChromium.__lookupGetter__("executablePath");`,
      `${canonical}\nvoid browserToolingChromium.__lookupSetter__("executablePath");`,
      canonical.replace(
        'import {after,describe,it} from "node:test";',
        'import {after,describe,it,it as hiddenIt} from "node:test";',
      ),
      `${canonical.replace(
        'import {after,describe,it} from "node:test";',
        'import {createRequire as syntheticCreateRequire} from "node:module";import {after,describe,it} from "node:test";',
      )}\nconst syntheticRequire=syntheticCreateRequire(import.meta.url);const {it:syntheticIt}=syntheticRequire("node:test");syntheticIt("hidden loader case",async()=>{});`,
      `${canonical}\nactiveWrapperControllers.clear();openWrapperOwnershipDescriptors.clear();completedWrapperControllers.splice(0);recordedWrapperIdentities.splice(0);`,
      `${canonical}\n[activeWrapperControllers][0].clear();`,
      `${canonical}\nactiveWrapperControllers.forEach((_value,_same,self)=>self.clear());`,
      `${canonical}\nactiveWrapperControllers.clear.call(activeWrapperControllers);`,
      `${canonical}\nactiveWrapperControllers.clear?.();`,
    ];
    for (const source of mutations) {
      assert.notEqual(source, canonical, "malicious-registration mutation was a no-op");
      const findings = collectMaliciousDeadlineDiagnostics(source, "synthetic-malicious");
      assert.equal(
        findings.length > 0,
        true,
        "malicious-registration oracle accepted an unsafe mutation",
      );
      assert.equal(
        findings.every((entry) => /^synthetic-malicious:[0-9]+:[a-z0-9-]+$/.test(entry)),
        true,
        "malicious-registration diagnostics exposed source content",
      );
    }
    const whitespaceVariant = canonical
      .split("\n")
      .map((line, index) => (index % 2 === 0 ? `  ${line}` : `\t${line}`))
      .join("\n");
    assert.deepEqual(
      collectMaliciousDeadlineDiagnostics(whitespaceVariant, "synthetic-malicious"),
      [],
      "malicious-registration oracle rejected a whitespace-only variant",
    );
  });

  it("Red G requires independent malicious-registration deadlines", {
    timeout: 30_000,
  }, async () => {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    assert.deepEqual(
      collectMaliciousDeadlineDiagnostics(source, "hr-browser-harness.test.mjs"),
      [],
      "malicious-registration variants do not have independent deadlines",
    );
  });

  it("Red G self-defends sanitizer ordering and five-value mutation", {
    timeout: 150_000,
  }, () => {
    const canonical = canonicalSanitizerOrderingSource();
    assert.deepEqual(collectSanitizerOrderingDiagnostics(canonical, "synthetic-sanitizer"), []);
    assert.deepEqual(
      collectMalformedFixtureCleanupDiagnostics(canonical, "synthetic-fixture-cleanup"),
      [],
      "sanitizer and cleanup canonical contracts are mutually incompatible",
    );
    const tracked =
      "const trackedValues=Object.freeze([ready.root,ready.profile,ready.nonce,ready.wrongNonce,ready.realExecutable]);";
    const exclusion =
      'assert.equal(diagnosticsExcludeTrackedValues(result.stderr,trackedValues),true,"diagnostics exposed protected metadata");';
    const predicates =
      "const diagnosticPredicates=[/exited with SIGKILL/.test(result.stderr),/registration.*nonce|nonce.*registration/i.test(result.stderr),/Browser control record contains a malformed field/.test(result.stderr)];";
    const predicateProof =
      'assert.deepEqual(diagnosticPredicates,[true,true,true],"required diagnostics absent");';
    const proof = canonicalMalformedRuntimeEvidenceSource().split("\n").at(-1);
    const controllerDeclaration = "let controller;";
    const resultStatement = "const result=await controller.finish();";
    const proofDeclaration = "let proof;";
    const targetStateDeclarations =
      'let caseRoot;let caseRootOwned;let claimed;let sentinel;let controller;let controllerAcquisition="not-attempted";let controlOwned;let profileOwned;let proof;';
    const nestedControllerAcquisition =
      'try{controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});controllerAcquisition=controller.phase}catch(error){controllerAcquisition="no-subject";throw error}';
    const controllerAttempt = 'controllerAcquisition="attempting";';
    const outerFinally = "}catch(error){hasPrimaryFailure=true;primaryFailure=error}finally{";
    const setupDeclarations = [
      'const readyPath=join(caseRoot,"ready.json");',
      'const harnessTermMarker=join(caseRoot,"harness-term.txt");',
      'const playwrightPackage=join(repositoryRoot,"scripts/test/browser-tooling/package.json");',
      canonicalMalformedProgramSourceDeclaration(),
    ];
    const scopeEscapedNestedCanonical = canonical.replace(
      "const ready=await waitForFile(readyPath,20_000);",
      "{const ready=await waitForFile(readyPath,20_000);}",
    );
    const trueResultShadowCanonical = canonical.replace(
      outerFinally,
      `${outerFinally}\nconst syntheticShadow=({result})=>result.status;void syntheticShadow;`,
    );
    assert.notEqual(
      trueResultShadowCanonical,
      canonical,
      "true result-shadow fixture was not constructed",
    );
    assert.deepEqual(
      collectSanitizerOrderingDiagnostics(trueResultShadowCanonical, "synthetic-sanitizer"),
      [],
      "a genuine nested result binding was attributed to the runtime result",
    );
    const mutationLoop = [
      "for(const trackedValue of proof.trackedValues){",
      "const injected=`${proof.diagnostics}\\n${trackedValue}`;",
      'assert.equal(diagnosticsExcludeTrackedValues(injected,proof.trackedValues),false,"sanitizer accepted protected metadata");',
      "}",
    ].join("\n");
    const mutations = [
      {
        category: "parse-error",
        source: "const broken =",
      },
      {
        category: "sanitizer-exclusion-binding-invalid",
        source: canonical.replace(
          canonicalSanitizerExclusionHelperSource(),
          "function diagnosticsExcludeTrackedValues(){return true}",
        ),
      },
      {
        category: "sanitizer-target-missing",
        source: canonical.replace(
          "async function runMalformedCancellationIsolationCase({afterFixtureIdentityCapture,beforeControllerAcquisition,fixturePrivateStopRoot,fixtureSignalEvidenceRoot,onCaseRootAcquired,onFixtureAcquired,onFixturesCreated}={}){",
          "async function runMalformedCancellationIsolationCase({afterFixtureIdentityCapture,assert={},beforeControllerAcquisition,fixturePrivateStopRoot,fixtureSignalEvidenceRoot,onCaseRootAcquired,onFixtureAcquired,onFixturesCreated}={}){",
        ),
      },
      {
        category: "sanitizer-target-missing",
        source: canonical.replace(
          "async function runMalformedCancellationIsolationCase({afterFixtureIdentityCapture,beforeControllerAcquisition,fixturePrivateStopRoot,fixtureSignalEvidenceRoot,onCaseRootAcquired,onFixtureAcquired,onFixturesCreated}={}){",
          "async function runMalformedCancellationIsolationCase({afterFixtureIdentityCapture,beforeControllerAcquisition,diagnosticsExcludeTrackedValues=()=>true,fixturePrivateStopRoot,fixtureSignalEvidenceRoot,onCaseRootAcquired,onFixtureAcquired,onFixturesCreated}={}){",
        ),
      },
      {
        category: "sanitizer-five-value-set-missing",
        source: canonical.replace(
          tracked,
          "const trackedValues=[ready.root,ready.profile,ready.nonce,ready.wrongNonce,ready.realExecutable];",
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: scopeEscapedNestedCanonical,
      },
      {
        category: "raw-diagnostics-use",
        source: canonical.replace(
          outerFinally,
          `${outerFinally}\nconst syntheticAlias=({result:alias})=>result.stderr;void syntheticAlias;`,
        ),
      },
      {
        category: "raw-diagnostics-use",
        source: canonical.replace(
          outerFinally,
          `${outerFinally}\nconst syntheticComputed=({[result.stderr]:alias})=>0;void syntheticComputed;`,
        ),
      },
      ...setupDeclarations.map((declaration) => ({
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(declaration, `{${declaration}}`),
      })),
      ...setupDeclarations.map((declaration) => ({
        category: "sanitizer-runtime-subject-provenance",
        source: canonical
          .replace(`${declaration}\n`, "")
          .replace("try{\ncaseRoot=await mkdtemp", `${declaration}\ntry{\ncaseRoot=await mkdtemp`),
      })),
      ...setupDeclarations.map((declaration) => ({
        category: "sanitizer-runtime-subject-provenance",
        source: canonical
          .replace(`${declaration}\n`, "")
          .replace(nestedControllerAcquisition, `${nestedControllerAcquisition}\n${declaration}`),
      })),
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(`${controllerAttempt}\n`, ""),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(controllerAttempt, 'controllerAcquisition="acquired";'),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          `${controllerAttempt}\n${nestedControllerAcquisition}`,
          `${nestedControllerAcquisition}\n${controllerAttempt}`,
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(controllerAttempt, `${controllerAttempt}\n${controllerAttempt}`),
      },
      {
        category: "sanitizer-exclusion-binding-invalid",
        source: canonical.replace(
          nestedControllerAcquisition,
          `${nestedControllerAcquisition}\nconst diagnosticsExcludeTrackedValues=()=>true;`,
        ),
      },
      {
        category: "sanitizer-authority-provenance",
        source: canonical.replace(
          nestedControllerAcquisition,
          `${nestedControllerAcquisition}\nconst assert={equal(){},deepEqual(){},rejects:async()=>{}};`,
        ),
      },
      ...[
        "fixtureSlots.length=0;",
        "cleanupFailures.push=()=>0;",
        "(()=>{for(;;){}})();",
        "process.exit(0);",
        "if(true)return;",
        "await new Promise(()=>{});",
      ].map((interruption) => ({
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          nestedControllerAcquisition,
          `${nestedControllerAcquisition}\n${interruption}`,
        ),
      })),
      ...["throw 0;", "for(;;){}"].map((interruption) => ({
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          [nestedControllerAcquisition, "const ready=await waitForFile(readyPath,20_000);"].join(
            "\n",
          ),
          [
            nestedControllerAcquisition,
            interruption,
            "const ready=await waitForFile(readyPath,20_000);",
          ].join("\n"),
        ),
      })),
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          [nestedControllerAcquisition, "const ready=await waitForFile(readyPath,20_000);"].join(
            "\n",
          ),
          [
            nestedControllerAcquisition,
            "throw 0;",
            "const ready=await waitForFile(readyPath,20_000);",
          ].join("\n"),
        ),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(
          resultStatement,
          `${resultStatement}\nconst exposeRuntimeResult=()=>result.stderr;exposeRuntimeResult();`,
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          "const ready=await waitForFile(readyPath,20_000);",
          'const ready={root:"safe-root",profile:"safe-profile",nonce:"safe-nonce",wrongNonce:"safe-wrong",realExecutable:"safe-executable"};',
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          [nestedControllerAcquisition, canonicalMalformedRuntimeEvidenceSource()].join("\n"),
          [
            "if(false){",
            nestedControllerAcquisition,
            canonicalMalformedRuntimeEvidenceSource(),
            "}",
          ].join("\n"),
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          nestedControllerAcquisition,
          `if(false){${nestedControllerAcquisition}}`,
        ),
      },
      ...["throw 0;", "return;", "for(;;){}"].map((interruption) => ({
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(resultStatement, `${resultStatement}\n${interruption}`),
      })),
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          targetStateDeclarations,
          targetStateDeclarations.replace(controllerDeclaration, `{${controllerDeclaration}}`),
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          targetStateDeclarations,
          targetStateDeclarations.replace(proofDeclaration, `{${proofDeclaration}}`),
        ),
      },
      {
        category: "sanitizer-authority-provenance",
        source: canonical.replace(
          'import assert from "node:assert/strict";',
          'import assert from "node:assert/strict";assert.equal=()=>{};',
        ),
      },
      {
        category: "sanitizer-authority-provenance",
        source:
          canonical +
          '\nimport {strict as hiddenAssert} from "node:assert";hiddenAssert.equal=()=>{};hiddenAssert.deepEqual=()=>{};',
      },
      {
        category: "sanitizer-authority-provenance",
        source:
          canonical +
          '\nimport {Session as HiddenSession} from "node:inspector/promises";void HiddenSession;',
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nArray.prototype.every=()=>true;`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticAssert=assert;syntheticAssert.equal=()=>{};`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nimport hiddenAssert from "assert/strict";hiddenAssert.equal=()=>{};hiddenAssert.deepEqual=()=>{};`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nimport vm from "node:vm";vm.runInThisContext('assert.equal=()=>{};assert.deepEqual=()=>{}');`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticAssert=assert.valueOf();syntheticAssert.equal=()=>{};`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticAssert=assert["valueOf"]();syntheticAssert.equal=()=>{};`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nassert.__defineGetter__("equal",()=>()=>{});`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nassert.__defineSetter__("equal",()=>{});`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nvoid assert.__lookupGetter__("equal");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nvoid assert.__lookupSetter__("equal");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\n;[assert].forEach((syntheticAssert)=>{syntheticAssert.equal=()=>{};syntheticAssert.deepEqual=()=>{}});`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticArrayPrototype=Array.prototype;syntheticArrayPrototype.every=()=>true;`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\n;[].__proto__.every=()=>true;`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticSetPrototype=Set.prototype;syntheticSetPrototype.add=()=>syntheticSetPrototype;`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticStringPrototype=String.prototype;syntheticStringPrototype.includes=()=>false;`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticRegExpPrototype=RegExp.prototype;syntheticRegExpPrototype.test=()=>true;`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticObject=Object;syntheticObject.freeze=(value)=>value;`,
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          canonicalWaitForFileSource(),
          "async function waitForFile(){return {}}",
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(canonicalWaitForPathSource(), "async function waitForPath(){}"),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          canonicalMalformedProgramSourceDeclaration(),
          canonicalMalformedProgramSourceDeclaration().replace(
            "browser.cancelled",
            "browser.counterfeit",
          ),
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          'const readyPath=join(caseRoot,"ready.json");',
          'const readyPath=join(caseRoot,"counterfeit.json");',
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          'const readyPath=join(caseRoot,"ready.json");',
          '{const readyPath=join(caseRoot,"ready.json");}',
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          canonicalMalformedProgramSourceDeclaration(),
          `{${canonicalMalformedProgramSourceDeclaration()}}`,
        ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical
          .replace('const readyPath=join(caseRoot,"ready.json");\n', "")
          .replace(
            nestedControllerAcquisition,
            `${nestedControllerAcquisition}\nconst readyPath=join(caseRoot,"ready.json");`,
          ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical
          .replace(`${canonicalMalformedProgramSourceDeclaration()}\n`, "")
          .replace(
            nestedControllerAcquisition,
            `${nestedControllerAcquisition}\n${canonicalMalformedProgramSourceDeclaration()}`,
          ),
      },
      {
        category: "sanitizer-runtime-subject-provenance",
        source: canonical.replace(
          'controller=spawnOwnedWrapperController(process.execPath,["-e",source],{},{operationTimeoutMs:35_000});',
          "controller={finish:async()=>({stderr:''})};",
        ),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(tracked, `assert.match(result.stderr,/raw/);${tracked}`),
      },
      {
        category: "raw-diagnostics-use",
        source: canonical.replace(tracked, `eval("assert.match(result.stderr,/raw/)");${tracked}`),
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\neval("assert.equal=()=>{};assert.deepEqual=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nglobalThis[JSON.parse('"eval"')]("assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticEvaluator=globalThis[JSON.parse('"eval"')];syntheticEvaluator("assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst {eval:syntheticEvaluator}=globalThis;syntheticEvaluator("assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticHolder={};syntheticHolder.e=globalThis.eval;syntheticHolder.e("assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nlet syntheticEvaluator;({eval:syntheticEvaluator}=globalThis);syntheticEvaluator("assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst {[JSON.parse('"eval"')]:syntheticEvaluator}=globalThis;syntheticEvaluator("assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nlet syntheticEvaluator;({[JSON.parse('"eval"')]:syntheticEvaluator}=globalThis);syntheticEvaluator("assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nlet syntheticEvaluator;[syntheticEvaluator]=[globalThis.eval];syntheticEvaluator("assert.equal=()=>{}");`,
      },
      ...["&&=", "||=", "??="].map((operator) => ({
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nlet syntheticEvaluator;syntheticEvaluator${operator}globalThis.eval;`,
      })),
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticEvaluator=globalThis.eval.call.bind(globalThis.eval);syntheticEvaluator(null,"assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticEvaluator=globalThis.eval.apply.bind(globalThis.eval);syntheticEvaluator(null,["assert.equal=()=>{}"]);`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst local=()=>{};const syntheticEvaluator=local.call.bind(globalThis.eval);syntheticEvaluator(null,"assert.equal=()=>{}");`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nfunction syntheticScope(syntheticEvaluator=eval){var eval=()=>{};syntheticEvaluator("assert.equal=()=>{}")}syntheticScope();`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nfunction syntheticScope(syntheticEvaluator=globalThis.eval){var globalThis={eval(){}};syntheticEvaluator("assert.equal=()=>{}")}syntheticScope();`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nconst syntheticMember=String(Date.now());const {[syntheticMember]:syntheticEvaluator}=globalThis;void syntheticEvaluator;`,
      },
      {
        category: "sanitizer-authority-provenance",
        source: `${canonical}\nsyntheticEvaluator=globalThis.eval;`,
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(tracked, `void result["stderr"];${tracked}`),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(tracked, `void result?.stderr;${tracked}`),
      },
      {
        category: "raw-diagnostics-use",
        source: canonical.replace(tracked, `const rawResult=result;${tracked}`),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(
          tracked,
          `const callback=(value)=>assert.equal(value,"raw");callback(result.stderr);${tracked}`,
        ),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(
          tracked,
          `const callback=(value)=>assert.equal(value,"raw");callback.call(null,result.stderr);${tracked}`,
        ),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(
          tracked,
          `const callback=(value)=>assert.equal(value,"raw");callback.apply(null,[result.stderr]);${tracked}`,
        ),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(
          tracked,
          `const callback=(value)=>assert.equal(value,"raw");Reflect.apply(callback,null,[result.stderr]);${tracked}`,
        ),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(
          tracked,
          `const target={set value(input){assert.equal(input,"raw")}};target.value=result.stderr;${tracked}`,
        ),
      },
      {
        category: "diagnostics-before-exclusion",
        source: canonical.replace(
          tracked,
          `const target={set value(input){assert.equal(input,"raw")}};Object.assign(target,{value:result.stderr});${tracked}`,
        ),
      },
      {
        category: "sanitizer-exclusion-missing",
        source: canonical.replace(
          exclusion,
          "diagnosticsExcludeTrackedValues(result.stderr,trackedValues);",
        ),
      },
      {
        category: "sanitizer-diagnostic-predicates-missing",
        source: canonical.replace(predicates, "const diagnosticPredicates=[true,true,true];"),
      },
      {
        category: "raw-diagnostics-use",
        source: canonical.replace(predicates, `assert.match(result.stderr,/raw/);${predicates}`),
      },
      {
        category: "sanitizer-proof-missing",
        source: canonical.replace(proof, 'proof={diagnostics:"",trackedValues};'),
      },
      {
        category: "sanitizer-proof-return-invalid",
        source: canonical.replace(proof, `${proof}\nreturn proof;`),
      },
      {
        category: "sanitizer-proof-return-invalid",
        source: canonical.replace(
          "if(hasPrimaryFailure)throw primaryFailure;\nreturn proof",
          "if(hasPrimaryFailure)throw primaryFailure;\nthrow 0;\nreturn proof",
        ),
      },
      {
        category: "sanitizer-proof-return-invalid",
        source: canonical.replace("return proof", "if(false){return proof;}"),
      },
      {
        category: "sanitizer-proof-return-invalid",
        source: canonical.replace("return proof", "return {proof}"),
      },
      {
        category: "sanitizer-five-value-mutation-missing",
        source: canonical.replace(
          'false,"sanitizer accepted protected metadata"',
          'true,"sanitizer accepted protected metadata"',
        ),
      },
      {
        category: "sanitizer-five-value-mutation-missing",
        source: canonical.replace(
          mutationLoop,
          "for(const trackedValue of proof.trackedValues){void trackedValue}",
        ),
      },
      {
        category: "sanitizer-five-value-mutation-missing",
        source: canonical.replace("{timeout:150_000}", "{timeout:150_000,skip:true}"),
      },
      {
        category: "sanitizer-five-value-mutation-missing",
        source: canonical.replace(
          'describe("HR browser harness contracts",()=>{',
          'describe("HR browser harness contracts",{skip:true},()=>{',
        ),
      },
      {
        category: "sanitizer-five-value-mutation-missing",
        source: canonical.replace(
          'describe("HR browser harness contracts",()=>{',
          'describe("HR browser harness contracts",()=>{const it=()=>{};',
        ),
      },
      {
        category: "sanitizer-five-value-mutation-missing",
        source: canonical.replace(
          'import {describe,it} from "node:test";',
          'import {it} from "node:test";const describe=()=>{};',
        ),
      },
      {
        category: "sanitizer-five-value-mutation-missing",
        source: canonical
          .replace(
            'describe("HR browser harness contracts",()=>{\n',
            'describe("HR browser harness contracts",()=>{\nif(false){',
          )
          .replace("\n})\n})", "\n})}\n})"),
      },
    ];
    for (const mutation of mutations) {
      assert.notEqual(mutation.source, canonical, "sanitizer mutation was a no-op");
      const findings = collectSanitizerOrderingDiagnostics(mutation.source, "synthetic-sanitizer");
      assert.equal(
        findings.some((entry) => entry.endsWith(`:${mutation.category}`)),
        true,
        "sanitizer oracle accepted a contract mutation",
      );
      assert.equal(
        findings.every((entry) => /^synthetic-sanitizer:[0-9]+:[a-z0-9-]+$/.test(entry)),
        true,
        "sanitizer diagnostics exposed source content",
      );
    }

    const whitespaceVariant = canonical
      .split("\n")
      .map((line, index) => (index % 2 === 0 ? `  ${line}  ` : `\t${line}`))
      .join("\n");
    assert.deepEqual(
      collectSanitizerOrderingDiagnostics(whitespaceVariant, "synthetic-sanitizer"),
      [],
      "sanitizer oracle rejected a whitespace-only variant",
    );

    const behaviorRows = [
      [
        "direct callback",
        (probe, marker) => {
          const callback = probe;
          callback(marker);
        },
        1,
      ],
      [
        "repeated callback",
        (probe, marker) => {
          probe(marker);
          probe(marker);
        },
        2,
      ],
      [
        "callback call",
        (probe, marker) => {
          probe.call(null, marker);
        },
        1,
      ],
      [
        "callback apply",
        (probe, marker) => {
          probe.apply(null, [marker]);
        },
        1,
      ],
      [
        "callback Reflect.apply",
        (probe, marker) => {
          Reflect.apply(probe, null, [marker]);
        },
        1,
      ],
      [
        "array callback",
        (probe, marker) => {
          const callbacks = [];
          callbacks.push(probe);
          callbacks.forEach((callback) => {
            callback(marker);
          });
        },
        1,
      ],
      [
        "direct setter",
        (probe, marker) => {
          const target = {
            set value(input) {
              probe(input);
            },
          };
          target.value = marker;
        },
        1,
      ],
      [
        "Object.assign setter",
        (probe, marker) => {
          const target = {
            set value(input) {
              probe(input);
            },
          };
          Object.assign(target, { value: marker });
        },
        1,
      ],
      [
        "Reflect.set setter",
        (probe, marker) => {
          const target = {
            set value(input) {
              probe(input);
            },
          };
          Reflect.set(target, "value", marker);
        },
        1,
      ],
      [
        "defineProperty bypasses setter",
        (probe, marker) => {
          const target = {
            set value(input) {
              probe(input);
            },
          };
          Object.defineProperty(target, "value", { value: marker });
        },
        0,
      ],
      [
        "stored callback",
        (probe) => {
          const callbacks = [probe];
          void callbacks;
        },
        0,
      ],
      [
        "reset callback array",
        (probe, marker) => {
          let callbacks = [];
          callbacks.push(probe);
          callbacks = [];
          callbacks.forEach((callback) => {
            callback(marker);
          });
        },
        0,
      ],
      [
        "wrong setter member",
        (probe, marker) => {
          const target = {
            set value(input) {
              probe(input);
            },
          };
          Object.assign(target, { other: marker });
        },
        0,
      ],
    ];
    for (const [id, execute, expectedCount] of behaviorRows) {
      const marker = Object.freeze({});
      let observations = 0;
      const probe = (value) => {
        if (value === marker) observations += 1;
      };
      execute(probe, marker);
      assert.equal(observations, expectedCount, `behavior probe classification changed: ${id}`);
      const findings = observations > 0 ? ["behavior-probe:1:behavioral-capability-reached"] : [];
      assert.deepEqual(
        findings,
        expectedCount > 0 ? ["behavior-probe:1:behavioral-capability-reached"] : [],
        `behavior probe diagnostic classification changed: ${id}`,
      );
    }
  });

  it("Red G requires sanitizer exclusion before diagnostic predicates", {
    timeout: 30_000,
  }, async () => {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    assert.deepEqual(
      collectSanitizerOrderingDiagnostics(source, "hr-browser-harness.test.mjs"),
      [],
      "diagnostic predicates precede complete tracked-value exclusion",
    );
  });

  it("Red F proves exact claimed identity survival with a mutation-sensitive oracle", {
    timeout: 150_000,
  }, async () => {
    const proof = await runMalformedCancellationIsolationCase();
    const claimedAssertionSubject = proof.claimedAfter;
    assert.equal(
      sameProcessIdentity(proof.claimedBefore, claimedAssertionSubject),
      true,
      "claimed exact identity did not survive unchanged",
    );
  });

  it("Red F proves actual diagnostics sanitize every tracked value with mutation sensitivity", {
    timeout: 150_000,
  }, async () => {
    const proof = await runMalformedCancellationIsolationCase();
    assert.equal(
      proof.trackedValues.length,
      5,
      "mutation proof did not retain five tracked values",
    );
    assert.equal(
      Object.isFrozen(proof.trackedValues),
      true,
      "mutation proof tracked values are mutable",
    );
    for (const trackedValue of proof.trackedValues) {
      const injected = `${proof.diagnostics}\n${trackedValue}`;
      assert.equal(
        diagnosticsExcludeTrackedValues(injected, proof.trackedValues),
        false,
        "sanitizer accepted protected metadata",
      );
    }
  });

  it("Red F bounds finish after the wrapper exits while an owned fixture retains its pipes", {
    timeout: 150_000,
  }, async () => {
    const beforePostgresRoots = await postgresTemporaryDirectories();
    const beforeBrowserRoots = await browserTemporaryDirectories();
    const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "red-f-retained-pipe-"));
    const caseRootOwned = captureOwnedDirectory(
      await realpath(caseRoot),
      "Red F retained-pipe root",
    );
    const startPath = join(caseRoot, "start");
    const handlerReadyPath = join(caseRoot, "handler-ready.json");
    const orphanReadyPath = join(caseRoot, "orphan-ready.json");
    const stopPath = join(caseRoot, "stop");
    const signalMarkerPath = join(caseRoot, "signal-marker.txt");
    const fixtureSource = [
      'const {existsSync,linkSync,unlinkSync,writeFileSync}=require("node:fs")',
      `const handlerReadyPath=${JSON.stringify(handlerReadyPath)}`,
      `const orphanReadyPath=${JSON.stringify(orphanReadyPath)}`,
      `const stopPath=${JSON.stringify(stopPath)}`,
      `const signalMarkerPath=${JSON.stringify(signalMarkerPath)}`,
      "const originalPpid=process.ppid",
      'const publish=(path,value)=>{const temporary=path+".tmp."+process.pid;writeFileSync(temporary,JSON.stringify(value),{flag:"wx",mode:0o600});linkSync(temporary,path);unlinkSync(temporary)}',
      'for(const signal of ["SIGHUP","SIGINT","SIGTERM"])process.on(signal,()=>{try{writeFileSync(signalMarkerPath,signal+"\\n",{flag:"a",mode:0o600})}catch{}})',
      "publish(handlerReadyPath,{originalPpid,pid:process.pid})",
      "let orphanPublished=false",
      "setInterval(()=>{if(!orphanPublished&&process.ppid!==originalPpid){orphanPublished=true;publish(orphanReadyPath,{currentPpid:process.ppid,originalPpid,pid:process.pid})}if(existsSync(stopPath))process.exit(0)},25)",
    ].join(";");
    const commandSource = [
      'const {existsSync,readFileSync}=require("node:fs")',
      'const {spawn}=require("node:child_process")',
      "const controlRoot=process.env.ESBLA_BROWSER_CONTROL_ROOT",
      "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
      'const retainedPath=controlRoot+"/harness.retained"',
      'const retainedExpected="nonce="+nonce+"\\npid="+process.pid+"\\n"',
      `const startPath=${JSON.stringify(startPath)}`,
      `const handlerReadyPath=${JSON.stringify(handlerReadyPath)}`,
      `const fixtureSource=${JSON.stringify(fixtureSource)}`,
      'let retainedBytes;for(let attempt=0;attempt<800&&retainedBytes===undefined;attempt++){try{retainedBytes=readFileSync(retainedPath,"utf8")}catch(error){if(error?.code!=="ENOENT")throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)}}',
      'if(retainedBytes!==retainedExpected)throw new Error("exact harness retention was not published")',
      "for(let attempt=0;attempt<800&&!existsSync(startPath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",
      'if(!existsSync(startPath))throw new Error("private start was not published")',
      'const fixture=spawn(process.execPath,["-e",fixtureSource],{detached:true,stdio:["ignore",1,2]})',
      "fixture.unref()",
      "for(let attempt=0;attempt<800&&!existsSync(handlerReadyPath);attempt++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)",
      'if(!existsSync(handlerReadyPath))throw new Error("fixture handler readiness was not published")',
      "process.exit(0)",
    ].join(";");
    const controller = spawnSupervisedPostgresWrapper(process.execPath, ["-e", commandSource]);
    const wrapperExitPromise = observeChildExit(controller.child);
    let fixtureIdentity;
    let fixtureExactExitProved = false;
    let fixtureStopPublished = false;
    let finishAttempt;
    let observed;
    let finalResult;
    const cleanupFailures = [];
    const finishControllerAsEnvelope = async () => {
      try {
        const result = await controller.finish();
        return {
          kind: "fulfilled",
          value: { code: result.code, signal: result.signal },
        };
      } catch (error) {
        return { error, kind: "rejected" };
      }
    };
    try {
      await writeFile(startPath, "start\n", { flag: "wx", mode: 0o600 });
      const handlerReady = await waitForFile(handlerReadyPath, 20_000);
      const wrapperExit = await withTimeout(
        "wrapper leader exit",
        () => wrapperExitPromise,
        20_000,
      );
      const orphanReady = await waitForFile(orphanReadyPath, 20_000);
      assert.equal(handlerReady.pid, orphanReady.pid);
      assert.equal(orphanReady.originalPpid, handlerReady.originalPpid);
      assert.notEqual(orphanReady.currentPpid, orphanReady.originalPpid);
      fixtureIdentity = captureStableProcessIdentity(orphanReady.pid);
      assert.equal(fixtureIdentity.pid, fixtureIdentity.pgid);
      captureStableProcessIdentity(fixtureIdentity.pid, fixtureIdentity);
      assert.deepEqual(wrapperExit, { code: 1, signal: null });
      assert.equal(controller.child.exitCode, 1);
      assert.equal(controller.child.signalCode, null);
      assert.equal(controller.settled, false);
      finishAttempt = finishControllerAsEnvelope();
      const absoluteFinishDeadline = controller.absoluteControllerDeadline + 10_000;
      observed = await Promise.race([
        finishAttempt,
        delayUntil(absoluteFinishDeadline).then(() => ({ kind: "deadline" })),
      ]);
      captureStableProcessIdentity(fixtureIdentity.pid, fixtureIdentity);
      assert.equal(
        await pathExists(signalMarkerPath),
        false,
        "pipe-retaining fixture was signaled",
      );
    } finally {
      try {
        await writePrivateStop(stopPath);
        fixtureStopPublished = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (fixtureIdentity) {
        try {
          await waitForExactProcessExit(fixtureIdentity, 10_000);
          fixtureExactExitProved = true;
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (controller) {
        try {
          assert.equal(await controller.outcomeWithin(10_000), true);
          const finishEnvelope = finishAttempt
            ? await withTimeout(
                "Red F retained-pipe finish envelope after exact close",
                () => finishAttempt,
                10_000,
              )
            : await withTimeout(
                "Red F retained-pipe controller finish after exact close",
                finishControllerAsEnvelope,
                10_000,
              );
          const normalizedFinishEnvelope = normalizedBoundedFinishEnvelope(finishEnvelope);
          assert.ok(
            normalizedFinishEnvelope,
            "controller finish escaped its sanitized bounded contract",
          );
          if (normalizedFinishEnvelope.kind === "rejected") {
            const idempotentEnvelope = await withTimeout(
              "Red F retained-pipe idempotent controller finish",
              finishControllerAsEnvelope,
              10_000,
            );
            const normalizedIdempotentEnvelope =
              normalizedBoundedFinishEnvelope(idempotentEnvelope);
            assert.ok(
              normalizedIdempotentEnvelope,
              "idempotent controller finish escaped its sanitized bounded contract",
            );
            if (normalizedIdempotentEnvelope.kind === "rejected") {
              // biome-ignore lint/correctness/noUnsafeFinally: Cleanup proof must surface a repeated exact-close failure.
              throw new Error("idempotent controller finish remained rejected after exact close");
            }
            assert.equal(
              normalizedIdempotentEnvelope.kind,
              "fulfilled",
              "idempotent controller finish returned an invalid envelope",
            );
            finalResult = normalizedIdempotentEnvelope.value;
          } else {
            assert.equal(
              normalizedFinishEnvelope.kind,
              "fulfilled",
              "controller finish returned an invalid envelope",
            );
            finalResult = normalizedFinishEnvelope.value;
          }
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (fixtureStopPublished && fixtureExactExitProved) {
        try {
          assert.equal(
            await pathExists(signalMarkerPath),
            false,
            "pipe-retaining fixture was signaled",
          );
          await cleanupExactOwnedDirectories([caseRootOwned]);
        } catch (error) {
          cleanupFailures.push(error);
        }
      } else {
        cleanupFailures.push(
          new Error(
            "retained-pipe cooperative stop or exact exit was not proved; root cleanup withheld",
          ),
        );
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Red F retained-pipe cleanup was incomplete");
    }
    assert.equal(finalResult?.code, 1);
    assert.equal(finalResult?.signal, null);
    await assertNoOwnedResidue(beforePostgresRoots, beforeBrowserRoots);
    assert.equal(
      isValidBoundedFinishEnvelope(observed) &&
        controller.rescueUsed === false &&
        controller.hardKillUsed === false &&
        controller.controllerErrors.length === 0,
      true,
      "controller finish escaped its bounded sanitized envelope",
    );
  });

  it("Red F structurally rejects blind cleanup and generic signal facades", async () => {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    const diagnostics = collectBlindSignalDiagnostics(
      source,
      "hr-browser-harness.test.mjs",
      "full",
    );
    assert.deepEqual(diagnostics, [], "blind signal paths remain in the test harness");
  });

  it("preserves the ordinary wrapper's inherited process-group behavior", {
    timeout: 45_000,
  }, async () => {
    const before = await postgresTemporaryDirectories();
    const root = await mkdtemp(join(tmpdir(), "esbla-ordinary-group-contract-"));
    const readyPath = join(root, "ready.json");
    const source = [
      'const {spawnSync}=require("node:child_process")',
      'const {writeFileSync}=require("node:fs")',
      'const identity=(pid)=>spawnSync("/bin/ps",["-o","pid=,pgid=","-p",String(pid)],{encoding:"utf8",timeout:1_000}).stdout.trim().split(/\\s+/).map(Number)',
      `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({child:identity(process.pid),parent:identity(process.ppid)}))`,
      "process.exit(0)",
    ].join(";");
    try {
      const wrapper = spawnPostgresWrapper(process.execPath, ["-e", source]);
      const outcome = childOutcome(wrapper);
      const identities = await waitForFile(readyPath);
      const result = await outcome;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(identities.child[1], identities.parent[1]);
      assert.notEqual(identities.child[0], identities.child[1]);
      await assertNoNewPostgresTemporaryDirectories(before);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    it(`forwards ${signal}, drains the complete child group, and preserves signal exit semantics`, {
      timeout: 45_000,
    }, async () => {
      const before = await postgresTemporaryDirectories();
      const root = await mkdtemp(join(tmpdir(), "esbla-signal-contract-"));
      const readyPath = join(root, "ready.json");
      const descendant =
        'process.on("SIGINT",()=>process.exit(0));process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)';
      const source = [
        'const {spawn}=require("node:child_process")',
        'const {writeFileSync}=require("node:fs")',
        `const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{detached:false,stdio:"ignore"})`,
        'process.on("SIGINT",()=>process.exit(0))',
        'process.on("SIGTERM",()=>process.exit(0))',
        `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({leader:process.pid,grandchild:child.pid}))`,
        "setInterval(()=>{},1000)",
      ].join(";");
      let pids;
      let wrapper;
      try {
        wrapper = spawnSupervisedPostgresWrapper(process.execPath, ["-e", source]);
        const outcome = childOutcome(wrapper);
        pids = await waitForFile(readyPath);
        wrapper.signal(signal);
        const result = await outcome;
        assert.equal(result.signal, signal, result.stderr);
        await Promise.all([waitForPidExit(pids.leader), waitForPidExit(pids.grandchild)]);
        await assertNoNewPostgresTemporaryDirectories(before);
      } finally {
        if (wrapper && !wrapper.settled) {
          wrapper.signal("SIGTERM");
          await wrapper.finish(45_000);
        }
        await Promise.all(Object.values(pids ?? {}).map((pid) => waitForPidExit(pid, 10_000)));
        await rm(root, { force: true, recursive: true });
      }
    });
  }

  it("a second signal immediately escalates a resistant child group", {
    timeout: 45_000,
  }, async () => {
    const before = await postgresTemporaryDirectories();
    const beforeBrowserRoots = await browserTemporaryDirectories();
    const realSuiteRoot = await realpath(wrapperTemporaryRoot);
    const root = await mkdtemp(join(realSuiteRoot, "double-signal-contract-"));
    const rootOwned = captureOwnedDirectory(root, "double-signal contract root");
    const readyPath = join(root, "ready.json");
    const stopPath = join(root, "grandchild.stop");
    const resistant = [
      'const {existsSync}=require("node:fs")',
      `const stopPath=${JSON.stringify(stopPath)}`,
      'process.on("SIGINT",()=>{})',
      'process.on("SIGTERM",()=>{})',
      "setInterval(()=>{if(existsSync(stopPath))process.exit(0)},25)",
    ].join(";");
    const source = [
      'const {spawn}=require("node:child_process")',
      'const {existsSync,writeFileSync}=require("node:fs")',
      `const stopPath=${JSON.stringify(stopPath)}`,
      `const child=spawn(process.execPath,["-e",${JSON.stringify(resistant)}],{detached:false,stdio:"ignore"})`,
      'process.on("SIGTERM",()=>{})',
      `writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({leader:process.pid,grandchild:child.pid}))`,
      "setInterval(()=>{if(existsSync(stopPath))process.exit(0)},25)",
    ].join(";");

    let wrapper;
    let leaderIdentity;
    let grandchildIdentity;
    let grandchildExactExitProved = false;
    let leaderExactExitProved = false;
    let unacquiredFixtureAbsenceProved = false;
    let wrapperClosedProved = false;
    let primaryFailure;
    const cleanupFailures = [];

    try {
      wrapper = spawnSupervisedPostgresWrapper(process.execPath, ["-e", source]);
      const outcome = childOutcome(wrapper);
      const pids = await waitForFile(readyPath);
      leaderIdentity = captureStableProcessIdentity(pids.leader);
      grandchildIdentity = captureStableProcessIdentity(pids.grandchild);

      wrapper.signal("SIGTERM");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      wrapper.signal("SIGTERM");

      const result = await outcome;
      assert.equal(result.signal, "SIGTERM", result.stderr);
      await Promise.all([
        waitForExactProcessExit(leaderIdentity, 10_000),
        waitForExactProcessExit(grandchildIdentity, 10_000),
      ]);
      leaderExactExitProved = true;
      grandchildExactExitProved = true;
      await assertNoNewPostgresTemporaryDirectories(before);
    } catch (error) {
      primaryFailure = error;
    } finally {
      try {
        assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);
        await writePrivateStop(stopPath);
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (grandchildIdentity && !grandchildExactExitProved) {
        try {
          await waitForExactProcessExit(grandchildIdentity, 10_000);
          grandchildExactExitProved = true;
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (wrapper) {
        try {
          await wrapper.finish(45_000);
          if (wrapper.identity) await waitForExactProcessExit(wrapper.identity, 10_000);
          wrapperClosedProved = wrapper.settled && wrapper.phase === "finalized";
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (leaderIdentity && !leaderExactExitProved) {
        try {
          await waitForExactProcessExit(leaderIdentity, 10_000);
          leaderExactExitProved = true;
        } catch (error) {
          cleanupFailures.push(error);
        }
      }

      if ((!wrapper || wrapperClosedProved) && !leaderIdentity && !grandchildIdentity) {
        try {
          await assertNoOwnedResidue(before, beforeBrowserRoots);
          unacquiredFixtureAbsenceProved = true;
        } catch (error) {
          cleanupFailures.push(error);
        }
      }

      if (
        ((!wrapper || wrapperClosedProved) && leaderExactExitProved && grandchildExactExitProved) ||
        unacquiredFixtureAbsenceProved
      ) {
        try {
          assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);
          const rootEntries = (await readdir(root)).sort();
          assert.deepEqual(
            rootEntries.filter((entry) => !["grandchild.stop", "ready.json"].includes(entry)),
            [],
          );
          if (rootEntries.includes("ready.json")) {
            assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);
            await rm(readyPath, { force: false, recursive: false });
          }
          if (rootEntries.includes("grandchild.stop")) {
            assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);
            await rm(stopPath, { force: false, recursive: false });
          }
          assert.deepEqual(await readdir(root), []);
          assert.deepEqual(captureOwnedDirectory(root, "double-signal contract root"), rootOwned);
          await rmdir(root);
        } catch (error) {
          cleanupFailures.push(error);
        }
      } else {
        cleanupFailures.push(
          new Error("double-signal fixture absence was not proved; root cleanup withheld"),
        );
      }
    }

    if (primaryFailure && cleanupFailures.length) {
      throw new AggregateError([primaryFailure, ...cleanupFailures]);
    }
    if (primaryFailure) throw primaryFailure;
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    it(`cancels a real BrowserServer launch before registration on ${signal}`, {
      timeout: 90_000,
    }, async () => {
      const beforeBrowserRoots = await browserTemporaryDirectories();
      const beforePostgresRoots = await postgresTemporaryDirectories();
      const caseRoot = await mkdtemp(join(wrapperTemporaryRoot, "pre-ack-browser-"));
      const launchMarker = join(caseRoot, "launch-intent.json");
      const execMarker = join(caseRoot, "browser-exec.json");
      const playwrightPackage = join(repositoryRoot, "scripts/test/browser-tooling/package.json");
      const source = [
        'const {linkSync,unlinkSync,writeFileSync}=require("node:fs")',
        'const {createRequire}=require("node:module")',
        `const requirePlaywright=createRequire(${JSON.stringify(playwrightPackage)})`,
        'const {chromium}=requirePlaywright("@playwright/test")',
        "const root=process.env.ESBLA_BROWSER_CONTROL_ROOT",
        "const nonce=process.env.ESBLA_BROWSER_CONTROL_NONCE",
        'const tmp=root+"/.intent."+process.pid',
        'writeFileSync(tmp,"nonce="+nonce+"\\npid="+process.pid+"\\n",{flag:"wx",mode:0o600})',
        'linkSync(tmp,root+"/browser.intent")',
        "unlinkSync(tmp)",
        `writeFileSync(${JSON.stringify(launchMarker)},JSON.stringify({launched:true}))`,
        "process.env.TMPDIR=process.env.ESBLA_BROWSER_PROFILE_ROOT",
        "process.env.ESBLA_BROWSER_REAL_EXECUTABLE=chromium.executablePath()",
        '(async()=>{const server=await chromium.launchServer({executablePath:process.env.ESBLA_BROWSER_LAUNCHER,handleSIGHUP:false,handleSIGINT:false,handleSIGTERM:false,headless:true,host:"127.0.0.1",port:0});writeFileSync(' +
          JSON.stringify(execMarker) +
          ",JSON.stringify({pid:server.process().pid}));setInterval(()=>{},1000)})()",
      ].join(";");
      let wrapper;
      try {
        wrapper = spawnSupervisedPostgresWrapper(process.execPath, ["-e", source], {
          ESBLA_BROWSER_TEST_PRE_REGISTRATION_DELAY_MS: "800",
        });
        const outcome = childOutcome(wrapper, 90_000);
        await waitForFile(launchMarker, 30_000);
        wrapper.signal(signal);
        const result = await outcome;
        assert.equal(result.signal, signal, result.stderr);
        await assert.rejects(() => access(execMarker), /ENOENT/);
        assert.deepEqual(await browserTemporaryDirectories(), beforeBrowserRoots);
        await assertNoNewPostgresTemporaryDirectories(beforePostgresRoots);
      } finally {
        if (wrapper && !wrapper.settled) {
          wrapper.signal("SIGTERM");
          await wrapper.finish(75_000);
        }
        await rm(caseRoot, { force: true, recursive: true });
      }
    });
  }

  for (const [label, signal, secondSignal] of [
    ["single SIGINT", "SIGINT", false, false],
    ["single SIGTERM", "SIGTERM", false, false],
    ["second-signal escalation", "SIGTERM", true, false],
  ]) {
    it(
      `owns a real detached Chromium group and profile through ${label}`,
      {
        timeout: 90_000,
      },
      async () => await runRealBrowserSignalCase(signal, secondSignal),
    );
  }

  it(
    "owns and drains real Chromium after exact parent-delivered post-ACK harness SIGKILL",
    { timeout: 90_000 },
    runAbruptHarnessCrashCase,
  );
});

describe("malicious registration contracts", () => {
  it("denies malicious registration: malformed", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("malformed");
  });
  it("denies malicious registration: multiply-linked", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("multiply-linked");
  });
  it("denies malicious registration: wrong-nonce", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("wrong-nonce");
  });
  it("denies malicious registration: wrong-nonce-resistant-harness", {
    timeout: 150_000,
  }, async () => {
    await runMaliciousRegistrationCase("wrong-nonce-resistant-harness");
  });
  it("denies malicious registration: wrong-parent", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("wrong-parent");
  });
  it("denies malicious registration: wrong-start", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("wrong-start");
  });
  it("denies malicious registration: wrong-record-uid", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("wrong-record-uid");
  });
  it("denies malicious registration: wrong-pgid", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("wrong-pgid");
  });
  it("denies malicious registration: unrelated-process", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("unrelated-process");
  });
  it("denies malicious registration: leader-gone", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("leader-gone");
  });
  it("denies malicious registration: changed-parent", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("changed-parent");
  });
  it("denies malicious registration: executable-substring", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("executable-substring");
  });
  it("denies malicious registration: wrong-mode", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("wrong-mode");
  });
  it("denies malicious registration: symlink", { timeout: 150_000 }, async () => {
    await runMaliciousRegistrationCase("symlink");
  });
});

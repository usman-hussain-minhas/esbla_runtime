import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === modulePath;
const rawArgs = isMain ? process.argv.slice(2) : [];
const superviseBrowser = rawArgs[0] === "--supervise-browser";
const [command, ...args] = superviseBrowser ? rawArgs.slice(1) : rawArgs;
const childShutdownTimeoutMs = 45_000;
const processGroupGraceMs = 2_000;
const processGroupKillMs = 2_000;
const supportedProcessGroupSignals = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);
const browserControlEnvironmentKeys = Object.freeze([
  "ESBLA_BROWSER_CONTROL_NONCE",
  "ESBLA_BROWSER_CONTROL_ROOT",
  "ESBLA_BROWSER_LAUNCHER",
  "ESBLA_BROWSER_OWNERSHIP_TOKEN",
  "ESBLA_BROWSER_PROFILE_ROOT",
  "ESBLA_BROWSER_SUPERVISOR_PID",
]);

if (isMain && !command) {
  throw new Error("Usage: node scripts/test/with-postgres.mjs <command> [...args]");
}
if (isMain && rawArgs.slice(superviseBrowser ? 1 : 0).includes("--supervise-browser")) {
  throw new Error("--supervise-browser is valid exactly once and only as the leading argument");
}
if (isMain && superviseBrowser && process.platform === "win32") {
  throw new Error("The ephemeral PostgreSQL harness requires POSIX process-group cleanup");
}

let activeChild;
let childShutdownTimer;
let receivedSignal;
let signalFailure;
let browserControl;
let activeBrowserIdentity;
let activeHarnessIdentity;
let activeHarnessExitReceipt;
let browserControlFailure;
const supervisedSensitiveValues = new Set();
const browserOwnershipDescriptor = 9;
const harnessOwnershipDescriptor = 5;

function modeBits(metadata) {
  return metadata.mode & 0o777;
}

export function isSecureControlFileMetadata(snapshot, expectedUid = process.getuid()) {
  return Boolean(
    snapshot?.isFile &&
      !snapshot.isSymbolicLink &&
      snapshot.uid === expectedUid &&
      snapshot.mode === 0o600 &&
      snapshot.nlink === 1,
  );
}

function controlFileSnapshot(metadata) {
  return {
    isFile: metadata.isFile(),
    isSymbolicLink: metadata.isSymbolicLink(),
    mode: modeBits(metadata),
    nlink: metadata.nlink,
    uid: metadata.uid,
  };
}

function exactFilesystemIdentity(metadata) {
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
  };
}

function sameFilesystemIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

export function captureOwnedDirectory(path, label) {
  supervisedSensitiveValues.add(path);
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid()) ||
    Number(metadata.mode & 0o777n) !== 0o700 ||
    realpathSync(path) !== path
  ) {
    throw new Error(`The ${label} directory was not created with exact owned identity`);
  }
  return { ...exactFilesystemIdentity(metadata), label, path };
}

function assertExactOwnedDirectory(owned) {
  const metadata = lstatSync(owned.path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid()) ||
    Number(metadata.mode & 0o777n) !== 0o700 ||
    realpathSync(owned.path) !== owned.path ||
    !sameFilesystemIdentity(owned, exactFilesystemIdentity(metadata))
  ) {
    throw new Error(`The ${owned.label} directory identity is unproved; state was retained`);
  }
}

function captureOwnershipCapability(path, label) {
  supervisedSensitiveValues.add(path);
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid()) ||
    Number(metadata.mode & 0o777n) !== 0o600 ||
    metadata.nlink !== 1n ||
    realpathSync(path) !== path
  ) {
    throw new Error(`The ${label} capability was not created with exact owned identity`);
  }
  return { ...exactFilesystemIdentity(metadata), label, path };
}

export async function cleanupExactOwnedDirectories(ownedDirectories) {
  const failures = [];
  for (const owned of ownedDirectories) {
    if (!owned) continue;
    try {
      assertExactOwnedDirectory(owned);
      await rm(owned.path, { force: false, recursive: true });
    } catch (error) {
      failures.push(
        new Error(`The ${owned.label} directory could not be proved and removed`, { cause: error }),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Owned browser state cleanup is incomplete");
  }
}

function parsePositiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error(`Browser registration ${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Browser registration ${label} exceeds the safe integer range`);
  }
  return parsed;
}

function parseNonnegativeInteger(value, label) {
  if (!/^[0-9]+$/.test(value ?? "")) {
    throw new Error(`Browser registration ${label} must be a nonnegative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Browser registration ${label} exceeds the safe integer range`);
  }
  return parsed;
}

export function parseBrowserRegistration(contents) {
  if (typeof contents !== "string" || contents.length === 0 || contents.length > 16_384) {
    throw new Error("Browser registration must be bounded text");
  }
  const fields = new Map();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Browser registration contains a malformed field");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (fields.has(key)) throw new Error(`Browser registration duplicates ${key}`);
    fields.set(key, value);
  }
  const expectedKeys = [
    "version",
    "nonce",
    "pid",
    "ppid",
    "pgid",
    "session",
    "uid",
    "start",
    "parent_start",
    "fd3",
    "fd4",
    "fd9",
    "real",
  ];
  if (fields.size !== expectedKeys.length || expectedKeys.some((key) => !fields.has(key))) {
    throw new Error("Browser registration does not have the exact schema");
  }
  if (fields.get("version") !== "2") throw new Error("Unsupported browser registration version");
  return {
    fd3: fields.get("fd3"),
    fd4: fields.get("fd4"),
    fd9: fields.get("fd9"),
    nonce: fields.get("nonce"),
    parentStart: fields.get("parent_start"),
    pgid: parsePositiveInteger(fields.get("pgid"), "pgid"),
    pid: parsePositiveInteger(fields.get("pid"), "pid"),
    ppid: parsePositiveInteger(fields.get("ppid"), "ppid"),
    realExecutable: fields.get("real"),
    session: parseNonnegativeInteger(fields.get("session"), "session"),
    start: fields.get("start"),
    uid: parseNonnegativeInteger(fields.get("uid"), "uid"),
  };
}

function readProcessIdentity(pid) {
  const result = spawnSync(
    "ps",
    ["-ww", "-o", "pid=,ppid=,pgid=,sess=,uid=,lstart=,command=", "-p", String(pid)],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.error) throw new Error(`Unable to inspect process ${pid}: ${result.error.message}`);
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length < 11) throw new Error(`Process ${pid} identity is ambiguous`);
  const numeric = parts.slice(0, 5).map((value) => Number(value));
  if (numeric.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Process ${pid} identity has invalid numeric fields`);
  }
  const start = parts.slice(5, 10).join(" ");
  const startedAt = Date.parse(start);
  if (!Number.isFinite(startedAt)) throw new Error(`Process ${pid} start time is ambiguous`);
  return {
    command: parts.slice(10).join(" "),
    pgid: numeric[2],
    pid: numeric[0],
    ppid: numeric[1],
    session: numeric[3],
    start,
    startedAt,
    uid: numeric[4],
  };
}

function readProcessDescriptorIdentity(pid, descriptor) {
  if (process.platform === "linux") {
    try {
      return exactFilesystemIdentity(statSync(`/proc/${pid}/fd/${descriptor}`, { bigint: true }));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw new Error("Unable to inspect retained Linux process capability", { cause: error });
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync(
      "/usr/sbin/lsof",
      ["-a", "-n", "-P", "-p", String(pid), "-d", String(descriptor), "-F", "fDint"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.error) {
      throw new Error("Unable to inspect retained Darwin process capability", {
        cause: result.error,
      });
    }
    if (result.status === 1 && !result.stdout.trim()) return undefined;
    if (result.status !== 0) throw new Error("Retained Darwin process capability is ambiguous");
    const fields = new Map(
      result.stdout
        .trim()
        .split("\n")
        .filter((line) => /^[fDit]/.test(line))
        .map((line) => [line[0], line.slice(1)]),
    );
    if (fields.get("f") !== String(descriptor)) {
      throw new Error("Retained Darwin process capability metadata is ambiguous");
    }
    if (
      fields.size === 4 &&
      /^[A-Z0-9]+$/.test(fields.get("t") ?? "") &&
      /^0x[0-9a-f]+$/i.test(fields.get("D") ?? "") &&
      /^[0-9]+$/.test(fields.get("i") ?? "")
    ) {
      return {
        dev: BigInt(fields.get("D")).toString(),
        ino: BigInt(fields.get("i")).toString(),
      };
    }
    if (fields.size === 2 && fields.get("t") === "unix") {
      const humanResult = spawnSync(
        "/usr/sbin/lsof",
        ["-a", "-n", "-P", "-p", String(pid), "-d", String(descriptor)],
        { encoding: "utf8", timeout: 5_000 },
      );
      if (humanResult.error || humanResult.status !== 0) {
        throw new Error("Unable to inspect retained Darwin socket capability", {
          cause: humanResult.error,
        });
      }
      const lines = humanResult.stdout.trim().split("\n");
      const values = lines.length === 2 ? lines[1].trim().split(/\s+/) : [];
      if (
        values.length < 8 ||
        values[1] !== String(pid) ||
        !new RegExp(`^${descriptor}[rwu]$`).test(values[3]) ||
        values[4] !== "unix" ||
        !/^0x[0-9a-f]+$/i.test(values[5])
      ) {
        throw new Error("Retained Darwin socket capability metadata is ambiguous");
      }
      return { dev: `unix:${values[5].toLowerCase()}`, ino: "socket" };
    }
    throw new Error("Retained Darwin process capability metadata is ambiguous");
  }
  throw new Error("Stable retained-process capabilities are unsupported on this platform");
}

function processOwnsExactDescriptor(pid, descriptor, expected) {
  return sameFilesystemIdentity(readProcessDescriptorIdentity(pid, descriptor), expected);
}

function ownsRetainedBrowserOwnership(identity) {
  return Boolean(
    identity?.ownership &&
      processOwnsExactDescriptor(identity.pid, browserOwnershipDescriptor, identity.ownership),
  );
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
      left.start === right.start,
  );
}

function sameOwnedProcessIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      Number.isSafeInteger(left.ppid) &&
      left.ppid > 0 &&
      left.pid === right.pid &&
      left.ppid === right.ppid &&
      left.pgid === right.pgid &&
      left.session === right.session &&
      left.uid === right.uid &&
      left.start === right.start,
  );
}

export function isExactHarnessExitReceipt(receipt, child, identity) {
  return Boolean(
    receipt &&
      child &&
      identity &&
      receipt.child === child &&
      receipt.identity === identity &&
      child.pid === identity.pid &&
      (receipt.code !== null || receipt.signal !== null) &&
      receipt.code === child.exitCode &&
      receipt.signal === child.signalCode,
  );
}

function exactHarnessExitWasObserved(expectedBrowserIdentity) {
  return Boolean(
    expectedBrowserIdentity?.ppid === activeHarnessIdentity?.pid &&
      isExactHarnessExitReceipt(activeHarnessExitReceipt, activeChild, activeHarnessIdentity),
  );
}

function sameRetainedBrowserIdentity(expected, live, allowParentDrift = false) {
  return Boolean(
    expected &&
      live &&
      Number.isSafeInteger(expected.ppid) &&
      expected.ppid > 0 &&
      Number.isSafeInteger(live.ppid) &&
      live.ppid > 0 &&
      expected.pid === expected.pgid &&
      expected.pid === live.pid &&
      expected.pgid === live.pgid &&
      expected.session === live.session &&
      expected.uid === live.uid &&
      expected.start === live.start &&
      (expected.ppid === live.ppid || allowParentDrift),
  );
}

export function classifyRetainedLeader(expected, live, groupExists, allowParentDrift = false) {
  if (!live) return groupExists ? "ambiguous" : "absent";
  return sameRetainedBrowserIdentity(expected, live, allowParentDrift) ? "owned" : "changed";
}

export function commandUsesExactExecutable(command, executable) {
  return command === executable || command.startsWith(`${executable} `);
}

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

function assertControlMetadata(control) {
  const rootMetadata = lstatSync(control.root);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== process.getuid() ||
    modeBits(rootMetadata) !== 0o700 ||
    realpathSync(control.root) !== control.root
  ) {
    throw new Error("Browser control root identity or permissions changed");
  }
  const registrationMetadata = lstatSync(control.registrationPath);
  if (!isSecureControlFileMetadata(controlFileSnapshot(registrationMetadata))) {
    throw new Error("Browser registration identity or permissions are invalid");
  }
}

function commandUsesExactShim(command, shimPath) {
  return (
    command === shimPath ||
    command.startsWith(`${shimPath} `) ||
    command === `/bin/sh ${shimPath}` ||
    command.startsWith(`/bin/sh ${shimPath} `)
  );
}

function commandUsesRetainedBrowser(identity, control) {
  return commandUsesExactShim(identity.command, control.launcherPath);
}

function validateBrowserRegistration(control, harnessIdentity) {
  const firstHarnessIdentity = readProcessIdentity(harnessIdentity.pid);
  const secondHarnessIdentity = readProcessIdentity(harnessIdentity.pid);
  if (
    !sameProcessIdentity(firstHarnessIdentity, secondHarnessIdentity) ||
    !sameOwnedProcessIdentity(harnessIdentity, firstHarnessIdentity) ||
    !processOwnsExactDescriptor(
      harnessIdentity.pid,
      harnessOwnershipDescriptor,
      harnessIdentity.ownership,
    )
  ) {
    throw new Error("Browser registration parent identity is no longer retained");
  }
  assertControlMetadata(control);
  const record = parseBrowserRegistration(readFileSync(control.registrationPath, "utf8"));
  if (record.nonce !== control.nonce) throw new Error("Browser registration nonce mismatch");
  if (record.pid !== record.pgid) throw new Error("Browser registration must have PID equal PGID");
  if (record.uid !== process.getuid()) throw new Error("Browser registration UID mismatch");
  if (record.ppid !== harnessIdentity.pid || record.parentStart !== harnessIdentity.start) {
    throw new Error("Browser registration parent identity mismatch");
  }
  if (record.fd3 !== "open" || record.fd4 !== "open" || record.fd9 !== "open") {
    throw new Error("Browser registration did not preserve its required file descriptors");
  }
  if (
    !isAbsolute(record.realExecutable) ||
    /[\r\n]/.test(record.realExecutable) ||
    record.realExecutable !== control.expectedRealExecutable
  ) {
    throw new Error("Browser registration real executable is invalid");
  }
  const realMetadata = statSync(record.realExecutable);
  if (
    !realMetadata.isFile() ||
    realMetadata.uid !== process.getuid() ||
    realpathSync(record.realExecutable) !== record.realExecutable
  ) {
    throw new Error("Browser registration real executable is not canonical");
  }
  accessSync(record.realExecutable, fsConstants.X_OK);
  const firstIdentity = readProcessIdentity(record.pid);
  const secondIdentity = readProcessIdentity(record.pid);
  if (!sameProcessIdentity(firstIdentity, secondIdentity)) {
    throw new Error("Browser process identity changed during registration validation");
  }
  if (
    firstIdentity.pid !== record.pid ||
    firstIdentity.ppid !== record.ppid ||
    firstIdentity.pgid !== record.pgid ||
    firstIdentity.session !== record.session ||
    firstIdentity.uid !== record.uid ||
    firstIdentity.start !== record.start
  ) {
    throw new Error("Browser registration does not match the live process identity");
  }
  if (!commandUsesExactShim(firstIdentity.command, control.launcherPath)) {
    throw new Error("Browser registration is not waiting in the exact launcher shim");
  }
  if (firstIdentity.command.includes(record.realExecutable)) {
    throw new Error("Browser real executable appeared in the pre-ACK argv");
  }
  if (firstIdentity.startedAt + 1_000 < control.createdAt) {
    throw new Error("Browser registration predates the owned control root");
  }
  if (lstatIfExists(control.browserOwnershipPath)) {
    throw new Error("Browser ownership capability was not consumed before registration");
  }
  if (
    !processOwnsExactDescriptor(
      firstIdentity.pid,
      browserOwnershipDescriptor,
      control.browserOwnership,
    )
  ) {
    throw new Error("Browser process does not possess the exact ownership capability");
  }
  const playwrightDescriptors = {
    fd3: readProcessDescriptorIdentity(firstIdentity.pid, 3),
    fd4: readProcessDescriptorIdentity(firstIdentity.pid, 4),
  };
  if (!playwrightDescriptors.fd3 || !playwrightDescriptors.fd4) {
    throw new Error("Browser process does not possess the exact Playwright pipe capabilities");
  }
  return {
    ...firstIdentity,
    ownership: control.browserOwnership,
    realExecutable: record.realExecutable,
  };
}

function renderBrowserLauncherShim(preRegistrationDelayMs = 0) {
  return `#!/bin/sh
set -eu
umask 077
export LC_ALL=C
root=\${ESBLA_BROWSER_CONTROL_ROOT:?}
nonce=\${ESBLA_BROWSER_CONTROL_NONCE:?}
ownership=\${ESBLA_BROWSER_OWNERSHIP_TOKEN:?}
supervisor=\${ESBLA_BROWSER_SUPERVISOR_PID:?}
real=\${ESBLA_BROWSER_REAL_EXECUTABLE:?}
for value in "$root" "$nonce" "$ownership" "$supervisor" "$real"; do
  [ "$value" = "$(printf '%s' "$value" | tr -d '\\r\\n')" ] || exit 70
done
case "$nonce" in *[!0-9a-f]*|'') exit 70;; esac
case "$supervisor" in *[!0-9]*|'') exit 70;; esac
case "$ownership" in "$root"/*) ;; *) exit 70;; esac
case "$real" in /*) ;; *) exit 70;; esac
pid=$$
ppid=$(ps -o ppid= -p "$pid" | tr -d ' ')
intent="$root/browser.intent"
cancelled="$root/browser.cancelled"
[ -f "$intent" ] || exit 70
[ "$(ls -ldn "$intent" | awk '{print $1}')" = "-rw-------" ] || exit 70
[ "$(ls -ldn "$intent" | awk '{print $3}')" = "$(id -u)" ] || exit 70
[ "$(sed -n '1s/^nonce=//p' "$intent")" = "$nonce" ] || exit 70
[ "$(sed -n '2s/^pid=//p' "$intent")" = "$ppid" ] || exit 70
[ ! -e "$cancelled" ] || exit 70
delay_ms=${preRegistrationDelayMs}
if [ "$delay_ms" -gt 0 ]; then
  sleep "0.$(printf '%03d' "$delay_ms")"
fi
[ ! -e "$cancelled" ] || exit 70
pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
session=$(ps -o sess= -p "$pid" | tr -d ' ')
uid=$(id -u)
start_raw=$(ps -o lstart= -p "$pid")
start=$(printf '%s\n' "$start_raw" | sed 's/^ *//;s/ *$//')
parent_start=$(ps -o lstart= -p "$ppid" | sed 's/^ *//;s/ *$//')
[ "$pid" = "$pgid" ] || exit 71
kill -0 "$supervisor" 2>/dev/null || exit 72
kill -0 "$ppid" 2>/dev/null || exit 72
exec 9<"$ownership" || exit 72
trap ':' INT TERM
set +e
rm -f "$ownership" 9<&- || exit 72
fd3=closed
fd4=closed
fd9=closed
[ -e /dev/fd/3 ] && fd3=open
[ -e /dev/fd/4 ] && fd4=open
[ -e /dev/fd/9 ] && fd9=open
tmp="$root/.registration.$pid"
registry="$root/browser.registration"
ack="$root/browser.ack"
capture_path="$root/.anchor-probe.$pid"
pipes_closed=0
close_anchor_pipes() {
  if [ "$pipes_closed" -eq 0 ]; then
    exec 3>&- 4>&-
    pipes_closed=1
  fi
}
hold_anchor() {
  trap '' INT TERM
  close_anchor_pipes
  while :; do
    sleep 3600 9<&- || :
  done
}
capture_one_line() {
  rm -f "$capture_path" 9<&- || return 1
  "$@" > "$capture_path" 9<&-
  capture_status=$?
  if [ "$capture_status" -ne 0 ]; then
    rm -f "$capture_path" 9<&-
    return 1
  fi
  IFS= read -r captured_line < "$capture_path"
  capture_status=$?
  rm -f "$capture_path" 9<&- || return 1
  [ "$capture_status" -eq 0 ]
}
secure_control_file() {
  control_path=$1
  control_publication_transition=\${2:-no}
  capture_one_line ls -ldn "$control_path" || return 1
  set -- $captured_line
  [ "$#" -ge 3 ] || return 1
  [ "$1" = "-rw-------" ] || return 1
  validated_control_link_count=$2
  if [ "$validated_control_link_count" -ne 1 ]; then
    [ "$control_publication_transition" = "allow-exact-second-link" ] || return 1
    [ "$validated_control_link_count" -eq 2 ] || return 1
  fi
  [ "$3" -eq "$uid" ] || return 1
}
validate_nonce_record() {
  record_path=$1
  record_expected_pid=$2
  record_publication_transition=\${3:-no}
  secure_control_file "$record_path" "$record_publication_transition" || return 1
  record_link_count=$validated_control_link_count
  record_count=0
  record_nonce=
  record_pid=
  record_nonce_seen=0
  record_pid_seen=0
  while IFS='=' read -r record_key record_value; do
    record_count=$((record_count + 1))
    case "$record_key" in
      nonce)
        [ "$record_nonce_seen" -eq 0 ] || return 1
        record_nonce_seen=1
        record_nonce=$record_value
        ;;
      pid)
        [ -n "$record_expected_pid" ] || return 1
        [ "$record_pid_seen" -eq 0 ] || return 1
        record_pid_seen=1
        record_pid=$record_value
        ;;
      *) return 1 ;;
    esac
  done < "$record_path"
  [ "$record_nonce_seen" -eq 1 ] || return 1
  [ "$record_nonce" = "$nonce" ] || return 1
  if [ -n "$record_expected_pid" ]; then
    [ "$record_count" -eq 2 ] || return 1
    [ "$record_pid_seen" -eq 1 ] || return 1
    [ "$record_pid" = "$record_expected_pid" ] || return 1
  else
    [ "$record_count" -eq 1 ] || return 1
  fi
}
(
  set -C
  : > "$tmp"
) 9<&- 2>/dev/null || exit 73
chmod 600 "$tmp" 9<&- || exit 73
{
  printf 'version=2\nnonce=%s\npid=%s\nppid=%s\npgid=%s\nsession=%s\nuid=%s\n' "$nonce" "$pid" "$ppid" "$pgid" "$session" "$uid"
  printf 'start=%s\nparent_start=%s\nfd3=%s\nfd4=%s\nfd9=%s\nreal=%s\n' "$start" "$parent_start" "$fd3" "$fd4" "$fd9" "$real"
} > "$tmp"
ln "$tmp" "$registry" 9<&- 2>/dev/null || {
  rm -f "$tmp" 9<&-
  exit 73
}
rm -f "$tmp" 9<&- || exit 73
attempt=0
while :; do
  if [ -e "$cancelled" ]; then
    validate_nonce_record "$cancelled" "" || hold_anchor
    hold_anchor
  fi
  if [ -e "$ack" ] || [ -L "$ack" ]; then
    validate_nonce_record "$ack" "$pid" "allow-exact-second-link" || exit 76
    if [ "$record_link_count" -eq 1 ]; then
      break
    fi
    [ "$record_link_count" -eq 2 ] || exit 76
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -le 1800 ] || exit 74
  sleep 0.025 9<&- || :
done
validate_nonce_record "$ack" "$pid" || exit 76
kill -0 "$supervisor" 9<&- 2>/dev/null || exit 72
capture_one_line ps -o ppid= -p "$pid" || hold_anchor
current_ppid=$captured_line
capture_one_line ps -o pgid= -p "$pid" || hold_anchor
current_pgid=$captured_line
capture_one_line ps -o lstart= -p "$pid" || hold_anchor
current_start_raw=$captured_line
[ "$current_pgid" -eq "$pgid" ] || exit 75
[ "$current_start_raw" = "$start_raw" ] || exit 75
if [ "$current_ppid" -ne "$ppid" ]; then
  hold_anchor
fi
kill -0 "$ppid" 9<&- 2>/dev/null || hold_anchor
if [ -e "$cancelled" ]; then
  validate_nonce_record "$cancelled" "" || hold_anchor
  hold_anchor
fi
validate_nonce_record "$ack" "$pid" || exit 76
unset ESBLA_BROWSER_CONTROL_NONCE ESBLA_BROWSER_CONTROL_ROOT ESBLA_BROWSER_LAUNCHER
unset ESBLA_BROWSER_OWNERSHIP_TOKEN ESBLA_BROWSER_PROFILE_ROOT ESBLA_BROWSER_SUPERVISOR_PID
unset ESBLA_BROWSER_REAL_EXECUTABLE
"$real" "$@" 9<&- &
browser_pid=$!
trap '' INT TERM
close_anchor_pipes
wait "$browser_pid"
browser_status=$?
if [ -e "$cancelled" ]; then
  validate_nonce_record "$cancelled" "" || hold_anchor
  hold_anchor
fi
capture_one_line ps -o ppid= -p "$pid" || hold_anchor
current_ppid=$captured_line
if [ "$current_ppid" -ne "$ppid" ]; then
  hold_anchor
fi
exit "$browser_status"
`;
}

export function renderBrowserLauncherShimForTest() {
  return renderBrowserLauncherShim(0);
}

async function createBrowserControl() {
  let browserOwnership;
  let browserOwnershipHandle;
  let browserOwnershipPath;
  let harnessOwnership;
  let harnessOwnershipHandle;
  let harnessOwnershipPath;
  let profileOwned;
  let profileRoot;
  let rootOwned;
  let root;
  try {
    root = await mkdtemp(join(tmpdir(), "esbla-browser-control-"));
    supervisedSensitiveValues.add(root);
    chmodSync(root, 0o700);
    root = realpathSync(root);
    rootOwned = captureOwnedDirectory(root, "browser control root");
    profileRoot = await mkdtemp(join(tmpdir(), "esbla-browser-profile-"));
    supervisedSensitiveValues.add(profileRoot);
    chmodSync(profileRoot, 0o700);
    profileRoot = realpathSync(profileRoot);
    profileOwned = captureOwnedDirectory(profileRoot, "browser profile root");
    browserOwnershipPath = join(root, "browser.ownership");
    harnessOwnershipPath = join(root, "harness.ownership");
    await writeFile(browserOwnershipPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    await writeFile(harnessOwnershipPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    browserOwnership = captureOwnershipCapability(browserOwnershipPath, "browser ownership");
    harnessOwnership = captureOwnershipCapability(harnessOwnershipPath, "harness ownership");
    browserOwnershipHandle = openSync(browserOwnershipPath, "r");
    harnessOwnershipHandle = openSync(harnessOwnershipPath, "r");
    if (
      !sameFilesystemIdentity(
        browserOwnership,
        exactFilesystemIdentity(fstatSync(browserOwnershipHandle, { bigint: true })),
      ) ||
      !sameFilesystemIdentity(
        harnessOwnership,
        exactFilesystemIdentity(fstatSync(harnessOwnershipHandle, { bigint: true })),
      )
    ) {
      throw new Error("Browser ownership capability identity changed while opening");
    }
    const delayValue = process.env.ESBLA_BROWSER_TEST_PRE_REGISTRATION_DELAY_MS ?? "0";
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(delayValue)) {
      throw new Error("Browser pre-registration test delay must be between 0 and 999 ms");
    }
    const launcherPath = join(root, "browser-launcher.sh");
    await writeFile(launcherPath, renderBrowserLauncherShim(Number(delayValue)), {
      mode: 0o700,
      flag: "wx",
    });
    chmodSync(launcherPath, 0o700);
    const playwrightRequire = createRequire(
      join(repositoryRoot, "scripts/test/browser-tooling/package.json"),
    );
    const { chromium } = playwrightRequire("@playwright/test");
    const expectedRealExecutable = realpathSync(chromium.executablePath());
    accessSync(expectedRealExecutable, fsConstants.X_OK);
    const metadata = lstatSync(root);
    const nonce = randomBytes(32).toString("hex");
    for (const value of [
      nonce,
      root,
      profileRoot,
      browserOwnershipPath,
      harnessOwnershipPath,
      join(root, "harness.retained"),
      launcherPath,
      join(root, "browser.ack"),
      join(root, "browser.cancelled"),
      join(root, "browser.intent"),
      join(root, "browser.registration"),
      expectedRealExecutable,
    ]) {
      supervisedSensitiveValues.add(value);
    }
    return {
      ackPath: join(root, "browser.ack"),
      browserOwnership,
      browserOwnershipHandle,
      browserOwnershipPath,
      cancellationPath: join(root, "browser.cancelled"),
      createdAt: metadata.birthtimeMs || metadata.ctimeMs,
      expectedRealExecutable,
      harnessOwnership,
      harnessOwnershipHandle,
      harnessOwnershipPath,
      harnessRetentionPath: join(root, "harness.retained"),
      intentPath: join(root, "browser.intent"),
      launcherPath,
      nonce,
      profileRoot,
      profileOwned,
      registrationPath: join(root, "browser.registration"),
      root,
      rootOwned,
    };
  } catch (error) {
    const closeErrors = [];
    for (const descriptor of [harnessOwnershipHandle, browserOwnershipHandle]) {
      if (descriptor === undefined) continue;
      try {
        closeSync(descriptor);
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    try {
      await cleanupExactOwnedDirectories([profileOwned, rootOwned]);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, ...closeErrors, cleanupError],
        "Browser control setup failed and owned-state cleanup is incomplete",
      );
    }
    if (closeErrors.length > 0) {
      throw new AggregateError(
        [error, ...closeErrors],
        "Browser control setup failed and capability cleanup is incomplete",
      );
    }
    throw error;
  }
}

function browserControlEnvironment(control) {
  return {
    ESBLA_BROWSER_CONTROL_NONCE: control.nonce,
    ESBLA_BROWSER_CONTROL_ROOT: control.root,
    ESBLA_BROWSER_LAUNCHER: control.launcherPath,
    ESBLA_BROWSER_OWNERSHIP_TOKEN: control.browserOwnershipPath,
    ESBLA_BROWSER_PROFILE_ROOT: control.profileRoot,
    ESBLA_BROWSER_SUPERVISOR_PID: String(process.pid),
  };
}

function withoutBrowserControlEnvironment(environment) {
  const output = { ...environment };
  for (const key of [...browserControlEnvironmentKeys, "ESBLA_BROWSER_REAL_EXECUTABLE"]) {
    delete output[key];
  }
  delete output.ESBLA_BROWSER_TEST_PRE_REGISTRATION_DELAY_MS;
  return output;
}

function validateBrowserIntent(control, harnessIdentity) {
  const metadata = lstatSync(control.intentPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    modeBits(metadata) !== 0o600 ||
    metadata.nlink !== 1
  ) {
    throw new Error("Browser launch intent identity or permissions are invalid");
  }
  const fields = parseControlFields(readFileSync(control.intentPath, "utf8"));
  if (
    fields.size !== 2 ||
    fields.get("nonce") !== control.nonce ||
    fields.get("pid") !== String(harnessIdentity.pid)
  ) {
    throw new Error("Browser launch intent does not bind the retained harness");
  }
}

function parseControlFields(contents) {
  const fields = new Map();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Browser control record contains a malformed field");
    const key = line.slice(0, separator);
    if (fields.has(key)) throw new Error("Browser control record duplicates a field");
    fields.set(key, line.slice(separator + 1));
  }
  return fields;
}

function publishBrowserCancellation() {
  if (!browserControl) return;
  try {
    writeFileSync(browserControl.cancellationPath, `nonce=${browserControl.nonce}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const metadata = lstatSync(browserControl.cancellationPath);
    const fields = parseControlFields(readFileSync(browserControl.cancellationPath, "utf8"));
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() ||
      modeBits(metadata) !== 0o600 ||
      metadata.nlink !== 1 ||
      fields.size !== 1 ||
      fields.get("nonce") !== browserControl.nonce
    ) {
      throw new Error("Browser cancellation record is invalid");
    }
  }
}

function exactUnregisteredShimProcesses(control) {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,uid=,command="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Unable to perform the defensive browser-launcher absence scan");
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => commandUsesExactShim(parts.slice(3).join(" "), control.launcherPath));
}

function publishBrowserAck(control, identity) {
  if (receivedSignal || lstatIfExists(control.cancellationPath)) {
    throw new Error("Browser execution was cancelled before ACK");
  }
  const temporaryPath = join(control.root, `.ack.${process.pid}.${randomBytes(8).toString("hex")}`);
  writeFileSync(temporaryPath, `nonce=${control.nonce}\npid=${identity.pid}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    linkSync(temporaryPath, control.ackPath);
  } finally {
    unlinkSync(temporaryPath);
  }
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function retainRegistrationWithoutAck() {
  if (!superviseBrowser || !browserControl || activeBrowserIdentity || !activeHarnessIdentity)
    return;
  try {
    lstatSync(browserControl.registrationPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  activeBrowserIdentity = validateBrowserRegistration(browserControl, activeHarnessIdentity);
}

async function monitorBrowserRegistration(child) {
  let childExitObservedAt;
  let cancellationPublishedAt;
  let intentPublicationObservedAt;
  let intentObserved = false;
  let registrationObservedAt;
  while (true) {
    if (!intentObserved) {
      const intentMetadata = lstatIfExists(browserControl.intentPath);
      if (intentMetadata) {
        intentPublicationObservedAt ??= Date.now();
        if (intentMetadata.nlink !== 1 && Date.now() - intentPublicationObservedAt < 1_000) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
          continue;
        }
        validateBrowserIntent(browserControl, activeHarnessIdentity);
        intentObserved = true;
      }
    }
    try {
      const registrationMetadata = lstatSync(browserControl.registrationPath);
      registrationObservedAt ??= Date.now();
      if (registrationMetadata.nlink !== 1 && Date.now() - registrationObservedAt < 1_000) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        continue;
      }
      const identity = validateBrowserRegistration(browserControl, activeHarnessIdentity);
      activeBrowserIdentity = identity;
      if (receivedSignal || cancellationPublishedAt) return identity;
      publishBrowserAck(browserControl, identity);
      return identity;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      childExitObservedAt ??= Date.now();
      if (intentObserved) {
        if (!cancellationPublishedAt) {
          publishBrowserCancellation();
          cancellationPublishedAt = Date.now();
        }
        if (Date.now() - cancellationPublishedAt >= 2_000) {
          if (exactUnregisteredShimProcesses(browserControl).length > 0) {
            throw new Error("An unregistered browser launcher survived cancellation");
          }
          return undefined;
        }
      } else if (Date.now() - childExitObservedAt >= 500) {
        if (exactUnregisteredShimProcesses(browserControl).length > 0) {
          throw new Error("An unregistered browser launcher survived cancellation");
        }
        return undefined;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function cleanupBrowserRoots() {
  if (!superviseBrowser || !browserControl) return;
  if (browserControlFailure) {
    throw new Error("Browser control state was retained because cleanup is unproved", {
      cause: browserControlFailure,
    });
  }
  if (!activeBrowserIdentity) retainRegistrationWithoutAck();
  if (activeBrowserIdentity && processGroupExists(activeBrowserIdentity.pgid)) {
    throw new Error("Browser process-group absence is unproved; owned state was retained");
  }
  const closeFailures = [];
  for (const key of ["harnessOwnershipHandle", "browserOwnershipHandle"]) {
    const descriptor = browserControl[key];
    if (descriptor === undefined) continue;
    try {
      closeSync(descriptor);
      browserControl[key] = undefined;
    } catch (error) {
      closeFailures.push(error);
    }
  }
  if (closeFailures.length > 0) {
    throw new AggregateError(closeFailures, "Browser ownership capability cleanup is incomplete");
  }
  if (activeBrowserIdentity && processGroupExists(activeBrowserIdentity.pgid)) {
    throw new Error(
      "Browser process-group absence changed after capability release; owned state was retained",
    );
  }
  await cleanupExactOwnedDirectories([browserControl.profileOwned, browserControl.rootOwned]);
}

function sanitizeSupervisedFailure(error) {
  const messages = [];
  const seen = new Set();
  const collect = (candidate) => {
    if (candidate && typeof candidate === "object") {
      if (seen.has(candidate)) return;
      seen.add(candidate);
    }
    if (candidate instanceof Error && candidate.message) messages.push(candidate.message);
    else if (!(candidate instanceof Error) && candidate !== undefined)
      messages.push(String(candidate));
    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) collect(nested);
    }
    if (candidate instanceof Error && candidate.cause) collect(candidate.cause);
  };
  collect(error);
  let message = [...new Set(messages)].join("; ") || "Supervised browser harness failed";
  for (const value of supervisedSensitiveValues) {
    if (value) message = message.replaceAll(value, "[REDACTED]");
  }
  return message;
}

function assertPositiveProcessGroupId(processGroupId) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error("Process-group identifier is invalid");
  }
}

function signalProcessGroup(processGroupId, signal) {
  assertPositiveProcessGroupId(processGroupId);
  if (!supportedProcessGroupSignals.has(signal)) {
    throw new Error("Process-group signal is unsupported");
  }
  if (process.platform === "win32") {
    throw new Error("POSIX process-group cleanup is required by the test harness");
  }
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupExists(processGroupId) {
  assertPositiveProcessGroupId(processGroupId);
  if (process.platform === "win32") return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return classifyProcessGroupProbeError(error);
  }
}

export function classifyProcessGroupProbeError(error) {
  if (error?.code === "ESRCH") return false;
  if (error?.code === "EPERM") return true;
  throw error;
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processGroupExists(processGroupId);
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

async function proveRetainedHarnessGroupAbsent(child, identity) {
  if (!identity) return;
  if (child.exitCode === null && child.signalCode === null) {
    const liveIdentity = readProcessIdentity(identity.pid);
    if (
      !sameOwnedProcessIdentity(identity, liveIdentity) ||
      !processOwnsExactDescriptor(identity.pid, harnessOwnershipDescriptor, identity.ownership)
    ) {
      throw new Error("Retained harness identity changed before cleanup");
    }
    return;
  }
  if (await waitForProcessGroupExit(identity.pgid, processGroupGraceMs)) return;
  throw new Error("Harness leader exited before process-group absence was proved");
}

function clearChildShutdownTimer() {
  if (childShutdownTimer !== undefined) {
    clearTimeout(childShutdownTimer);
    childShutdownTimer = undefined;
  }
}

function recordSignalFailures(errors) {
  if (errors.length === 0) return;
  const error = errors.length === 1 ? errors[0] : new AggregateError(errors);
  signalFailure = signalFailure ? new AggregateError([signalFailure, error]) : error;
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

function handleSignal(signal) {
  const errors = [];
  const attempt = (operation) => {
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  };
  attempt(() => publishBrowserCancellation());
  if (receivedSignal) {
    attempt(() => signalRetainedBrowser("SIGKILL"));
    attempt(() => signalRetainedHarness("SIGKILL"));
    recordSignalFailures(errors);
    return;
  }
  receivedSignal = signal;
  attempt(() => signalRetainedBrowser(signal));
  attempt(() => signalRetainedHarness(signal));
  recordSignalFailures(errors);
  if (!activeChild || childShutdownTimer !== undefined) return;
  childShutdownTimer = setTimeout(() => {
    const timeoutErrors = [];
    try {
      signalRetainedBrowser("SIGKILL");
    } catch (error) {
      timeoutErrors.push(error);
    }
    try {
      signalRetainedHarness("SIGKILL");
    } catch (error) {
      timeoutErrors.push(error);
    }
    recordSignalFailures(timeoutErrors);
  }, childShutdownTimeoutMs);
  childShutdownTimer.unref();
}

const signalHandlers = new Map();

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => handleSignal(signal);
    process.on(signal, handler);
    signalHandlers.set(signal, handler);
  }
}

function removeSignalHandlers() {
  clearChildShutdownTimer();
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  signalHandlers.clear();
}

function run(commandPath, commandArgs, options = {}) {
  const { capture = false, ...spawnOptions } = options;
  const result = spawnSync(commandPath, commandArgs, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: 30_000,
    ...spawnOptions,
  });

  if (result.error) {
    throw new Error(`${commandPath} failed to execute: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${commandPath} failed with exit code ${result.status}${details ? `\n${details}` : ""}`,
    );
  }

  return result.stdout?.trim() ?? "";
}

function runOrdinarySync(commandPath, commandArgs, options = {}) {
  const { capture = false, ...spawnOptions } = options;
  const result = spawnSync(commandPath, commandArgs, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    ...spawnOptions,
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${commandPath} failed with exit code ${result.status}${details ? `\n${details}` : ""}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

async function runOrdinaryChild(childCommand, childArgs, env) {
  await new Promise((resolveChild, reject) => {
    const child = spawn(childCommand, childArgs, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveChild();
        return;
      }
      reject(new Error(`${childCommand} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

async function runOrdinaryWithPostgres() {
  const pgBin = runOrdinarySync("pg_config", ["--bindir"], { capture: true });
  const executable = (name) => join(pgBin, name);
  const root = await mkdtemp(join(tmpdir(), "esbla-postgres-"));
  const dataDirectory = join(root, "data");
  const socketDirectory = join(root, "socket");
  const logPath = join(root, "postgres.log");
  const port = await reservePort();
  const databaseName = "esbla_test";
  const migrationRole = "esbla_migrator";
  const applicationRole = "esbla_app";
  let started = false;
  try {
    await mkdir(socketDirectory);
    runOrdinarySync(executable("initdb"), [
      "--auth=trust",
      "--data-checksums",
      "--encoding=UTF8",
      "--no-locale",
      "--username=postgres",
      "-D",
      dataDirectory,
    ]);
    runOrdinarySync(executable("pg_ctl"), [
      "-D",
      dataDirectory,
      "-l",
      logPath,
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`,
      "-w",
      "start",
    ]);
    started = true;
    const connectionArgs = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--username",
      "postgres",
    ];
    for (const role of [migrationRole, applicationRole]) {
      runOrdinarySync(executable("createuser"), [
        ...connectionArgs,
        "--login",
        "--no-createdb",
        "--no-createrole",
        "--no-superuser",
        role,
      ]);
    }
    runOrdinarySync(executable("createdb"), [
      ...connectionArgs,
      "--owner",
      migrationRole,
      databaseName,
    ]);
    runOrdinarySync(executable("psql"), [
      ...connectionArgs,
      "--dbname",
      databaseName,
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `ALTER SCHEMA public OWNER TO ${migrationRole}`,
    ]);
    await runOrdinaryChild(command, args, {
      ...withoutBrowserControlEnvironment(process.env),
      DATABASE_MIGRATION_URL: `postgresql://${migrationRole}@127.0.0.1:${port}/${databaseName}`,
      DATABASE_URL: `postgresql://${applicationRole}@127.0.0.1:${port}/${databaseName}`,
      ESBLA_TEST_APPLICATION_ROLE: applicationRole,
    });
  } finally {
    if (started) {
      runOrdinarySync(executable("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
    }
    await rm(root, { force: true, recursive: true });
  }
}

function postgresIsRunning(pgCtl, dataDirectory) {
  const result = spawnSync(pgCtl, ["-D", dataDirectory, "status"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  if (result.error) {
    throw new Error(`Unable to verify PostgreSQL status: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  throw new Error(`Unable to verify PostgreSQL status; pg_ctl exited ${result.status}`);
}

function throwIfInterrupted() {
  if (receivedSignal) throw new Error(`PostgreSQL harness interrupted by ${receivedSignal}`);
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a PostgreSQL test port"));
        return;
      }

      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function runChild(childCommand, childArgs, env) {
  if (receivedSignal) {
    return;
  }

  activeHarnessExitReceipt = undefined;
  let childFailure;
  let child;
  let processGroupId;
  let browserMonitorPromise;
  await new Promise((resolve) => {
    const cleanEnvironment = withoutBrowserControlEnvironment(env);
    const childEnvironment = superviseBrowser
      ? { ...cleanEnvironment, ...browserControlEnvironment(browserControl) }
      : cleanEnvironment;
    if (superviseBrowser) {
      unlinkSync(browserControl.harnessOwnershipPath);
      if (lstatIfExists(browserControl.harnessOwnershipPath)) {
        throw new Error("Harness ownership capability pathname still exists before spawn");
      }
    }
    child = spawn(childCommand, childArgs, {
      detached: process.platform !== "win32",
      env: childEnvironment,
      stdio: superviseBrowser
        ? [
            "inherit",
            "inherit",
            "inherit",
            "ignore",
            "ignore",
            browserControl.harnessOwnershipHandle,
          ]
        : "inherit",
    });
    activeChild = child;
    processGroupId = child.pid;

    if (superviseBrowser) {
      try {
        const firstHarnessIdentity = readProcessIdentity(child.pid);
        const secondHarnessIdentity = readProcessIdentity(child.pid);
        if (
          !sameProcessIdentity(firstHarnessIdentity, secondHarnessIdentity) ||
          firstHarnessIdentity.pid !== child.pid ||
          firstHarnessIdentity.ppid !== process.pid ||
          firstHarnessIdentity.pgid !== child.pid ||
          !processOwnsExactDescriptor(
            child.pid,
            harnessOwnershipDescriptor,
            browserControl.harnessOwnership,
          )
        ) {
          throw new Error("Unable to retain the supervised harness identity");
        }
        activeHarnessIdentity = {
          ...firstHarnessIdentity,
          ownership: browserControl.harnessOwnership,
        };
        writeFileSync(
          browserControl.harnessRetentionPath,
          `nonce=${browserControl.nonce}\npid=${activeHarnessIdentity.pid}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        browserMonitorPromise = monitorBrowserRegistration(child).catch(async (error) => {
          const capturedChild = child;
          const capturedIdentity = activeHarnessIdentity;
          let cancellationFailure;
          const terminationFailures = [];
          let termDisposition = "not-attempted";
          try {
            publishBrowserCancellation();
          } catch (signalError) {
            cancellationFailure = signalError;
          }
          try {
            termDisposition = signalRetainedHarness("SIGTERM", capturedChild, capturedIdentity);
          } catch (signalError) {
            terminationFailures.push(signalError);
          }
          if (termDisposition === "signaled" && capturedIdentity) {
            try {
              if (!(await waitForProcessGroupExit(capturedIdentity.pgid, processGroupGraceMs))) {
                const killDisposition = signalRetainedHarness(
                  "SIGKILL",
                  capturedChild,
                  capturedIdentity,
                );
                if (
                  killDisposition === "signaled" &&
                  !(await waitForProcessGroupExit(capturedIdentity.pgid, processGroupKillMs))
                ) {
                  throw new Error(
                    "Internally rejected harness survived identity-authorized SIGKILL",
                  );
                }
              }
            } catch (signalError) {
              terminationFailures.push(signalError);
            }
          }
          const failures = [
            error,
            ...(cancellationFailure ? [cancellationFailure] : []),
            ...terminationFailures,
          ];
          browserControlFailure =
            failures.length === 1 ? failures[0] : new AggregateError(failures);
          return undefined;
        });
      } catch (error) {
        browserControlFailure = error;
      }
    }

    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      childFailure = error;
      resolve();
    };

    child.once("error", (error) => settle(error));
    child.once("exit", (code, signal) => {
      if (superviseBrowser) {
        const identity = activeHarnessIdentity;
        if (child === activeChild && identity && child.pid === identity.pid) {
          activeHarnessExitReceipt = Object.freeze({ child, code, identity, signal });
        } else {
          const receiptFailure = new Error(
            "Retained harness exit receipt could not be bound to the exact child",
          );
          browserControlFailure = browserControlFailure
            ? new AggregateError([browserControlFailure, receiptFailure])
            : receiptFailure;
        }
      }
      if (code === 0) {
        settle();
        return;
      }
      settle(new Error(`${childCommand} exited with ${signal ?? `code ${code}`}`));
    });
  });

  if (browserMonitorPromise) await browserMonitorPromise;
  if (browserControlFailure) {
    childFailure = childFailure
      ? new AggregateError([childFailure, browserControlFailure])
      : browserControlFailure;
  }
  if (superviseBrowser && !receivedSignal && !childFailure && !activeBrowserIdentity) {
    childFailure = new Error(
      "Supervised command exited successfully without a browser registration",
    );
  }

  let drainFailure;
  try {
    const drainErrors = [];
    if (superviseBrowser) {
      try {
        await drainRetainedBrowserGroup();
      } catch (error) {
        drainErrors.push(error);
      }
    }
    if (processGroupId) {
      try {
        await proveRetainedHarnessGroupAbsent(child, activeHarnessIdentity);
      } catch (error) {
        drainErrors.push(error);
      }
    }
    if (drainErrors.length === 1) drainFailure = drainErrors[0];
    if (drainErrors.length > 1) drainFailure = new AggregateError(drainErrors);
  } finally {
    activeChild = undefined;
    activeHarnessIdentity = undefined;
    activeHarnessExitReceipt = undefined;
    clearChildShutdownTimer();
  }
  if (drainFailure) {
    if (childFailure) throw new AggregateError([childFailure, drainFailure]);
    throw drainFailure;
  }
  if (childFailure) throw childFailure;
}

if (isMain && !superviseBrowser) {
  await runOrdinaryWithPostgres();
}

if (isMain && superviseBrowser) {
  installSignalHandlers();
  let pgBin;
  let root;
  let dataDirectory;
  let socketDirectory;
  let logPath;
  let setupFailure;
  try {
    browserControl = await createBrowserControl();
    pgBin = run("pg_config", ["--bindir"], { capture: true });
    root = await mkdtemp(join(tmpdir(), "esbla-postgres-"));
    dataDirectory = join(root, "data");
    socketDirectory = join(root, "socket");
    logPath = join(root, "postgres.log");
  } catch (error) {
    setupFailure = error;
  }
  if (setupFailure) {
    if (root) await rm(root, { force: true, recursive: true }).catch(() => {});
    if (browserControl) {
      try {
        await cleanupBrowserRoots();
      } catch (cleanupError) {
        setupFailure = new AggregateError([setupFailure, cleanupError]);
      }
    }
    removeSignalHandlers();
    throw new Error(sanitizeSupervisedFailure(setupFailure));
  }
  const executable = (name) => join(pgBin, name);
  const databaseName = "esbla_test";
  const migrationRole = "esbla_migrator";
  const applicationRole = "esbla_app";
  let port;
  let startAttempted = false;
  let failure;

  try {
    port = await reservePort();
    throwIfInterrupted();
    await mkdir(socketDirectory);
    run(executable("initdb"), [
      "--auth=trust",
      "--data-checksums",
      "--encoding=UTF8",
      "--no-locale",
      "--username=postgres",
      "-D",
      dataDirectory,
    ]);
    throwIfInterrupted();
    startAttempted = true;
    run(
      executable("pg_ctl"),
      [
        "-D",
        dataDirectory,
        "-l",
        logPath,
        "-o",
        `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`,
        "-t",
        "15",
        "-w",
        "start",
      ],
      { timeout: 20_000 },
    );
    throwIfInterrupted();

    const connectionArgs = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--username",
      "postgres",
    ];
    for (const role of [migrationRole, applicationRole]) {
      run(executable("createuser"), [
        ...connectionArgs,
        "--login",
        "--no-createdb",
        "--no-createrole",
        "--no-superuser",
        role,
      ]);
      throwIfInterrupted();
    }
    run(executable("createdb"), [...connectionArgs, "--owner", migrationRole, databaseName]);
    throwIfInterrupted();
    run(executable("psql"), [
      ...connectionArgs,
      "--dbname",
      databaseName,
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `ALTER SCHEMA public OWNER TO ${migrationRole}`,
    ]);
    throwIfInterrupted();

    if (!receivedSignal) {
      await runChild(command, args, {
        ...process.env,
        DATABASE_MIGRATION_URL: `postgresql://${migrationRole}@127.0.0.1:${port}/${databaseName}`,
        DATABASE_URL: `postgresql://${applicationRole}@127.0.0.1:${port}/${databaseName}`,
        ESBLA_TEST_APPLICATION_ROLE: applicationRole,
      });
    }
  } catch (error) {
    failure = error;
  } finally {
    if (signalFailure)
      failure = failure ? new AggregateError([failure, signalFailure]) : signalFailure;
    let shutdownProven = !startAttempted;
    if (startAttempted) {
      try {
        shutdownProven = !postgresIsRunning(executable("pg_ctl"), dataDirectory);
      } catch (statusError) {
        failure = failure ? new AggregateError([failure, statusError]) : statusError;
      }
    }
    if (startAttempted && !shutdownProven) {
      try {
        run(executable("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-t", "8", "-w", "stop"], {
          timeout: 10_000,
        });
        shutdownProven = true;
      } catch (fastStopError) {
        let stillRunning = true;
        try {
          stillRunning = postgresIsRunning(executable("pg_ctl"), dataDirectory);
        } catch {
          stillRunning = true;
        }
        if (!stillRunning) {
          shutdownProven = true;
        } else {
          try {
            run(
              executable("pg_ctl"),
              ["-D", dataDirectory, "-m", "immediate", "-t", "4", "-w", "stop"],
              { timeout: 6_000 },
            );
            shutdownProven = true;
          } catch (immediateStopError) {
            try {
              shutdownProven = !postgresIsRunning(executable("pg_ctl"), dataDirectory);
            } catch {
              shutdownProven = false;
            }
            if (!shutdownProven) {
              const stopFailure = new AggregateError(
                [fastStopError, immediateStopError],
                `PostgreSQL shutdown is unproved; retained ephemeral directory ${root}`,
              );
              failure = failure ? new AggregateError([failure, stopFailure]) : stopFailure;
            }
          }
        }
      }
    }

    if (shutdownProven) {
      try {
        await rm(root, { force: true, recursive: true });
      } catch (error) {
        failure = failure ? new AggregateError([failure, error]) : error;
      }
    }
    if (superviseBrowser) {
      try {
        await cleanupBrowserRoots();
      } catch (error) {
        failure = failure ? new AggregateError([failure, error]) : error;
      }
    }
    removeSignalHandlers();
  }

  if (receivedSignal) {
    if (failure) process.stderr.write(`${sanitizeSupervisedFailure(failure)}\n`);
    process.kill(process.pid, receivedSignal);
  } else if (failure) {
    throw new Error(sanitizeSupervisedFailure(failure));
  }
}

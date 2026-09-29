// Published-driver cell for owner-conversation cron failure repair: the baseline authors an
// owned and an unowned agentTurn job with an announce failure route and records their first
// failure; after its own updater installs the candidate, the second failure must start one
// repair turn for the owned job instead of the chat alert, while the unowned job still alerts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const TOKEN = "upgrade-survivor-token";
const GATEWAY_URL = "ws://127.0.0.1:18789";
const PROVIDER = "survivor";
const MODEL = "gpt-5.6-luna";
const BROKEN_MODEL = "cron-broken-step";
const OWNER_SESSION_KEY = "agent:main:cron-repair-owner";
const OWNER_READY = "CRON_REPAIR_OWNER_READY";
const BROKEN_ERROR = "cron repair survivor: broken step rejected";
const REPAIR_BRIEF = "Automation repair: private background turn started by the scheduler";
const FAILURE_ROUTE = { after: 2, channel: "telegram", to: "123456789" };
const JOBS = {
  owned: { name: "Survivor owned sync", owner: true },
  unowned: { name: "Survivor unowned sync", owner: false },
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function requiredEnv(name) {
  assert(process.env[name], `${name} is required`);
  return process.env[name];
}

function artifact(name) {
  return path.join(requiredEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"), name);
}

function cli(args, label) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  fs.writeFileSync(artifact(`${label}.out`), result.stdout ?? "");
  fs.writeFileSync(artifact(`${label}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `${label} failed (exit ${result.status}); see ${label}.err`);
  return result.stdout;
}

function gatewayCall(method, params, label) {
  const stdout = cli(
    [
      "gateway",
      "call",
      method,
      "--url",
      GATEWAY_URL,
      "--token",
      TOKEN,
      "--timeout",
      "120000",
      "--params",
      JSON.stringify(params),
      "--json",
    ],
    label,
  );
  // Released CLIs may print notices before their JSON result.
  const start = stdout.search(/^\s*\{/mu);
  assert(start >= 0, `${label} did not return JSON`);
  return JSON.parse(stdout.slice(start));
}

function writeMockControl(stage) {
  // Responses are routed by model: the job's step model is broken, and the agent's default
  // model answers the owner turn on the baseline and the repair brief on the candidate.
  writeJson(requiredEnv("MOCK_RESPONSE_CONTROL"), {
    models: {
      [BROKEN_MODEL]: { fail: { status: 400, message: BROKEN_ERROR } },
      [MODEL]: { text: stage === "baseline" ? OWNER_READY : "NO_REPLY" },
    },
  });
}

function configure() {
  const mockPort = requiredEnv("OPENCLAW_UPGRADE_SURVIVOR_MOCK_PORT");
  const model = (id) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  });
  writeJson(requiredEnv("OPENCLAW_CONFIG_PATH"), {
    gateway: {
      mode: "local",
      bind: "loopback",
      controlUi: { enabled: false },
      reload: { mode: "off" },
      auth: { mode: "token", token: TOKEN },
    },
    models: {
      providers: {
        [PROVIDER]: {
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          api: "openai-completions",
          apiKey: "sk-openclaw-upgrade-survivor-mock",
          models: [model(MODEL), model(BROKEN_MODEL)],
        },
      },
    },
    agents: {
      defaults: {
        workspace: requiredEnv("OPENCLAW_TEST_WORKSPACE_DIR"),
        model: { primary: `${PROVIDER}/${MODEL}` },
      },
    },
    cron: { enabled: true },
  });
  writeMockControl("baseline");
}

function databasePath() {
  return path.join(requiredEnv("OPENCLAW_STATE_DIR"), "state/openclaw.sqlite");
}

function readJobRows(ids) {
  const db = new DatabaseSync(databasePath(), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT job_id, enabled, job_json, state_json FROM cron_jobs")
      .all()
      .filter((row) => ids.includes(row.job_id));
    return Object.fromEntries(
      rows.map((row) => [
        row.job_id,
        {
          enabled: row.enabled === 1,
          job: JSON.parse(row.job_json),
          state: JSON.parse(row.state_json),
        },
      ]),
    );
  } finally {
    db.close();
  }
}

async function waitFor(label, check, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = check();
    if (last.done) {
      return last.value;
    }
    await delay(500);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last?.value ?? null)}`);
}

function readRequests() {
  const log = requiredEnv("MOCK_REQUEST_LOG");
  if (!fs.existsSync(log)) {
    return [];
  }
  // The mock logs the redacted body as JSON text; keep both the text and its model.
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === "POST" && entry.path === "/v1/chat/completions")
    .map((entry) => {
      const text = typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
      return { seq: entry.seq, model: JSON.parse(text).model, text };
    });
}

function forceRun(id, label) {
  const result = gatewayCall("cron.run", { id, mode: "force" }, label);
  assert.notEqual(result.ok, false, `${label} was rejected: ${JSON.stringify(result)}`);
}

async function waitForConsecutiveErrors(ids, count, label) {
  return await waitFor(label, () => {
    const rows = readJobRows(ids);
    const value = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          consecutiveErrors: rows[id]?.state.consecutiveErrors,
          lastRunStatus: rows[id]?.state.lastRunStatus,
          running: rows[id]?.state.runningAtMs !== undefined,
        },
      ]),
    );
    const done = ids.every(
      (id) =>
        value[id].consecutiveErrors === count &&
        value[id].lastRunStatus === "error" &&
        !value[id].running,
    );
    return { done, value };
  });
}

async function seedBaseline() {
  // The owner conversation is a real baseline session, created by an agent turn in it.
  cli(
    [
      "agent",
      "--session-key",
      OWNER_SESSION_KEY,
      "--message",
      "Set up an hourly sync automation for me.",
      "--thinking",
      "off",
      "--timeout",
      "90",
      "--json",
    ],
    "cron-repair-owner-turn",
  );
  assert(
    fs.readFileSync(artifact("cron-repair-owner-turn.out"), "utf8").includes(OWNER_READY),
    "Baseline owner turn did not return the mock reply",
  );
  const ids = {};
  for (const [key, spec] of Object.entries(JOBS)) {
    const created = gatewayCall(
      "cron.add",
      {
        name: spec.name,
        agentId: "main",
        ...(spec.owner ? { owner: { agentId: "main", sessionKey: OWNER_SESSION_KEY } } : {}),
        enabled: true,
        schedule: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: `Run the ${key} sync step and report what changed.`,
          model: `${PROVIDER}/${BROKEN_MODEL}`,
          timeoutSeconds: 60,
        },
        delivery: { mode: "none" },
        failureAlert: FAILURE_ROUTE,
      },
      `cron-repair-add-${key}`,
    );
    const id = created.id ?? created.job?.id;
    assert(id, `cron.add returned no job id for ${key}`);
    ids[key] = id;
  }
  // The baseline itself records the first failure of each streak: below the threshold,
  // so it alerts nothing, and the incident continues across the update.
  for (const [key, id] of Object.entries(ids)) {
    forceRun(id, `cron-repair-baseline-run-${key}`);
  }
  await waitForConsecutiveErrors(Object.values(ids), 1, "baseline first failure");
  const rows = readJobRows(Object.values(ids));
  for (const [key, id] of Object.entries(ids)) {
    const { job, state } = rows[id];
    assert.equal(job.owner?.sessionKey, JOBS[key].owner ? OWNER_SESSION_KEY : undefined);
    // The baseline opens an unresolved incident on any failure; below the threshold it has
    // no alert signature, cooldown, or (pre-repair release) repair marker.
    assert.deepEqual(state.failureAlertIncident, { scope: "run" }, `${key} incident shape`);
    assert.equal(state.lastFailureAlertAtMs, undefined, `${key} alerted below the threshold`);
  }
  const brokenRequests = readRequests().filter((entry) => entry.model === BROKEN_MODEL);
  assert(brokenRequests.length >= 2, "Baseline job runs did not reach the broken step model");
  writeJson(artifact("cron-failure-repair-fixture.json"), { ids, baseline: rows });
  console.log(
    `Baseline recorded one failure each for owned ${ids.owned} and unowned ${ids.unowned}.`,
  );
}

function assertUpdated() {
  const { ids } = readJson(artifact("cron-failure-repair-fixture.json"));
  const rows = readJobRows(Object.values(ids));
  for (const [key, id] of Object.entries(ids)) {
    const row = rows[id];
    assert(row, `Update lost the ${key} job`);
    assert.equal(row.enabled, true, `Update disabled the ${key} job`);
    assert.equal(row.state.consecutiveErrors, 1, `Update reset the ${key} failure streak`);
    assert.equal(row.job.owner?.sessionKey, JOBS[key].owner ? OWNER_SESSION_KEY : undefined);
    assert.deepEqual(row.state.failureAlertIncident, { scope: "run" }, `Update changed ${key}`);
  }
  writeMockControl("candidate");
  console.log("Candidate retained both one-failure streaks and their owners.");
}

async function exercise() {
  const { ids } = readJson(artifact("cron-failure-repair-fixture.json"));
  const requestsBefore = readRequests().length;
  for (const [key, id] of Object.entries(ids)) {
    forceRun(id, `cron-repair-candidate-run-${key}`);
  }
  await waitForConsecutiveErrors(Object.values(ids), 2, "candidate threshold failure");
  const settled = await waitFor("repair and alert settlement", () => {
    const rows = readJobRows(Object.values(ids));
    const owned = rows[ids.owned]?.state;
    const unowned = rows[ids.unowned]?.state;
    const value = {
      ownedIncident: owned?.failureAlertIncident,
      ownedDelivery: owned?.lastFailureNotificationDeliveryStatus,
      unownedIncident: unowned?.failureAlertIncident,
      unownedDelivery: unowned?.lastFailureNotificationDeliveryStatus,
      // An undeliverable chat alert falls back to the main session, where the model sees it.
      unownedAlertSeen: readRequests()
        .slice(requestsBefore)
        .some((entry) => entry.text.includes(alertNeedle(JOBS.unowned.name))),
    };
    const done =
      value.ownedIncident?.repair?.settled === true &&
      value.unownedDelivery !== undefined &&
      value.unownedDelivery !== "unknown" &&
      value.unownedAlertSeen;
    return { done, value: { ...value, rows } };
  });
  const requests = readRequests().slice(requestsBefore);
  writeJson(artifact("cron-failure-repair-candidate.json"), {
    settled,
    requests: requests.map(({ seq, model, text }) => ({
      seq,
      model,
      repairBrief: text.includes(REPAIR_BRIEF),
    })),
  });
  return { ids, settled, requests };
}

// Alert text as it appears, JSON-escaped, inside a logged request body.
function alertNeedle(jobName) {
  return JSON.stringify(`Automation "${jobName}" failed 2 times`).slice(1, -1);
}

function assertRuntime(ids, settled, requests, gatewayLog) {
  const owned = settled.rows[ids.owned];
  const unowned = settled.rows[ids.unowned];
  // Owned: the threshold failure started exactly one repair turn in the owner conversation.
  assert.equal(owned.enabled, true, "Owned job was disabled");
  assert.equal(owned.state.consecutiveErrors, 2);
  const repair = owned.state.failureAlertIncident?.repair;
  assert(repair, "Owned incident has no persisted repair marker");
  assert.equal(repair.atMs, owned.state.lastFailureAlertAtMs, "Repair marker lost its cycle");
  assert.equal(repair.settled, true, "Repair marker did not settle");
  assert.equal(repair.alerted, undefined, "Owned job fell back to the chat alert");
  assert.equal(owned.state.lastFailureNotificationDeliveryStatus, "not-requested");
  const briefs = requests.filter(
    (entry) => entry.model === MODEL && entry.text.includes(REPAIR_BRIEF),
  );
  assert.equal(briefs.length, 1, "Mock did not see exactly one repair brief");
  const brief = briefs[0].text;
  assert(
    brief.includes(`(id ${ids.owned}) failed 2 consecutive runs`),
    "Repair brief named another job or streak",
  );
  // The brief carries the recorded run error (bounded), JSON-escaped in the logged body.
  const recordedError = JSON.stringify(owned.state.lastError ?? "")
    .slice(1, -1)
    .slice(0, 80);
  assert(recordedError && brief.includes(recordedError), "Repair brief omitted the run error");
  assert(!brief.includes(ids.unowned), "Unowned job reached the repair brief");
  // Unowned: the unchanged failure alert path, with no repair marker.
  assert.equal(unowned.state.consecutiveErrors, 2);
  assert(unowned.state.failureAlertIncident?.signature, "Unowned job opened no alert incident");
  assert.equal(unowned.state.failureAlertIncident.repair, undefined, "Unowned job was repaired");
  assert.notEqual(unowned.state.lastFailureNotificationDeliveryStatus, "not-requested");
  const ownedAlerts = requests.filter((entry) => entry.text.includes(alertNeedle(JOBS.owned.name)));
  assert.equal(ownedAlerts.length, 0, "The owned job's failure alert reached the agent");
  const log = fs.readFileSync(gatewayLog, "utf8");
  assert.doesNotMatch(log, /failure repair (turn )?did not complete/u);
  assert.doesNotMatch(log, /cron: failure repair turn failed/u);
  const proof = {
    status: "passed",
    ownedJobId: ids.owned,
    ownedRepair: repair,
    ownedDeliveryStatus: owned.state.lastFailureNotificationDeliveryStatus,
    repairBriefRequests: briefs.length,
    unownedJobId: ids.unowned,
    unownedIncident: unowned.state.failureAlertIncident,
    unownedDeliveryStatus: unowned.state.lastFailureNotificationDeliveryStatus,
    unownedDeliveryError: unowned.state.lastFailureNotificationDeliveryError,
    unownedAlertReachedAgent: settled.unownedAlertSeen,
  };
  writeJson(artifact("cron-failure-repair-proof.json"), proof);
  process.stdout.write(`CRON_FAILURE_REPAIR_PROOF ${JSON.stringify(proof)}\n`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "configure") {
  configure();
} else if (command === "seed-baseline") {
  await seedBaseline();
} else if (command === "assert-updated") {
  assertUpdated();
} else {
  assert.equal(command, "exercise", `unknown cron-failure-repair command: ${command}`);
  const { ids, settled, requests } = await exercise();
  assertRuntime(ids, settled, requests, requiredEnv("OPENCLAW_UPGRADE_SURVIVOR_GATEWAY_LOG"));
}

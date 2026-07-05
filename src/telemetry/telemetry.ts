import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// Opt-in, privacy-respecting telemetry (yds.5).
//
// Purpose: measure clone→first-merge *activation* and 7-day *retention* so the
// team/monetization decisions after launch aren't made blind. Nothing else.
//
// Guarantees:
//   • OFF by default. Nothing is sent until the user explicitly opts in
//     (`shreni telemetry enable`) or sets SHRENI_TELEMETRY=1.
//   • Respects a hard opt-out (DO_NOT_TRACK=1 or SHRENI_TELEMETRY=0), which wins
//     over any config.
//   • No PII, ever: no repo names, no paths, no code, no task content, no user
//     identity. Only an anonymous random id, the event name, a coarse OS
//     platform, the Shreni version, and whitelisted primitive props the caller
//     passes explicitly.
//   • emit() never throws and never blocks — a telemetry failure must never
//     affect the harness.
//
// ─── FOUNDER DECISIONS (fill these in before relying on the data) ───
//   1. TELEMETRY_ENDPOINT below is null: with no endpoint, an opted-in client
//      writes events to a LOCAL jsonl file only (nothing leaves the machine).
//      Set a real collector URL here (or via SHRENI_TELEMETRY_ENDPOINT) to
//      actually gather activation/retention.
//   2. CONSENT_NOTICE copy — the exact disclosure shown on `telemetry enable`.
//   3. The set of event names (below) and any props — keep them non-identifying.

// The anonymous-usage collector (a public Supabase Edge Function; backend +
// deploy steps live in supabase/, see supabase/README.md). Override per-run with
// SHRENI_TELEMETRY_ENDPOINT, or set it to '' to force the local-only sink.
// Still only ever reached when the user has explicitly opted in.
export const TELEMETRY_ENDPOINT: string | null =
  'https://azahkqnhhdsfbmhngkul.supabase.co/functions/v1/anonymous-usage-telemetry';

// Shown when a user runs `shreni telemetry enable`. FOUNDER: finalize this copy.
export const CONSENT_NOTICE = [
  'Shreni telemetry is OPT-IN and anonymous.',
  '',
  'If you enable it, Shreni sends a random anonymous id plus coarse events',
  '(e.g. "a project was initialised", "a task merged", "the harness started")',
  'with the Shreni version and your OS platform. It NEVER sends your code, file',
  'paths, repo names, task contents, or any personal identifier.',
  '',
  'This helps us understand activation and retention. You can turn it off any',
  'time with `shreni telemetry disable`, or set DO_NOT_TRACK=1 to hard-disable it.',
].join('\n');

// The known event names. Keep this list small and non-identifying.
export type TelemetryEventName =
  | 'session_start' // harness started — retention signal
  | 'kshetra_init' // a project was registered — top of the activation funnel
  | 'task_merged'; // a task landed on main — the activation/first-value signal

// Which install an event came from. Defaults to 'production'; set
// SHRENI_TELEMETRY_ENV=test (or dev/development/ci) during your own runs so
// founder testing never pollutes real activation/retention numbers.
export type TelemetryEnvironment = 'test' | 'production';

export interface TelemetryEvent {
  name: TelemetryEventName;
  ts: string;
  anonymousId: string;
  version: string;
  platform: string;
  environment: TelemetryEnvironment;
  // Caller-supplied, strictly primitive and non-identifying (e.g. { rounds: 2 }).
  props?: Record<string, string | number | boolean>;
}

export interface TelemetryConfig {
  enabled: boolean;
  anonymousId?: string;
  consentedAt?: string;
  // Optional per-install endpoint override; falls back to TELEMETRY_ENDPOINT.
  endpoint?: string | null;
}

function defaultDir(): string {
  return resolve(homedir(), '.shreni');
}

function configPath(dir: string): string {
  return join(dir, 'telemetry.json');
}

function localSinkPath(dir: string): string {
  return join(dir, 'telemetry-local.jsonl');
}

export function loadTelemetryConfig(dir: string = defaultDir()): TelemetryConfig {
  try {
    return JSON.parse(readFileSync(configPath(dir), 'utf8')) as TelemetryConfig;
  } catch {
    // Missing / unreadable config ⇒ the default: disabled (opt-in).
    return { enabled: false };
  }
}

function saveTelemetryConfig(cfg: TelemetryConfig, dir: string = defaultDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2), 'utf8');
}

// Resolve the effective on/off state. A hard opt-out (DO_NOT_TRACK=1 or
// SHRENI_TELEMETRY in {0,off,false}) always wins; an env opt-in
// (SHRENI_TELEMETRY in {1,on,true}) forces on; otherwise the persisted config.
export function isTelemetryEnabled(
  cfg: TelemetryConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = (env.SHRENI_TELEMETRY ?? '').toLowerCase();
  if (env.DO_NOT_TRACK === '1' || flag === '0' || flag === 'off' || flag === 'false') return false;
  if (flag === '1' || flag === 'on' || flag === 'true') return true;
  return cfg.enabled === true;
}

function resolveEndpoint(cfg: TelemetryConfig, env: NodeJS.ProcessEnv): string | null {
  return env.SHRENI_TELEMETRY_ENDPOINT ?? cfg.endpoint ?? TELEMETRY_ENDPOINT;
}

// 'test' only when explicitly flagged via SHRENI_TELEMETRY_ENV; anything else
// (including unset) is 'production' — so real users are tagged correctly with
// no configuration, and only deliberate founder runs count as test traffic.
function resolveEnvironment(env: NodeJS.ProcessEnv): TelemetryEnvironment {
  const v = (env.SHRENI_TELEMETRY_ENV ?? '').toLowerCase();
  return ['test', 'testing', 'dev', 'development', 'ci'].includes(v) ? 'test' : 'production';
}

function readVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    return (JSON.parse(raw).version as string) ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Deliver one event. With an endpoint set, POST it (best-effort, short timeout,
// failures swallowed). With no endpoint, append it to a local jsonl file so an
// opted-in user can inspect exactly what would be sent — and nothing leaves the
// machine until a collector URL is configured.
async function deliver(event: TelemetryEvent, endpoint: string | null, dir: string): Promise<void> {
  if (!endpoint) {
    try {
      appendFileSync(localSinkPath(dir), JSON.stringify(event) + '\n', 'utf8');
    } catch {
      /* local sink is best-effort */
    }
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    /* telemetry must never surface a failure to the caller */
  }
}

export interface EmitOpts {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

// Record an event. A no-op (and a synchronous early return) when telemetry is
// disabled — the default — so the hot path pays almost nothing. Fully guarded:
// never throws, never blocks (network delivery is fire-and-forget; the local
// sink write is synchronous but cheap).
export function emit(
  name: TelemetryEventName,
  props?: Record<string, string | number | boolean>,
  opts: EmitOpts = {},
): void {
  try {
    const dir = opts.dir ?? defaultDir();
    const env = opts.env ?? process.env;
    const cfg = loadTelemetryConfig(dir);
    if (!isTelemetryEnabled(cfg, env)) return;

    const event: TelemetryEvent = {
      name,
      ts: new Date().toISOString(),
      anonymousId: cfg.anonymousId ?? 'anonymous',
      version: readVersion(),
      platform: process.platform,
      environment: resolveEnvironment(env),
      ...(props ? { props } : {}),
    };
    // Fire-and-forget: swallow the promise so a slow/failed POST never blocks or
    // rejects into the caller. (The no-endpoint local-sink path runs
    // synchronously before the promise is returned.)
    void deliver(event, resolveEndpoint(cfg, env), dir);
  } catch {
    /* telemetry must never break the caller */
  }
}

// Turn telemetry on: persist enabled=true, mint a stable anonymous id on first
// opt-in (reused thereafter), and stamp the consent time. Returns the new config.
export function enableTelemetry(dir: string = defaultDir()): TelemetryConfig {
  const cfg = loadTelemetryConfig(dir);
  const next: TelemetryConfig = {
    ...cfg,
    enabled: true,
    anonymousId: cfg.anonymousId ?? randomUUID(),
    consentedAt: new Date().toISOString(),
  };
  saveTelemetryConfig(next, dir);
  return next;
}

// Turn telemetry off. Keeps the anonymous id so a later re-opt-in is the same
// install (not a new one), but stops all sending.
export function disableTelemetry(dir: string = defaultDir()): TelemetryConfig {
  const cfg = loadTelemetryConfig(dir);
  const next: TelemetryConfig = { ...cfg, enabled: false };
  saveTelemetryConfig(next, dir);
  return next;
}

export interface TelemetryStatus {
  enabled: boolean;
  hardOptOut: boolean;
  anonymousId?: string;
  endpoint: string | null;
  localSink: string;
}

export function telemetryStatus(
  dir: string = defaultDir(),
  env: NodeJS.ProcessEnv = process.env,
): TelemetryStatus {
  const cfg = loadTelemetryConfig(dir);
  const hardOptOut =
    env.DO_NOT_TRACK === '1' || ['0', 'off', 'false'].includes((env.SHRENI_TELEMETRY ?? '').toLowerCase());
  return {
    enabled: isTelemetryEnabled(cfg, env),
    hardOptOut,
    anonymousId: cfg.anonymousId,
    endpoint: resolveEndpoint(cfg, env),
    localSink: localSinkPath(dir),
  };
}

// Exposed for tests (config path + local sink path resolution).
export const _internal = { configPath, localSinkPath };
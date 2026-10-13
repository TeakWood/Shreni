import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { uptime } from 'os';
import { kshetraDir } from '../kshetra/state-locations.js';
import { isLiveWorker } from '../cli/pid.js';

// Agent processes of a Kshetra (Shreni-beads-031a.19). A worker killed with
// SIGKILL leaves its agent CLI running, parentless, still writing to the repo
// checkout the next worker uses. So every agent runs as the leader of its own
// process group, which its tool calls (a shell, git, a test run) inherit even
// once their own parent has gone, and is recorded here while it runs, one file
// per agent under ~/.shreni/kshetra/<id>/agents/<pid>.json. A worker's startup
// stops every group a dead worker left behind before it claims anything.

export interface AgentRecord {
  /** The agent's pid, which is also its process group id. */
  pid: number;
  /** The worker that spawned it: its record is stale once this pid is dead. */
  workerPid: number;
  agent: string;
  beadId: string;
  bin: string;
  cwd: string;
  startedAt: string;
}

/** A dead worker's agent, as recovery found it. */
export interface OrphanedAgent extends AgentRecord {
  /** 'stopped': still running, now killed. 'exited': gone already, leaving nothing running. */
  status: 'stopped' | 'exited';
  /** Every pid killed for it: its group's, and the dead worker's group's. Empty when it had exited. */
  killed: number[];
}

/** A dead worker's agent survived SIGKILL; starting would share its checkout. */
export class OrphanAgentAlive extends Error {
  constructor(public readonly pids: number[]) {
    super(`a dead worker's agent is still running (pid ${pids.join(', ')}) and could not be stopped; kill it, then start again`);
    this.name = 'OrphanAgentAlive';
  }
}

/** Agents lead their own process group, except on Windows, which has none. */
export const AGENT_OWN_GROUP = process.platform !== 'win32';

/** Signals an agent's whole process group (just the agent on Windows). */
export function signalAgent(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(AGENT_OWN_GROUP ? -pid : pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function agentsDir(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'agents');
}

export function recordAgent(kshetraId: string, rec: AgentRecord): void {
  const dir = agentsDir(kshetraId);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${rec.pid}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(rec), 'utf8');
  renameSync(tmp, join(dir, `${rec.pid}.json`));
}

export function forgetAgent(kshetraId: string, pid: number): void {
  try { unlinkSync(join(agentsDir(kshetraId), `${pid}.json`)); } catch { /* already gone */ }
}

function readRecords(kshetraId: string): AgentRecord[] {
  let files: string[];
  try { files = readdirSync(agentsDir(kshetraId)); } catch { return []; }
  const out: AgentRecord[] = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    try { out.push(JSON.parse(readFileSync(join(agentsDir(kshetraId), f), 'utf8')) as AgentRecord); } catch { /* torn or foreign; skip */ }
  }
  return out;
}

interface Proc { pid: number; pgid: number; startMs: number }

// `[[dd-]hh:]mm:ss` → ms.
function etimeMs(etime: string): number {
  const [days, rest] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return (((Number(days) * 24 + h) * 60 + m) * 60 + s) * 1000;
}

// Every process with its group and when it started, or null where `ps` can't
// say (Windows): then nothing is known to be an orphan, and nothing is signalled.
function processTable(): Proc[] | null {
  if (process.platform === 'win32') return null;
  try {
    const now = Date.now();
    return execFileSync('ps', ['-A', '-o', 'pid=,pgid=,etime='], { encoding: 'utf8', timeout: 5000 })
      .split('\n').map(l => l.trim().split(/\s+/)).filter(r => r.length === 3)
      .map(([pid, pgid, etime]) => ({ pid: Number(pid), pgid: Number(pgid), startMs: now - etimeMs(etime) }));
  } catch {
    return null;
  }
}

// ps reports elapsed time in whole seconds; a process counts as having started
// by `iso` if ps puts its start no later than this after it.
const START_SLACK_MS = 2000;
const startedBy = (p: Proc, iso: string): boolean => p.startMs <= Date.parse(iso) + START_SLACK_MS;

/**
 * Stops every recorded agent whose worker is dead, with SIGKILL: its whole
 * process group, and the dead worker's own group (where it led one), so
 * the gate runs and tool calls it left go too. Its work is discarded by the
 * work-tree reset that follows.
 *
 * Returns each dead worker's agent with what was done: 'stopped' with the pids
 * killed, or 'exited' when nothing of it was left running. Their records are
 * then dropped. A record from before the last boot is dropped unreported.
 * Throws OrphanAgentAlive, naming the pids, if any survive or the process
 * table can't be read; the records are then kept, to be reported by the next
 * start.
 *
 * A group only counts as the recorded one if its leader started by the time
 * of the record or, leader gone, the record is from since the last boot: while
 * a group has members its id is not reused. This process's own group is never
 * signalled.
 */
export async function stopOrphanedAgents(
  kshetraId: string,
  opts: { isWorkerLive?: (pid: number) => boolean } = {},
): Promise<OrphanedAgent[]> {
  const bootMs = Date.now() - uptime() * 1000;
  const records = readRecords(kshetraId).filter(rec => {
    if (Date.parse(rec.startedAt) > bootMs) return true;
    forgetAgent(kshetraId, rec.pid);
    return false;
  });
  if (records.length === 0 || process.platform === 'win32') return [];
  const table = processTable();
  if (!table) throw new OrphanAgentAlive(records.map(r => r.pid));
  const isWorkerLive = opts.isWorkerLive ?? isLiveWorker;
  const byPid = new Map(table.map(p => [p.pid, p]));
  const ownGroup = byPid.get(process.pid)?.pgid;
  // A live worker that started after the record is a reused pid, not the agent's worker.
  const workerLive = (rec: AgentRecord): boolean => {
    const w = byPid.get(rec.workerPid);
    return !!w && rec.workerPid !== process.pid && startedBy(w, rec.startedAt) && isWorkerLive(rec.workerPid);
  };
  const members = (pgid: number): number[] => table.filter(p => p.pgid === pgid).map(p => p.pid);

  const found: OrphanedAgent[] = [];
  const signalled = new Set<number>();
  // An agent that is not its own group's leader (its spawn couldn't make one)
  // is killed by itself.
  const lone = new Set<number>();
  for (const rec of records) {
    if (workerLive(rec)) continue;
    // A live agent that started after its record is a reused pid; the record
    // is kept, not dropped unreported, in case the clock moved instead.
    const leader = byPid.get(rec.pid);
    if (leader && !startedBy(leader, rec.startedAt)) continue;
    const groups = [rec.pid, rec.workerPid].filter(g =>
      g !== ownGroup && !signalled.has(g) && members(g).length > 0 &&
      (g === rec.pid || !byPid.has(g) || startedBy(byPid.get(g)!, rec.startedAt)));
    const alone = leader && members(rec.pid).length === 0 ? [rec.pid] : [];
    if (groups.length === 0 && alone.length === 0) {
      if (!leader) found.push({ ...rec, status: 'exited', killed: [] });
      continue;
    }
    for (const g of groups) { signalAgent(g, 'SIGKILL'); signalled.add(g); }
    for (const p of alone) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } lone.add(p); }
    found.push({ ...rec, status: 'stopped', killed: [...new Set([...alone, ...groups.flatMap(members)])] });
  }
  const alive = (): number[] => [
    ...[...signalled].filter(g => signalAgent(g, 0)),
    ...[...lone].filter(p => { try { process.kill(p, 0); return true; } catch { return false; } }),
  ];
  for (let i = 0; i < 100 && alive().length > 0; i++) await new Promise(r => setTimeout(r, 20));
  const survivors = alive();
  if (survivors.length > 0) throw new OrphanAgentAlive(survivors);
  for (const a of found) forgetAgent(kshetraId, a.pid);
  return found;
}

// Agents this process runs now, by pid (= group id), with their Kshetra. In
// their own groups they no longer get the terminal's signals or go when this
// process does, so both are passed on: SIGINT, SIGTERM and SIGHUP are forwarded,
// and on exit they are killed and their records dropped.
const liveAgents = new Map<number, string>();
const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
let hooked = false;

export function trackLiveAgent(kshetraId: string, pid: number): void {
  liveAgents.set(pid, kshetraId);
  if (hooked) return;
  hooked = true;
  process.on('exit', killLiveAgents);
  for (const sig of FORWARDED) {
    const forward = (): void => {
      for (const p of liveAgents.keys()) signalAgent(p, sig);
      // Listening must not stop the signal ending a process with no handler of its own.
      if (process.listenerCount(sig) === 1) {
        killLiveAgents();
        process.removeListener(sig, forward);
        process.kill(process.pid, sig);
      }
    };
    process.on(sig, forward);
  }
}

/**
 * An agent has exited: kill whatever it left in its group (a background
 * server, say), which nothing else would track once its record is dropped.
 */
export function untrackLiveAgent(pid: number): void {
  const kshetraId = liveAgents.get(pid);
  liveAgents.delete(pid);
  signalAgent(pid, 'SIGKILL');
  if (kshetraId !== undefined) forgetAgent(kshetraId, pid);
}

export function killLiveAgents(): void {
  for (const pid of [...liveAgents.keys()]) untrackLiveAgent(pid);
}

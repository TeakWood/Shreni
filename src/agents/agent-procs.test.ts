import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { recordAgent, forgetAgent, agentsDir, stopOrphanedAgents, trackLiveAgent, untrackLiveAgent, killLiveAgents, type AgentRecord } from './agent-procs';
import { isAlive } from '../cli/pid';

// Shreni-beads-031a.19: a worker killed with SIGKILL left its Silpi running in
// the checkout. Recovery must stop a dead worker's agents before anything is
// claimed, and say what it stopped.

const KSHETRA = 'orphans';
const groups: number[] = [];

// Starts `script` as the leader of its own process group, as runAgent starts an
// agent, and returns its pid with that of an exited process standing in for
// the killed worker.
function agentGroup(script: string): { pid: number; workerPid: number } {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  child.unref();
  groups.push(child.pid!);
  return { pid: child.pid!, workerPid: spawnSync('true').pid! };
}

// The group's live members. A killed leader stays a zombie until this test
// process (its parent) reaps it; a real orphan's parent is init, which reaps at once.
function members(pgid: number): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  return out.split('\n').map(l => l.trim().split(/\s+/))
    .filter(([, g, stat]) => Number(g) === pgid && !stat?.startsWith('Z')).map(([p]) => Number(p));
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 20));
}

function rec(over: Partial<AgentRecord>): AgentRecord {
  return { pid: 0, workerPid: 0, agent: 'silpi', beadId: 'eslint-k6g', bin: 'claude', cwd: '/repo', startedAt: new Date().toISOString(), ...over };
}

afterEach(() => {
  for (const g of groups.splice(0)) try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ }
});

describe('agent records', () => {
  it('records an agent and forgets it', () => {
    recordAgent(KSHETRA, rec({ pid: 4242, workerPid: process.pid }));
    expect(readdirSync(agentsDir(KSHETRA))).toContain('4242.json');
    forgetAgent(KSHETRA, 4242);
    expect(existsSync(`${agentsDir(KSHETRA)}/4242.json`)).toBe(false);
  });
});

describe('stopOrphanedAgents', () => {
  it("kills a dead worker's agent and its tool calls, and reports them", async () => {
    const { pid, workerPid } = agentGroup('sleep 301 & sleep 302; wait');
    await until(() => members(pid).length === 3);
    const tree = members(pid);
    expect(tree).toHaveLength(3);
    recordAgent(KSHETRA, rec({ pid, workerPid }));

    const stopped = await stopOrphanedAgents(KSHETRA);

    expect(members(pid)).toEqual([]);
    expect(stopped).toEqual([expect.objectContaining({ pid, workerPid, agent: 'silpi', beadId: 'eslint-k6g', status: 'stopped' })]);
    expect(stopped[0].killed.sort()).toEqual(tree.sort());
    expect(readdirSync(agentsDir(KSHETRA))).not.toContain(`${pid}.json`);
  });

  it('kills a tool call the agent left running after it exited itself', async () => {
    const { pid, workerPid } = agentGroup('sleep 303 & exit 0');
    await until(() => !isAlive(pid) && members(pid).length === 1);
    const [tool] = members(pid);
    expect(tool).not.toBe(pid);
    recordAgent(KSHETRA, rec({ pid, workerPid }));

    const stopped = await stopOrphanedAgents(KSHETRA);

    // Gone, or a zombie its new parent has yet to reap: either way, not running.
    expect(members(pid)).toEqual([]);
    expect(stopped[0].killed).toEqual([tool]);
  });

  it("leaves a live worker's agent alone", async () => {
    const { pid } = agentGroup('sleep 300');
    recordAgent(KSHETRA, rec({ pid, workerPid: process.ppid }));
    const stopped = await stopOrphanedAgents(KSHETRA, { isWorkerLive: p => p === process.ppid });
    expect(stopped).toEqual([]);
    expect(isAlive(pid)).toBe(true);
    forgetAgent(KSHETRA, pid);
  });

  it('never signals a reused pid: a process that started after the record', async () => {
    const { pid, workerPid } = agentGroup('sleep 300');
    recordAgent(KSHETRA, rec({ pid, workerPid, startedAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(await stopOrphanedAgents(KSHETRA)).toEqual([]);
    expect(isAlive(pid)).toBe(true);
    // Kept, not dropped unreported: the clock may have moved instead.
    expect(readdirSync(agentsDir(KSHETRA))).toContain(`${pid}.json`);
    forgetAgent(KSHETRA, pid);
  });

  it('treats a live worker that started after the record as a reused pid', async () => {
    const { pid, workerPid } = agentGroup('sleep 300');
    const reused = agentGroup('sleep 300').pid;
    recordAgent(KSHETRA, rec({ pid, workerPid: reused, startedAt: new Date(Date.now() - 60_000).toISOString() }));
    // The agent's own group also started after this back-dated record, so it is
    // left alone too; the worker check is what is under test.
    void workerPid;
    const stopped = await stopOrphanedAgents(KSHETRA, { isWorkerLive: p => p === reused });
    expect(stopped).toEqual([]);
    expect(isAlive(reused)).toBe(true);
    forgetAgent(KSHETRA, pid);
  });

  it('drops a record from before the last boot without signalling anything', async () => {
    const { pid, workerPid } = agentGroup('sleep 300');
    recordAgent(KSHETRA, rec({ pid, workerPid, startedAt: '2000-01-01T00:00:00Z' }));
    expect(await stopOrphanedAgents(KSHETRA)).toEqual([]);
    expect(isAlive(pid)).toBe(true);
    expect(readdirSync(agentsDir(KSHETRA))).not.toContain(`${pid}.json`);
  });

  it("never signals this process's own group, even as a dead worker's", async () => {
    const own = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    const { pid } = agentGroup('sleep 300');
    recordAgent(KSHETRA, rec({ pid, workerPid: own }));
    const stopped = await stopOrphanedAgents(KSHETRA, { isWorkerLive: () => false });
    expect(stopped[0].killed).toEqual([pid]);
  });

  it("kills a dead worker's live agent that doesn't lead its own group", async () => {
    // Spawned without a group of its own, as an agent would be if making one failed.
    const agent = spawn('sleep', ['308'], { stdio: 'ignore' });
    const pid = agent.pid!;
    try {
      recordAgent(KSHETRA, rec({ pid, workerPid: spawnSync('true').pid!, bin: 'sleep' }));
      const stopped = await stopOrphanedAgents(KSHETRA);
      expect(stopped).toEqual([expect.objectContaining({ pid, status: 'stopped', killed: [pid] })]);
      await new Promise(r => agent.exitCode !== null || agent.signalCode !== null ? r(null) : agent.once('exit', r));
      expect(agent.signalCode).toBe('SIGKILL');
    } finally {
      agent.kill('SIGKILL');
    }
  });

  // Shreni-beads-031a.20: so the log can still name it.
  it('returns an agent with nothing left running as already exited, killing nothing, and drops its record', async () => {
    const dead = spawnSync('true').pid!;
    const workerPid = spawnSync('true').pid!;
    recordAgent(KSHETRA, rec({ pid: dead, workerPid }));
    expect(await stopOrphanedAgents(KSHETRA)).toEqual([expect.objectContaining({ pid: dead, workerPid, agent: 'silpi', beadId: 'eslint-k6g', status: 'exited', killed: [] })]);
    expect(readdirSync(agentsDir(KSHETRA))).not.toContain(`${dead}.json`);
  });
});

describe('live agents', () => {
  it('passes a signal on to a live agent group when the process handles it itself', async () => {
    const { pid } = agentGroup('sleep 305 & wait');
    await until(() => members(pid).length === 2);
    trackLiveAgent(KSHETRA, pid);
    const own = (): void => {};
    process.on('SIGTERM', own);
    try {
      process.emit('SIGTERM');
      await until(() => members(pid).length === 0);
      expect(members(pid)).toEqual([]);
    } finally {
      process.removeListener('SIGTERM', own);
      untrackLiveAgent(pid);
    }
  });

  it('on exit, or once the agent is gone, kills what is left in its group and drops the record', async () => {
    const a = agentGroup('sleep 306 & wait');
    const b = agentGroup('sleep 307 & exit 0');
    await until(() => members(a.pid).length === 2 && members(b.pid).length === 1);
    for (const x of [a, b]) { recordAgent(KSHETRA, rec({ pid: x.pid, workerPid: process.pid })); trackLiveAgent(KSHETRA, x.pid); }
    untrackLiveAgent(b.pid);
    killLiveAgents();
    await until(() => members(a.pid).length + members(b.pid).length === 0);
    expect([...members(a.pid), ...members(b.pid)]).toEqual([]);
    expect(readdirSync(agentsDir(KSHETRA))).not.toContain(`${a.pid}.json`);
    expect(readdirSync(agentsDir(KSHETRA))).not.toContain(`${b.pid}.json`);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PhalakaChangeStream,
  formatSse,
  ProcessSnapshotSchema,
  type SseSink,
} from './stream.js';
import type { ProcessSnapshot } from './process-read.js';

// Temp-dir tests (ADR §4.1): drive the stream engine over real files in a temp
// dir + an injected snapshot fn, with autoTimers off so refresh()/drainActivity()
// /sendKeepalive() run deterministically — no fake clocks, no fs.watch races.

// A collector sink: records every raw SSE frame, and parses them into
// {event, data} pairs for assertions.
function collector(): SseSink & { frames: string[]; events(): { event: string; data: unknown }[]; ended: boolean } {
  const frames: string[] = [];
  return {
    frames,
    ended: false,
    write(frame: string) {
      frames.push(frame);
    },
    end() {
      this.ended = true;
    },
    // Parse `event: X\ndata: {...}\n\n` frames; ignores the `: connected` comment.
    events() {
      return frames
        .flatMap(f => f.split('\n\n'))
        .map(block => block.trim())
        .filter(block => block.startsWith('event:'))
        .map(block => {
          const [evLine, dataLine] = block.split('\n');
          return {
            event: evLine.slice('event:'.length).trim(),
            data: JSON.parse(dataLine.slice('data:'.length).trim()),
          };
        });
    },
  };
}

const worker = (over: Partial<ProcessSnapshot> = {}): ProcessSnapshot => ({
  kind: 'worker',
  kshetraId: 'alpha',
  pid: 100,
  status: 'working',
  phase: 'WORKING',
  paused: false,
  ...over,
});

let dir: string;
let activityPath: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phalaka-stream-'));
  activityPath = join(dir, 'activity.jsonl');
  statePath = join(dir, 'state.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Build an engine whose sources point at the temp dir, timers disabled.
function makeStream(snapshot: () => ProcessSnapshot[] = () => []) {
  return new PhalakaChangeStream({
    activityPaths: () => [activityPath],
    statePath,
    snapshot,
    autoTimers: false,
  });
}

describe('formatSse', () => {
  it('emits a named event + JSON data line terminated by a blank line', () => {
    expect(formatSse('activity', { a: 1 })).toBe('event: activity\ndata: {"a":1}\n\n');
  });
});

describe('activity tailing', () => {
  it('emits an activity event per newly-appended line, not the pre-existing history', () => {
    writeFileSync(activityPath, JSON.stringify({ type: 'beads_synced', kshetra: 'alpha' }) + '\n');
    const stream = makeStream();
    const c = collector();
    stream.addClient(c); // primes offsets to EOF → pre-existing line is not replayed

    appendFileSync(
      activityPath,
      JSON.stringify({ type: 'task_claimed', kshetra: 'alpha', beadId: 'a-1', title: 'Go' }) + '\n',
    );
    stream.drainActivity();

    const activity = c.events().filter(e => e.event === 'activity');
    expect(activity).toHaveLength(1);
    expect(activity[0]!.data).toMatchObject({ type: 'task_claimed', beadId: 'a-1' });
  });

  it('carries a partial (newline-less) line across drains until it completes', () => {
    writeFileSync(activityPath, '');
    const stream = makeStream();
    stream.addClient(collector());
    const c = collector();
    const id = stream.addClient(c);

    appendFileSync(activityPath, '{"type":"beads_synced","kshetra":"al'); // no newline yet
    stream.drainActivity();
    expect(c.events().filter(e => e.event === 'activity')).toHaveLength(0);

    appendFileSync(activityPath, 'pha"}\n'); // completes the line
    stream.drainActivity();
    const activity = c.events().filter(e => e.event === 'activity');
    expect(activity).toHaveLength(1);
    expect(activity[0]!.data).toMatchObject({ type: 'beads_synced', kshetra: 'alpha' });

    void id;
  });

  it('skips a corrupt line without breaking the stream', () => {
    writeFileSync(activityPath, '');
    const stream = makeStream();
    const c = collector();
    stream.addClient(c);

    appendFileSync(activityPath, 'not json\n' + JSON.stringify({ type: 'beads_synced', kshetra: 'alpha' }) + '\n');
    stream.drainActivity();
    expect(c.events().filter(e => e.event === 'activity')).toHaveLength(1);
  });
});

describe('state changes', () => {
  it('emits a state event when state.json is written', () => {
    const stream = makeStream();
    const c = collector();
    stream.addClient(c); // no state file yet → no initial state event

    writeFileSync(statePath, JSON.stringify({ kshetras: { alpha: { phase: 'PREPARING' } } }));
    stream.maybeEmitState();

    const state = c.events().filter(e => e.event === 'state');
    expect(state).toHaveLength(1);
    expect(state[0]!.data).toEqual({ kshetras: { alpha: { phase: 'PREPARING' } } });
  });

  it('does not re-emit when state.json content is unchanged', () => {
    writeFileSync(statePath, JSON.stringify({ kshetras: {} }));
    const stream = makeStream();
    const c = collector();
    stream.addClient(c); // initial state event
    c.frames.length = 0;

    stream.maybeEmitState();
    expect(c.events()).toHaveLength(0);
  });
});

describe('liveness poller', () => {
  it("emits a 'dead' process event when a worker's pid vanishes from the snapshot", () => {
    let snaps: ProcessSnapshot[] = [worker()];
    const stream = makeStream(() => snaps);
    const c = collector();
    stream.addClient(c); // initial process event (working)
    c.frames.length = 0;

    snaps = []; // pidfile gone
    stream.pollProcesses();

    const process = c.events().filter(e => e.event === 'process');
    expect(process).toHaveLength(1);
    expect(process[0]!.data).toMatchObject({ kind: 'worker', kshetraId: 'alpha', status: 'dead' });
    expect(() => ProcessSnapshotSchema.parse(process[0]!.data)).not.toThrow();
  });

  it("emits when readProcessSnapshots flips a lingering-pidfile worker to 'dead'", () => {
    let snaps: ProcessSnapshot[] = [worker({ status: 'working' })];
    const stream = makeStream(() => snaps);
    const c = collector();
    stream.addClient(c);
    c.frames.length = 0;

    snaps = [worker({ status: 'dead' })];
    stream.pollProcesses();

    const process = c.events().filter(e => e.event === 'process');
    expect(process).toHaveLength(1);
    expect(process[0]!.data).toMatchObject({ status: 'dead' });
  });

  it('does not re-emit an unchanged process on a quiet poll', () => {
    const stream = makeStream(() => [worker()]);
    const c = collector();
    stream.addClient(c);
    c.frames.length = 0;

    stream.pollProcesses();
    expect(c.events().filter(e => e.event === 'process')).toHaveLength(0);
  });

  it('emits on a status change (working → stuck)', () => {
    let snaps: ProcessSnapshot[] = [worker({ status: 'working' })];
    const stream = makeStream(() => snaps);
    const c = collector();
    stream.addClient(c);
    c.frames.length = 0;

    snaps = [worker({ status: 'stuck', stuck: { since: 't', reason: 'hung', remediation: 'resume' } })];
    stream.pollProcesses();
    const process = c.events().filter(e => e.event === 'process');
    expect(process).toHaveLength(1);
    expect(process[0]!.data).toMatchObject({ status: 'stuck' });
  });
});

describe('initial snapshot on connect', () => {
  it('sends every current process, the current state, and a keepalive', () => {
    writeFileSync(statePath, JSON.stringify({ kshetras: { alpha: { phase: 'IDLE' } } }));
    const stream = makeStream(() => [worker(), { kind: 'phalaka', pid: 9, status: 'healthy', paused: false }]);
    const c = collector();
    stream.addClient(c);

    const events = c.events();
    expect(events.filter(e => e.event === 'process')).toHaveLength(2);
    expect(events.filter(e => e.event === 'state')).toHaveLength(1);
    expect(events.filter(e => e.event === 'keepalive')).toHaveLength(1);
  });
});

describe('keepalive', () => {
  it('broadcasts a keepalive to every client', () => {
    const stream = makeStream();
    const a = collector();
    const b = collector();
    stream.addClient(a);
    stream.addClient(b);
    a.frames.length = 0;
    b.frames.length = 0;

    stream.sendKeepalive();
    expect(a.events().filter(e => e.event === 'keepalive')).toHaveLength(1);
    expect(b.events().filter(e => e.event === 'keepalive')).toHaveLength(1);
  });
});

describe('multi-client fan-out', () => {
  it('delivers a delta to every connected client', () => {
    let snaps: ProcessSnapshot[] = [worker()];
    const stream = makeStream(() => snaps);
    const a = collector();
    const b = collector();
    stream.addClient(a);
    stream.addClient(b);
    a.frames.length = 0;
    b.frames.length = 0;

    snaps = [worker({ status: 'idle', phase: 'IDLE' })];
    stream.pollProcesses();

    expect(a.events().filter(e => e.event === 'process')).toHaveLength(1);
    expect(b.events().filter(e => e.event === 'process')).toHaveLength(1);
  });

  it('a slow/failing client sink never stalls the others', () => {
    const stream = makeStream(() => [worker()]);
    const boom: SseSink = {
      write() {
        throw new Error('socket wedged');
      },
    };
    const good = collector();
    stream.addClient(boom);
    stream.addClient(good);
    good.frames.length = 0;

    expect(() => stream.sendKeepalive()).not.toThrow();
    expect(good.events().filter(e => e.event === 'keepalive')).toHaveLength(1);
  });
});

describe('disconnect cleanup', () => {
  it('ends the response and stops delivering to a removed client', () => {
    let snaps: ProcessSnapshot[] = [worker()];
    const stream = makeStream(() => snaps);
    const c = collector();
    const id = stream.addClient(c);
    expect(stream.clientCount).toBe(1);

    stream.removeClient(id);
    expect(c.ended).toBe(true);
    expect(stream.clientCount).toBe(0);

    c.frames.length = 0;
    snaps = [worker({ status: 'dead' })];
    stream.pollProcesses();
    expect(c.frames).toHaveLength(0); // no delivery after disconnect
  });

  it('close() ends every client and resets the count', () => {
    const stream = makeStream();
    const a = collector();
    const b = collector();
    stream.addClient(a);
    stream.addClient(b);

    stream.close();
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(stream.clientCount).toBe(0);
  });
});

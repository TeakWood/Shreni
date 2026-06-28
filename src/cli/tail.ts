import { openSync, readSync, closeSync, existsSync } from 'fs';
import { loadRegistry } from '../kshetra/registry';
import { logPath, legacyLogPath } from '../sthapathi/activity-log';
import { readPid, isAlive } from './pid';
import type { LoggedEvent } from '../sthapathi/activity-log';

const POLL_MS = 500;

function fmt(ev: LoggedEvent): string | null {
  const time = new Date(ev.ts).toLocaleTimeString('en-GB', { hour12: false });
  const tag = `[${time}] ${ev.kshetra.padEnd(12)}`;

  switch (ev.type) {
    case 'task_claimed':
      return `${tag} TASK       ${ev.beadId}: ${ev.title}`;

    case 'round_start':
      return `${tag} ${ev.agent === 'silpi' ? 'SILPI     ' : 'VIHARAPALA'} R${ev.round} starting…`;

    case 'silpi_done': {
      const lint = ev.lintPassed ? '✓' : '✗';
      const tests = ev.testsPassed ? '✓' : '✗';
      const fileList = ev.files.length ? `\n${' '.repeat(27)}files: ${ev.files.join(', ')}` : '';
      return (
        `${tag} SILPI      R${ev.round} conf=${ev.confidence} lint=${lint} tests=${tests}\n` +
        `${' '.repeat(27)}${ev.summary}${fileList}`
      );
    }

    case 'viharapala_done': {
      const verdict = ev.verdict === 'APPROVE' ? '✓ APPROVE' : '✗ REJECT ';
      const fixes = ev.mustFix.length
        ? `\n${' '.repeat(27)}mustFix: ${ev.mustFix.join(' | ')}`
        : '';
      return `${tag} VIHARAPALA R${ev.round} ${verdict} score=${ev.score}${fixes}`;
    }

    case 'agent_text': {
      const firstLine = (ev.text.split('\n').find(l => l.trim()) ?? ev.text).trim();
      if (!firstLine) return null;
      const truncated = firstLine.length > 110 ? firstLine.slice(0, 107) + '…' : firstLine;
      const aLabel = ev.agent === 'silpi' ? 'SILPI     ' : ev.agent === 'viharapala' ? 'VIHARAPALA' : 'PARIKSHAKA';
      return `${tag} ${aLabel} > ${truncated}`;
    }

    case 'agent_tool_call': {
      const aLabel = ev.agent === 'silpi' ? 'SILPI     ' : ev.agent === 'viharapala' ? 'VIHARAPALA' : 'PARIKSHAKA';
      const detail = ev.detail ? ` ${ev.detail}` : '';
      return `${tag} ${aLabel} ⚙ ${ev.tool}:${detail}`;
    }

    case 'task_done': {
      const status = ev.approved ? '✓ APPROVED' : '✗ BLOCKED ';
      return `${tag} DONE       ${ev.beadId} ${status} (${ev.rounds} round${ev.rounds === 1 ? '' : 's'})`;
    }

    case 'beads_synced':
      return `${tag} SYNC       beads synced`;

    case 'error':
      return `${tag} ERROR      ${ev.beadId ? ev.beadId + ': ' : ''}${ev.message}`;

    default:
      return null;
  }
}

function watchFile(path: string, kshetraId: string): () => void {
  let fd: number | null = null;
  let position = 0;
  let lineBuffer = '';
  let announced = false;

  function openFd(): void {
    if (fd !== null || !existsSync(path)) return;
    fd = openSync(path, 'r');
  }

  function readNewLines(): void {
    openFd();
    if (fd === null) return;

    const chunk = Buffer.allocUnsafe(8192);
    let bytesRead: number;
    do {
      bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead > 0) {
        position += bytesRead;
        lineBuffer += chunk.subarray(0, bytesRead).toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as LoggedEvent;
            const formatted = fmt(ev);
            if (formatted) console.log(formatted);
          } catch { /* skip malformed lines */ }
        }
      }
    } while (bytesRead > 0);
  }

  function tick(): void {
    if (!announced && !existsSync(path)) {
      console.log(`[${kshetraId}] waiting for first activity…`);
      announced = true;
    }
    readNewLines();
  }

  tick();
  const timer = setInterval(tick, POLL_MS);
  return () => {
    clearInterval(timer);
    if (fd !== null) closeSync(fd);
  };
}

export interface TailOpts {
  kshetraId?: string;
  all: boolean;
}

export function runTail(opts: TailOpts): void {
  const kshetras = loadRegistry();

  if (kshetras.length === 0) {
    console.error('No kshetras registered.');
    process.exit(1);
  }

  const targets = opts.all
    ? kshetras
    : kshetras.filter(k => k.id === opts.kshetraId);

  if (targets.length === 0) {
    console.error(opts.kshetraId
      ? `Kshetra not found: ${opts.kshetraId}`
      : 'Usage: shreni tail --kshetra <id> | --all');
    process.exit(1);
  }

  console.log(`Tailing activity for: ${targets.map(k => k.id).join(', ')}  (Ctrl+C to stop)`);
  for (const k of targets) {
    const pid = readPid(k.id);
    const state = pid !== null && isAlive(pid) ? `pid ${pid} (running)` : 'stopped';
    console.log(`  [${k.id}] worker ${state}`);
  }
  console.log();

  // Prefer the new per-kshetra activity log; fall back to the pre-Feature-2 path.
  const stops = targets.map(k => {
    const current = logPath(k.id);
    const path = existsSync(current) ? current : existsSync(legacyLogPath(k.id)) ? legacyLogPath(k.id) : current;
    return watchFile(path, k.id);
  });

  function shutdown(): void {
    stops.forEach(s => s());
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

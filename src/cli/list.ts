import { loadRegistry } from '../kshetra/registry.js';
import { loadState } from '../kshetra/state.js';

interface ListRow {
  id: string;
  name: string;
  status: string;
  repoPath: string;
}

export function buildKshetraRows(): ListRow[] {
  const kshetras = loadRegistry();
  const state = loadState();

  return kshetras.map(k => {
    const ks = state.kshetras[k.id];
    let status = 'active';
    if (ks?.paused) {
      status = ks.requiresManualResume ? 'paused (manual resume required)' : 'paused';
    }
    return { id: k.id, name: k.name, status, repoPath: k.repo.path };
  });
}

export function formatKshetraList(rows: ListRow[]): string {
  if (rows.length === 0) return 'No kshetras registered. Run `shreni register <path>` first.';

  const idWidth = Math.max(2, ...rows.map(r => r.id.length));
  const nameWidth = Math.max(4, ...rows.map(r => r.name.length));
  const statusWidth = Math.max(6, ...rows.map(r => r.status.length));

  const header = [
    'ID'.padEnd(idWidth),
    'NAME'.padEnd(nameWidth),
    'STATUS'.padEnd(statusWidth),
    'PATH',
  ].join('  ');

  const sep = '-'.repeat(header.length);

  const lines = rows.map(r =>
    [
      r.id.padEnd(idWidth),
      r.name.padEnd(nameWidth),
      r.status.padEnd(statusWidth),
      r.repoPath,
    ].join('  '),
  );

  return [header, sep, ...lines].join('\n');
}

export function runList(): void {
  const rows = buildKshetraRows();
  console.log(formatKshetraList(rows));
}
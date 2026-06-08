import { loadRegistry } from '../kshetra/registry';
import { syncBeads } from '../sthapathi/beads';
import type { KshetraConfig } from '../kshetra/config';

export interface SyncOpts {
  kshetraId?: string;
  all: boolean;
}

export async function runSync(opts: SyncOpts): Promise<void> {
  const kshetras = loadRegistry();

  if (kshetras.length === 0) {
    console.log('No kshetras registered.');
    return;
  }

  const targets: KshetraConfig[] = opts.all
    ? kshetras
    : kshetras.filter((k: KshetraConfig) => k.id === opts.kshetraId);

  if (targets.length === 0) {
    if (!opts.kshetraId) {
      console.error('Usage: shreni sync --kshetra <id> | --all');
    } else {
      console.error(`Kshetra not found: ${opts.kshetraId}`);
    }
    process.exit(1);
    return;
  }

  for (const k of targets) {
    console.log(`Syncing "${k.name}" (${k.id})...`);
    await syncBeads(k);
    console.log(`  Done.`);
  }
}
import { extensionCore } from './index.js';
import type { ExtensionCore } from './types.js';

// The well-known module id the core tries first. An optional package published
// under this name (or pointed at via SHRENI_EXT) may contribute EventSinks and
// swap the UsageMeter. Absent by default — local autonomous coding never depends
// on it being installed or reachable.
export const DEFAULT_EXT_MODULE = '@shreni/cloud';

// Injection seam for tests: the real importer is a dynamic import; a test passes
// a fake to exercise present/absent/throwing without a real package on disk.
export type Importer = (moduleId: string) => Promise<unknown>;

export interface LoadExtensionOpts {
  importer?: Importer;
  log?: (msg: string) => void;
  core?: ExtensionCore;
}

// A loaded extension module: exports register(core) (optionally under default).
function resolveRegister(mod: unknown): ((core: ExtensionCore) => void | Promise<void>) | null {
  const m = mod as { register?: unknown; default?: { register?: unknown } } | null;
  const candidate = (typeof m?.register === 'function' && m.register) ||
    (typeof m?.default?.register === 'function' && m.default!.register);
  return (candidate as ((core: ExtensionCore) => void | Promise<void>)) || null;
}

// Load the optional extension at worker startup, FAIL-OPEN. Tries the module id
// from SHRENI_EXT (or DEFAULT_EXT_MODULE); if present, calls its register(core)
// so it can append sinks / swap the meter before the Sthapathi loop arms. If the
// module is absent, exports no register(), or throws, the core keeps its local
// defaults and logs a single line — it never crashes and never blocks local use.
// Returns true iff an extension registered.
export async function loadExtension(opts: LoadExtensionOpts = {}): Promise<boolean> {
  const log = opts.log ?? console.error;
  const core = opts.core ?? extensionCore;
  const importer: Importer = opts.importer ?? ((id) => import(id));
  const moduleId = process.env.SHRENI_EXT?.trim() || DEFAULT_EXT_MODULE;

  try {
    const mod = await importer(moduleId);
    const register = resolveRegister(mod);
    if (!register) {
      // Loaded, but nothing to register — treat as no extension.
      log(`[shreni] extension "${moduleId}" exports no register(core) — using local defaults`);
      return false;
    }
    await register(core);
    log(`[shreni] extension loaded: ${moduleId}`);
    return true;
  } catch (err) {
    // Absent (module-not-found) or throwing — degrade to defaults. Keep it to a
    // single line: Node's module-not-found message trails a multi-line require
    // stack, so take only its first line.
    const reason = ((err as Error)?.message ?? String(err)).split('\n')[0];
    log(`[shreni] no extension loaded (${moduleId}: ${reason}) — using local defaults`);
    return false;
  }
}
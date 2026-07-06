import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadExtension, DEFAULT_EXT_MODULE } from './loader.js';
import type { ExtensionCore, EventSink, UsageMeter, PolicySource, Entitlements } from './types.js';

function fakeCore() {
  const sinks: EventSink[] = [];
  let meter: UsageMeter | null = null;
  let policy: PolicySource | null = null;
  let entitlements: Entitlements | null = null;
  const core: ExtensionCore = {
    version: 'test',
    addEventSink: s => sinks.push(s),
    setUsageMeter: m => { meter = m; },
    setPolicySource: p => { policy = p; },
    setEntitlements: e => { entitlements = e; },
  };
  return { core, sinks, getMeter: () => meter, getPolicy: () => policy, getEntitlements: () => entitlements };
}

const silentLog = () => {};
const savedExt = process.env.SHRENI_EXT;

afterEach(() => {
  if (savedExt === undefined) delete process.env.SHRENI_EXT;
  else process.env.SHRENI_EXT = savedExt;
  vi.restoreAllMocks();
});

describe('loadExtension (fail-open)', () => {
  it('fails open to defaults when the module is absent', async () => {
    delete process.env.SHRENI_EXT;
    const log = vi.fn();
    const { core, sinks } = fakeCore();
    const importer = vi.fn().mockRejectedValue(new Error(`Cannot find module '${DEFAULT_EXT_MODULE}'`));
    const loaded = await loadExtension({ importer, log, core });
    expect(loaded).toBe(false);
    expect(importer).toHaveBeenCalledWith(DEFAULT_EXT_MODULE);
    expect(sinks).toHaveLength(0);
    // Exactly one log line on the degrade path.
    expect(log).toHaveBeenCalledOnce();
  });

  it('calls register(core) and returns true when the extension is present', async () => {
    const { core, sinks, getMeter, getPolicy, getEntitlements } = fakeCore();
    const extSink: EventSink = { name: 'ext', handle: () => {} };
    const extMeter: UsageMeter = { record: () => {} };
    const extPolicy: PolicySource = { selectModel: r => r.default, mayProceed: () => ({ allowed: true }) };
    const extEnt: Entitlements = { capability: () => false, limit: () => 0 };
    const register = vi.fn((c: ExtensionCore) => {
      c.addEventSink(extSink);
      c.setUsageMeter(extMeter);
      c.setPolicySource(extPolicy);
      c.setEntitlements(extEnt);
    });
    const importer = vi.fn().mockResolvedValue({ register });
    const loaded = await loadExtension({ importer, log: silentLog, core });
    expect(loaded).toBe(true);
    expect(register).toHaveBeenCalledWith(core);
    expect(sinks).toEqual([extSink]);
    expect(getMeter()).toBe(extMeter);
    expect(getPolicy()).toBe(extPolicy);
    expect(getEntitlements()).toBe(extEnt);
  });

  it('supports a register exported under default', async () => {
    const { core } = fakeCore();
    const register = vi.fn();
    const importer = vi.fn().mockResolvedValue({ default: { register } });
    expect(await loadExtension({ importer, log: silentLog, core })).toBe(true);
    expect(register).toHaveBeenCalledWith(core);
  });

  it('fails open when a loaded module exports no register()', async () => {
    const { core, sinks } = fakeCore();
    const importer = vi.fn().mockResolvedValue({ notRegister: true });
    expect(await loadExtension({ importer, log: silentLog, core })).toBe(false);
    expect(sinks).toHaveLength(0);
  });

  it('fails open (no crash) when register throws', async () => {
    const { core } = fakeCore();
    const importer = vi.fn().mockResolvedValue({ register: () => { throw new Error('bad ext'); } });
    await expect(loadExtension({ importer, log: silentLog, core })).resolves.toBe(false);
  });

  it('honours SHRENI_EXT as the module id to import', async () => {
    process.env.SHRENI_EXT = '/opt/my-ext.js';
    const { core } = fakeCore();
    const importer = vi.fn().mockResolvedValue({ register: () => {} });
    await loadExtension({ importer, log: silentLog, core });
    expect(importer).toHaveBeenCalledWith('/opt/my-ext.js');
  });
});
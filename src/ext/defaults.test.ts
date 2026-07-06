import { describe, it, expect } from 'vitest';
import { staticPolicySource, allEnabledEntitlements } from './defaults.js';
import type { SelectModelRequest } from './types.js';

describe('staticPolicySource (free-tier default)', () => {
  const req: SelectModelRequest = {
    kshetra: 'myapp', beadId: 'b-1', agent: 'silpi',
    default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };

  it('selectModel echoes the static default unchanged', () => {
    expect(staticPolicySource.selectModel(req)).toEqual(req.default);
  });

  it('mayProceed always allows', () => {
    expect(staticPolicySource.mayProceed({
      kshetra: 'myapp', beadId: 'b-1', agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6',
    })).toEqual({ allowed: true });
  });
});

describe('allEnabledEntitlements (free-tier default)', () => {
  it('reports every capability enabled', () => {
    expect(allEnabledEntitlements.capability('parikshaka')).toBe(true);
    expect(allEnabledEntitlements.capability('anything-at-all')).toBe(true);
  });

  it('reports no limit (unlimited) for any key', () => {
    expect(allEnabledEntitlements.limit('rounds')).toBeNull();
  });
});
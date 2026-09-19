import { describe, it, expect } from 'vitest';
import {
  ABLATIONS, ABLATION_KEYS, AblationConfigSchema,
  isAblated, activeAblations, ablationGuardError, ablationBanner,
  type WithAblation,
} from './ablation.js';

describe('ablation registry + schema (epic 8wi / Study B1)', () => {
  it('exposes the two switches, everything derived from the one registry', () => {
    expect(ABLATION_KEYS).toEqual(['review', 'enforcement']);
    for (const k of ABLATION_KEYS) {
      expect(typeof ABLATIONS[k].description).toBe('string');
      expect(typeof ABLATIONS[k].ledgerLabel).toBe('string');
    }
  });

  it('parses a valid ablation block', () => {
    expect(AblationConfigSchema.parse({ review: 'off' })).toEqual({ review: 'off' });
    expect(AblationConfigSchema.parse({})).toEqual({});
  });

  it('normalizes the YAML boolean `off` (false) to the string "off"', () => {
    // js-yaml parses an unquoted `review: off` as the boolean false.
    expect(AblationConfigSchema.parse({ review: false })).toEqual({ review: 'off' });
  });

  it('rejects an unknown key, naming the bad key AND the valid keys', () => {
    const r = AblationConfigSchema.safeParse({ reveiw: 'off' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map(i => i.message).join(' ');
      expect(msg).toContain('reveiw');
      expect(msg).toContain('review, enforcement'); // valid keys listed
    }
  });

  it('rejects a value other than "off"', () => {
    const r = AblationConfigSchema.safeParse({ review: 'on' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain('must be "off"');
  });
});

describe('isAblated / activeAblations', () => {
  it('reads the block by key only', () => {
    const cfg: WithAblation = { ablation: { review: 'off' } };
    expect(isAblated(cfg, 'review')).toBe(true);
    expect(isAblated(cfg, 'enforcement')).toBe(false);
    expect(isAblated({}, 'review')).toBe(false); // absent block = not ablated
  });

  it('lists active switches in registry order', () => {
    expect(activeAblations({ ablation: { enforcement: 'off', review: 'off' } })).toEqual(['review', 'enforcement']);
    expect(activeAblations({})).toEqual([]);
  });
});

describe('ablationGuardError / ablationBanner', () => {
  it('refuses an ablated config without --allow-ablation, naming the switches', () => {
    const err = ablationGuardError({ ablation: { review: 'off' } }, false);
    expect(err).toContain('review');
    expect(err).toContain('--allow-ablation');
  });

  it('permits it with --allow-ablation, and permits a clean config always', () => {
    expect(ablationGuardError({ ablation: { review: 'off' } }, true)).toBeNull();
    expect(ablationGuardError({}, false)).toBeNull();
  });

  it('produces one banner line per active switch, none when clean', () => {
    expect(ablationBanner({ ablation: { review: 'off' } })).toHaveLength(1);
    expect(ablationBanner({ ablation: { review: 'off' } })[0]).toContain('ABLATION ACTIVE');
    expect(ablationBanner({})).toEqual([]);
  });
});

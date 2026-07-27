import { describe, it, expect } from 'vitest';
import {
  parseMcpToolId,
  isMutationTool,
  grantsInclude,
  selectGrantable,
  addGrant,
  mergeGrants,
  renderGrantPrompt,
  parseGrantAnswer,
} from './grant';
import type { DeniedTool } from './capture';

const denied = (name: string): DeniedTool => ({ name });

describe('parseMcpToolId', () => {
  it('splits an exact mcp id into server + tool', () => {
    expect(parseMcpToolId('mcp__jira__get_issue')).toEqual({ server: 'jira', tool: 'get_issue' });
  });

  it('keeps underscores inside the tool name intact', () => {
    expect(parseMcpToolId('mcp__linear__search_issues')).toEqual({
      server: 'linear',
      tool: 'search_issues',
    });
  });

  it('returns null for a native tool id', () => {
    expect(parseMcpToolId('Write')).toBeNull();
    expect(parseMcpToolId('Bash')).toBeNull();
  });

  it('returns null for a malformed / server-only id', () => {
    expect(parseMcpToolId('mcp__jira')).toBeNull();
    expect(parseMcpToolId('mcp____get_issue')).toBeNull();
    expect(parseMcpToolId('mcp__jira__')).toBeNull();
  });
});

describe('isMutationTool', () => {
  it('flags clearly-mutating leading verbs', () => {
    for (const t of ['create_issue', 'update_issue', 'delete_page', 'transition_issue', 'add_comment', 'set_status']) {
      expect(isMutationTool(t)).toBe(true);
    }
  });

  it('lets read verbs through', () => {
    for (const t of ['get_issue', 'search_issues', 'read_page', 'list_projects', 'fetch_ticket']) {
      expect(isMutationTool(t)).toBe(false);
    }
  });

  it('treats an unrecognized verb as non-mutating (operator is the classifier)', () => {
    expect(isMutationTool('resolve_ticket')).toBe(false);
  });
});

describe('selectGrantable', () => {
  it('offers a denied read tool', () => {
    const out = selectGrantable([denied('mcp__jira__get_issue')], {}, new Set());
    expect(out).toEqual([{ server: 'jira', tool: 'get_issue', id: 'mcp__jira__get_issue' }]);
  });

  it('never offers a mutation verb', () => {
    const out = selectGrantable([denied('mcp__jira__update_issue')], {}, new Set());
    expect(out).toEqual([]);
  });

  it('never offers a wildcard', () => {
    const out = selectGrantable([denied('mcp__jira__*'), denied('mcp__*__get_issue')], {}, new Set());
    expect(out).toEqual([]);
  });

  it('never offers a native (non-mcp) denial', () => {
    const out = selectGrantable([denied('Write'), denied('Bash')], {}, new Set());
    expect(out).toEqual([]);
  });

  it('skips a tool already granted this session', () => {
    const out = selectGrantable([denied('mcp__jira__get_issue')], { jira: ['get_issue'] }, new Set());
    expect(out).toEqual([]);
  });

  it('skips a tool already asked this turn', () => {
    const out = selectGrantable([denied('mcp__jira__get_issue')], {}, new Set(['mcp__jira__get_issue']));
    expect(out).toEqual([]);
  });

  it('dedupes repeated ids, first-seen order', () => {
    const out = selectGrantable(
      [denied('mcp__jira__get_issue'), denied('mcp__jira__get_issue'), denied('mcp__jira__search_issues')],
      {},
      new Set(),
    );
    expect(out.map(g => g.tool)).toEqual(['get_issue', 'search_issues']);
  });
});

describe('addGrant / mergeGrants / grantsInclude', () => {
  it('adds immutably and dedupes', () => {
    const g0: Record<string, string[]> = {};
    const g1 = addGrant(g0, 'jira', 'get_issue');
    expect(g0).toEqual({}); // input untouched
    expect(g1).toEqual({ jira: ['get_issue'] });
    const g2 = addGrant(g1, 'jira', 'get_issue');
    expect(g2).toBe(g1); // no-op returns same ref
    const g3 = addGrant(g1, 'jira', 'search_issues');
    expect(g3).toEqual({ jira: ['get_issue', 'search_issues'] });
  });

  it('merges two maps, deduped per server', () => {
    expect(mergeGrants({ jira: ['get_issue'] }, { jira: ['get_issue', 'search_issues'], linear: ['list'] })).toEqual({
      jira: ['get_issue', 'search_issues'],
      linear: ['list'],
    });
  });

  it('grantsInclude reflects membership', () => {
    expect(grantsInclude({ jira: ['get_issue'] }, 'jira', 'get_issue')).toBe(true);
    expect(grantsInclude({ jira: ['get_issue'] }, 'jira', 'search_issues')).toBe(false);
    expect(grantsInclude({}, 'jira', 'get_issue')).toBe(false);
  });
});

describe('renderGrantPrompt', () => {
  it('names the exact server.tool and offers only [y / always / N]', () => {
    const line = renderGrantPrompt('jira', 'get_issue');
    expect(line).toBe('The turn wanted jira.get_issue — grant it? [y / always / N]');
    expect(line).not.toContain('*');
  });
});

describe('parseGrantAnswer', () => {
  it('maps y/yes → session', () => {
    expect(parseGrantAnswer('y')).toBe('session');
    expect(parseGrantAnswer(' Yes ')).toBe('session');
  });
  it('maps always/a → always', () => {
    expect(parseGrantAnswer('always')).toBe('always');
    expect(parseGrantAnswer('A')).toBe('always');
  });
  it('defaults everything else to deny', () => {
    for (const s of ['', 'n', 'no', 'nope', 'x', 'yeah nah']) {
      expect(parseGrantAnswer(s)).toBe('deny');
    }
  });
});

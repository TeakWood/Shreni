import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  featureTokens,
  locateExistingDocs,
  locateDocsBySource,
  classifyMatches,
  renderCandidateChoice,
  resolveCandidateChoice,
  evolveStateFromOutcome,
  evolveDocTarget,
  diffDocLines,
  renderDocDiff,
  defaultLocateDeps,
  type DocFile,
  type BeadHit,
  type LocateDeps,
  type SourceLocateDeps,
  type LocatedDoc,
} from './evolve';
import { writeDesignDoc, designDocRelPath, withDocLink, resolveDesignDir } from './designdoc';
import type { KshetraConfig } from '../kshetra/config';

const NOW = '2026-07-27T10:00:00.000Z';

function kshetra(repoPath: string): KshetraConfig {
  return {
    id: 'myapp',
    name: 'Myapp',
    repo: { path: repoPath, remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: `${repoPath}-beads`, remote: '', mode: 'embedded' },
    stack: { language: 'typescript' },
    conventions: {},
    agents: { provider: 'anthropic', model: 'claude-opus-4-8', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  } as unknown as KshetraConfig;
}

// A locate-deps fake: a fixed doc list + a scripted bd-search result.
function fakeDeps(docs: DocFile[], hits: BeadHit[] = []): LocateDeps {
  return { listDocs: () => docs, bdSearch: async () => hits };
}

describe('featureTokens', () => {
  it('drops stop-words and short tokens', () => {
    expect(featureTokens('SSO login for the web app')).toEqual(['sso', 'login', 'web', 'app']);
  });
});

describe('locateExistingDocs', () => {
  it('finds a doc by filename match', async () => {
    const docs: DocFile[] = [
      { relPath: '.shreni/design/sso-login.md', content: '# SSO login\nOIDC.' },
      { relPath: '.shreni/design/csv-import.md', content: '# CSV import\nparser.' },
    ];
    const matches = await locateExistingDocs('SSO login', fakeDeps(docs));
    expect(matches).toHaveLength(1);
    expect(matches[0].relPath).toBe('.shreni/design/sso-login.md');
    expect(matches[0].matchedVia).toContain('name');
  });

  it('finds a doc a related bead links, even without a name match', async () => {
    const docs: DocFile[] = [
      { relPath: '.shreni/design/auth.md', content: '# Auth\nsingle sign-on approach.' },
    ];
    const hits: BeadHit[] = [
      { id: 'X.1', title: 'SSO api', description: withDocLink('the api', '.shreni/design/auth.md') },
    ];
    const matches = await locateExistingDocs('single sign-on', fakeDeps(docs, hits));
    expect(matches).toHaveLength(1);
    expect(matches[0].relPath).toBe('.shreni/design/auth.md');
    expect(matches[0].matchedVia).toContain('bead');
    expect(matches[0].linkedBeadIds).toEqual(['X.1']);
  });

  it('merges the fs and bead signals on the same doc and ranks it highest', async () => {
    const docs: DocFile[] = [
      { relPath: '.shreni/design/sso-login.md', content: '# SSO login\nOIDC.' },
      { relPath: '.shreni/design/notes.md', content: '# SSO login mention\nmisc.' },
    ];
    const hits: BeadHit[] = [
      { id: 'X.1', title: 'x', description: withDocLink('d', '.shreni/design/sso-login.md') },
    ];
    const matches = await locateExistingDocs('SSO login', fakeDeps(docs, hits));
    expect(matches[0].relPath).toBe('.shreni/design/sso-login.md');
    expect(matches[0].matchedVia).toEqual(expect.arrayContaining(['name', 'bead']));
  });

  it('returns nothing when no doc matches and no bead links one', async () => {
    const docs: DocFile[] = [{ relPath: '.shreni/design/billing.md', content: '# Billing' }];
    const matches = await locateExistingDocs('SSO login', fakeDeps(docs));
    expect(matches).toEqual([]);
  });

  it('degrades to the fs signal when bd search throws', async () => {
    const docs: DocFile[] = [{ relPath: '.shreni/design/sso-login.md', content: '# SSO login' }];
    const deps: LocateDeps = { listDocs: () => docs, bdSearch: async () => { throw new Error('bd down'); } };
    const matches = await locateExistingDocs('SSO login', deps);
    expect(matches).toHaveLength(1);
  });
});

// A source-locate-deps fake: a fixed doc list + a scripted external-ref search.
function fakeSourceDeps(docs: DocFile[], hits: BeadHit[] = []): SourceLocateDeps {
  return { listDocs: () => docs, bdSearchByExternalRef: async () => hits };
}

describe('locateDocsBySource (pmb.7)', () => {
  it('finds the doc a prior consult filed, via a bead carrying the external ref', async () => {
    const docs: DocFile[] = [
      { relPath: '.shreni/design/sso-login.md', content: '# SSO login\nOIDC.' },
    ];
    const hits: BeadHit[] = [
      { id: 'X.1', title: 'epic', description: withDocLink('the epic', '.shreni/design/sso-login.md') },
    ];
    const matches = await locateDocsBySource('jira:PROJ-123', fakeSourceDeps(docs, hits));
    expect(matches).toHaveLength(1);
    expect(matches[0].relPath).toBe('.shreni/design/sso-login.md');
    expect(matches[0].matchedVia).toEqual(['bead']);
    expect(matches[0].linkedBeadIds).toEqual(['X.1']);
  });

  it('merges several beads pointing at the same doc, strengthening the match', async () => {
    const docs: DocFile[] = [{ relPath: '.shreni/design/a.md', content: '# A' }];
    const hits: BeadHit[] = [
      { id: 'X', title: 'epic', description: withDocLink('e', '.shreni/design/a.md') },
      { id: 'X.1', title: 'child', description: withDocLink('c', '.shreni/design/a.md') },
    ];
    const matches = await locateDocsBySource('jira:PROJ-1', fakeSourceDeps(docs, hits));
    expect(matches).toHaveLength(1);
    expect(matches[0].linkedBeadIds).toEqual(['X', 'X.1']);
  });

  it('returns nothing on the first consult (no bead carries the ref yet)', async () => {
    const docs: DocFile[] = [{ relPath: '.shreni/design/a.md', content: '# A' }];
    expect(await locateDocsBySource('jira:NEW-1', fakeSourceDeps(docs, []))).toEqual([]);
  });

  it('skips a bead whose linked doc is no longer on disk', async () => {
    const hits: BeadHit[] = [
      { id: 'X.1', title: 't', description: withDocLink('d', '.shreni/design/gone.md') },
    ];
    expect(await locateDocsBySource('jira:PROJ-1', fakeSourceDeps([], hits))).toEqual([]);
  });

  it('degrades to no matches when the external-ref search throws', async () => {
    const deps: SourceLocateDeps = {
      listDocs: () => [{ relPath: '.shreni/design/a.md', content: '# A' }],
      bdSearchByExternalRef: async () => { throw new Error('bd down'); },
    };
    expect(await locateDocsBySource('jira:PROJ-1', deps)).toEqual([]);
  });
});

describe('classifyMatches', () => {
  const doc = (relPath: string, score: number): LocatedDoc => ({
    relPath, content: 'x', matchedVia: ['name'], linkedBeadIds: [], score,
  });

  it('none → create fresh', () => {
    expect(classifyMatches([])).toEqual({ kind: 'none' });
  });

  it('single → evolve it', () => {
    const out = classifyMatches([doc('a.md', 10)]);
    expect(out.kind).toBe('one');
  });

  it('a dominant top match collapses to one even with a weak runner-up', () => {
    const out = classifyMatches([doc('a.md', 10), doc('b.md', 2)]);
    expect(out).toMatchObject({ kind: 'one', doc: { relPath: 'a.md' } });
  });

  it('two comparable matches → ask which', () => {
    const out = classifyMatches([doc('a.md', 10), doc('b.md', 8)]);
    expect(out.kind).toBe('many');
  });
});

describe('renderCandidateChoice / resolveCandidateChoice', () => {
  const candidates = ['.shreni/design/sso-login.md', '.shreni/design/auth.md'];

  it('numbers each option plus a "create new" tail', () => {
    const doc = (relPath: string): LocatedDoc => ({ relPath, content: '', matchedVia: ['name'], linkedBeadIds: [], score: 5 });
    const text = renderCandidateChoice([doc(candidates[0]), doc(candidates[1])]);
    expect(text).toContain('1. .shreni/design/sso-login.md');
    expect(text).toContain('2. .shreni/design/auth.md');
    expect(text).toContain('3. None of these');
  });

  it('resolves a 1-based index to a path', () => {
    expect(resolveCandidateChoice(candidates, '2')).toEqual({ chosen: candidates[1] });
  });

  it('resolves the "none" tail index to create-new (null)', () => {
    expect(resolveCandidateChoice(candidates, '3')).toEqual({ chosen: null });
  });

  it('resolves a unique path substring', () => {
    expect(resolveCandidateChoice(candidates, 'sso-login')).toEqual({ chosen: candidates[0] });
  });

  it('resolves the word "new"/"none" to create-new', () => {
    expect(resolveCandidateChoice(candidates, 'none of these, make a new one')).toEqual({ chosen: null });
  });

  it('returns undefined for an unrecognizable reply', () => {
    expect(resolveCandidateChoice(candidates, 'hmm not sure')).toEqual({ chosen: undefined });
    expect(resolveCandidateChoice(candidates, '99')).toEqual({ chosen: undefined });
  });
});

describe('evolveStateFromOutcome', () => {
  it('one → target + content snapshot', () => {
    const out = classifyMatches([{ relPath: 'a.md', content: 'body', matchedVia: ['name'], linkedBeadIds: [], score: 9 }]);
    expect(evolveStateFromOutcome('feat', out, NOW)).toEqual({
      feature: 'feat', targetRelPath: 'a.md', targetContent: 'body', locatedAt: NOW,
    });
  });

  it('many → candidates parked, no target', () => {
    const many = classifyMatches([
      { relPath: 'a.md', content: '', matchedVia: ['name'], linkedBeadIds: [], score: 10 },
      { relPath: 'b.md', content: '', matchedVia: ['name'], linkedBeadIds: [], score: 9 },
    ]);
    expect(evolveStateFromOutcome('feat', many, NOW)).toEqual({
      feature: 'feat', candidates: ['a.md', 'b.md'], locatedAt: NOW,
    });
  });

  it('none → null (a new-feature interview)', () => {
    expect(evolveStateFromOutcome('feat', { kind: 'none' }, NOW)).toBeNull();
  });
});

describe('evolveDocTarget', () => {
  it('returns the existing doc path when evolving', () => {
    expect(evolveDocTarget('SSO login', { targetRelPath: '.shreni/design/auth.md', locatedAt: NOW }))
      .toBe('.shreni/design/auth.md');
  });

  it('falls back to a fresh slug when not evolving', () => {
    expect(evolveDocTarget('SSO login', null)).toBe(designDocRelPath('SSO login'));
    expect(evolveDocTarget('SSO login', undefined)).toBe('.shreni/design/sso-login.md');
    // candidates-only (no target chosen yet) → still fresh
    expect(evolveDocTarget('SSO login', { candidates: ['a.md'], locatedAt: NOW }))
      .toBe('.shreni/design/sso-login.md');
  });
});

describe('diffDocLines / renderDocDiff', () => {
  it('marks added, removed, and context lines', () => {
    const diff = diffDocLines('a\nb\nc', 'a\nB\nc');
    expect(diff).toEqual([
      { tag: ' ', text: 'a' },
      { tag: '-', text: 'b' },
      { tag: '+', text: 'B' },
      { tag: ' ', text: 'c' },
    ]);
  });

  it('renders a fenced diff header for an evolve', () => {
    const text = renderDocDiff('# SSO\napproach: SAML', '# SSO\napproach: OIDC', '.shreni/design/sso.md');
    expect(text).toContain('Design doc changes (.shreni/design/sso.md):');
    expect(text).toContain('```diff');
    expect(text).toContain('- approach: SAML');
    expect(text).toContain('+ approach: OIDC');
  });

  it('renders a new-doc header when there is no prior content', () => {
    const text = renderDocDiff('', '# New\nbody', '.shreni/design/new.md');
    expect(text).toContain('New design doc: .shreni/design/new.md');
    expect(text).toContain('+ # New');
  });
});

// The acceptance criterion end-to-end: a second design pass on a feature updates
// the ORIGINAL doc rather than creating a duplicate.
describe('evolve end-to-end — second pass updates the same file (no fork)', () => {
  const REPO = mkdtempSync(join(tmpdir(), 'suthradhara-evolve-'));
  const k = kshetra(REPO);

  afterEach(() => rmSync(resolveDesignDir(k), { recursive: true, force: true }));

  it('locates the existing doc and rewrites it in place — one file, not two', async () => {
    // First pass: create the doc as a brand-new feature would.
    const rel = evolveDocTarget('SSO login', null);
    writeDesignDoc({ kshetra: k, relPath: rel, content: '# SSO login\n\nApproach: SAML.' });

    // Second pass: locate against the real filesystem.
    const deps = { listDocs: defaultLocateDeps(k).listDocs, bdSearch: async () => [] };
    const matches = await locateExistingDocs('SSO login', deps);
    const outcome = classifyMatches(matches);
    expect(outcome.kind).toBe('one');

    const evolving = evolveStateFromOutcome('SSO login', outcome, NOW);
    const target = evolveDocTarget('SSO login', evolving);
    expect(target).toBe(rel); // SAME path, not a new slug

    // Rewrite in place with the evolved content.
    writeDesignDoc({ kshetra: k, relPath: target, content: '# SSO login\n\nApproach: OIDC (was SAML).' });

    // Exactly one doc on disk — no parallel/stale file was created.
    const files = readdirSync(resolveDesignDir(k));
    expect(files).toEqual(['sso-login.md']);
  });
});

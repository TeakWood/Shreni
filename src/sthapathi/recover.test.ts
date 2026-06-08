import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockList = vi.fn<() => Promise<string>>();
const mockAddNote = vi.fn<() => Promise<string>>();
const mockClose = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ list: mockList, addNote: mockAddNote, close: mockClose })),
  syncBeads: mockSyncBeads,
}));

const mockBranchExists = vi.fn<() => Promise<boolean>>();
const mockCreateBranch = vi.fn<() => Promise<string>>();
const mockIsAncestor = vi.fn<() => Promise<boolean>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({
    branchExists: mockBranchExists,
    createBranch: mockCreateBranch,
    isAncestor: mockIsAncestor,
  })),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const { recoverKshetra, parseLastNote } = await import('./recover.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: '', mainBranch: 'main' },
  beads: { path: '/projects/sishya-beads', remote: '' },
  agents: { maxRoundsPerBead: 3 },
} as unknown as KshetraConfig;

function makeIssueJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bead-42',
    slug: 'fix-bug',
    title: 'Fix bug',
    priority: 1,
    round: 1,
    status: 'in_progress',
    notes: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue('[]');
  mockAddNote.mockResolvedValue('ok');
  mockClose.mockResolvedValue('ok');
  mockSyncBeads.mockResolvedValue(undefined);
  mockBranchExists.mockResolvedValue(true);
  mockCreateBranch.mockResolvedValue('bead-42/fix-bug');
  mockIsAncestor.mockResolvedValue(false);
});

// ── parseLastNote ─────────────────────────────────────────────────────────────

describe('parseLastNote', () => {
  it('returns empty string for undefined notes', () => {
    expect(parseLastNote(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(parseLastNote('')).toBe('');
  });

  it('returns the last non-empty line', () => {
    expect(parseLastNote('Round 1: dispatching Silpi\nRound 1: Silpi submitted')).toBe(
      'Round 1: Silpi submitted',
    );
  });

  it('handles trailing newlines', () => {
    expect(parseLastNote('Round 1: dispatching Silpi\n')).toBe('Round 1: dispatching Silpi');
  });
});

// ── recoverKshetra ────────────────────────────────────────────────────────────

describe('recoverKshetra', () => {
  it('does nothing when no in-progress tasks', async () => {
    mockList.mockResolvedValue('[]');
    await recoverKshetra(KSHETRA);
    expect(mockAddNote).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('creates branch and schedules silpi when last note is "claiming" and no branch', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([makeIssueJson({ notes: 'claiming bead-42' })]),
    );
    mockBranchExists.mockResolvedValue(false);

    await recoverKshetra(KSHETRA);
    expect(mockCreateBranch).toHaveBeenCalled();
  });

  it('adds resuming note when last note is "dispatching Silpi"', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([makeIssueJson({ notes: 'Round 1: dispatching Silpi', round: 1 })]),
    );

    await recoverKshetra(KSHETRA);
    expect(mockAddNote).toHaveBeenCalledWith(
      'bead-42',
      expect.stringContaining('resuming Silpi after restart'),
    );
  });

  it('adds resuming note when last note is "Silpi submitted"', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([makeIssueJson({ notes: 'Round 1: Silpi submitted', round: 1 })]),
    );

    await recoverKshetra(KSHETRA);
    expect(mockAddNote).toHaveBeenCalledWith(
      'bead-42',
      expect.stringContaining('resuming at Viharapala after restart'),
    );
  });

  it('adds resuming note when last note is "dispatching Viharapala"', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([makeIssueJson({ notes: 'Round 1: dispatching Viharapala', round: 1 })]),
    );

    await recoverKshetra(KSHETRA);
    expect(mockAddNote).toHaveBeenCalledWith(
      'bead-42',
      expect.stringContaining('resuming Viharapala after restart'),
    );
  });

  it('closes task when APPROVE and branch already merged', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([makeIssueJson({ notes: 'Round 1: APPROVE' })]),
    );
    mockIsAncestor.mockResolvedValue(true);

    await recoverKshetra(KSHETRA);
    expect(mockClose).toHaveBeenCalledWith('bead-42', expect.stringContaining('Recovered'));
    expect(mockSyncBeads).toHaveBeenCalled();
  });

  it('schedules merge (no close) when APPROVE but branch not yet merged', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([makeIssueJson({ notes: 'Round 1: APPROVE' })]),
    );
    mockIsAncestor.mockResolvedValue(false);

    await recoverKshetra(KSHETRA);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('does not add note when task is blocked/failed (no known note pattern)', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([makeIssueJson({ notes: 'Round 1: Silpi failed after retries — timeout' })]),
    );

    await recoverKshetra(KSHETRA);
    expect(mockAddNote).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('schedules silpi resume when last note is API unavailable', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([makeIssueJson({ notes: 'Paused: API unavailable — timeout. Will retry.' })]),
    );

    // Just verify it doesn't add a "blocked" skip note (it schedules resume instead)
    await recoverKshetra(KSHETRA);
    expect(mockAddNote).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('handles malformed bd list output gracefully', async () => {
    mockList.mockResolvedValue('not-json');
    await expect(recoverKshetra(KSHETRA)).resolves.not.toThrow();
  });

  it('recovers multiple in-flight tasks', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([
        makeIssueJson({ id: 'bead-1', slug: 'task-1', notes: 'Round 1: dispatching Silpi', round: 1 }),
        makeIssueJson({ id: 'bead-2', slug: 'task-2', notes: 'Round 2: dispatching Viharapala', round: 2 }),
      ]),
    );

    await recoverKshetra(KSHETRA);
    expect(mockAddNote).toHaveBeenCalledTimes(2);
    expect(mockAddNote).toHaveBeenCalledWith('bead-1', expect.stringContaining('resuming Silpi'));
    expect(mockAddNote).toHaveBeenCalledWith('bead-2', expect.stringContaining('resuming Viharapala'));
  });
});
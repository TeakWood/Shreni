import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

// promisify reads execFile from the mocked module; wire it up
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: (fn: unknown) => fn === mockExecFile
      ? (...args: unknown[]) => {
          // last arg is callback — strip it, resolve from mock
          const [cmd, cmdArgs, opts] = args as [string, string[], object];
          return mockExecFile(cmd, cmdArgs, opts);
        }
      : actual.promisify(fn as (...a: unknown[]) => unknown),
  };
});

const mockWriteFileSync = vi.fn();
const mockAppendFileSync = vi.fn();
const mockSymlinkSync = vi.fn();
const mockExistsSync = vi.fn<(p: string) => boolean>().mockReturnValue(false);
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn<() => string>().mockReturnValue('');
const mockReadlinkSync = vi.fn<(p: string) => string>().mockImplementation(() => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
});
vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  appendFileSync: mockAppendFileSync,
  symlinkSync: mockSymlinkSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  readlinkSync: mockReadlinkSync,
}));

const mockRegisterKshetra = vi.fn();
vi.mock('../kshetra/registry', () => ({ registerKshetra: mockRegisterKshetra }));

// Preflight probes the real filesystem/PATH; stub it so the orchestrator tests
// exercise the write path rather than the (mocked-false) CLI-present check. The
// resolver + preflight are unit-tested directly (resolveAgents here,
// checkProviderInstalled in provider-preflight.test.ts).
const mockCheckProviderInstalled = vi.fn(() => ({ ok: true, bin: 'claude' }));
const mockPromptProvider = vi.fn(async () => 'claude');
// commandExists backs smokeCheckToolchain; default "present" so the orchestrator
// tests emit no toolchain warnings. Smoke-check tests drive it explicitly.
const mockCommandExists = vi.fn<(bin: string) => boolean>().mockReturnValue(true);
vi.mock('./provider-preflight', () => ({
  checkProviderInstalled: (...a: unknown[]) => mockCheckProviderInstalled(...(a as [])),
  promptProvider: () => mockPromptProvider(),
  commandExists: (bin: string) => mockCommandExists(bin),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const {
  ensureAppRepo,
  createGitHubRepo,
  cloneBeadsRepo,
  initBeadsDb,
  createBeadsSymlink,
  addToGitignore,
  setupClaudeHooks,
  generateKshetraYaml,
  writeKshetraConfig,
  scaffoldConventions,
  smokeCheckToolchain,
  appendShreniIntegration,
  createRagIndexStub,
  registerWithSthapathi,
  resolveAgents,
  initKshetra,
  SHRENI_SECTION,
} = await import('./init-kshetra');

// ── helpers ───────────────────────────────────────────────────────────────────

function resolveExec(stdout: string) {
  mockExecFile.mockResolvedValue({ stdout, stderr: '' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
  mockReadlinkSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  resolveExec('');
});

// ── Step 0: ensureAppRepo (yds.11) ───────────────────────────────────────────

describe('ensureAppRepo', () => {
  it('is a no-op when the repo already has an origin remote', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.git'));
    resolveExec('git@github.com:TeakWood/myapp.git');
    await ensureAppRepo('TeakWood', 'myapp', '/repos/myapp');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['remote', 'get-url', 'origin'], expect.objectContaining({ cwd: '/repos/myapp' }),
    );
  });

  it('scaffolds the zero-repo case: git init, gh repo create, origin, initial commit, push', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFile
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git init -b main
      .mockRejectedValueOnce(new Error('no origin'))                // git remote get-url origin
      .mockRejectedValueOnce(new Error('not found'))                // gh repo view
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // gh repo create
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git remote add origin
      .mockRejectedValueOnce(new Error('unborn HEAD'))              // git rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git add -A
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git commit
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' })      // git rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' });           // git push -u origin main

    await ensureAppRepo('Acme', 'myapp', '/repos/myapp');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['init', '-b', 'main'], expect.objectContaining({ cwd: '/repos/myapp' }),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh', ['repo', 'create', 'Acme/myapp', '--private', '--confirm'], expect.any(Object),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['remote', 'add', 'origin', 'git@github.com:Acme/myapp.git'],
      expect.objectContaining({ cwd: '/repos/myapp' }),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['commit', '--allow-empty', '-m', 'chore: initial commit (shreni init)'],
      expect.objectContaining({ cwd: '/repos/myapp' }),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['push', '-u', 'origin', 'main'], expect.objectContaining({ cwd: '/repos/myapp' }),
    );
  });

  it('wires an existing local repo with commits: no git init, no gh create, no extra commit', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.git'));
    mockExecFile
      .mockRejectedValueOnce(new Error('no origin'))                // git remote get-url origin
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // gh repo view → exists
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git remote add origin
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })    // git rev-parse HEAD → has commits
      .mockResolvedValueOnce({ stdout: 'trunk\n', stderr: '' })     // git rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' });           // git push -u origin trunk

    await ensureAppRepo('TeakWood', 'myapp', '/repos/myapp');

    const cmds = mockExecFile.mock.calls.map(c => `${c[0]} ${(c[1] as string[]).join(' ')}`);
    expect(cmds).not.toContain('git init -b main');
    expect(cmds.some(c => c.startsWith('gh repo create'))).toBe(false);
    expect(cmds.some(c => c.startsWith('git commit'))).toBe(false);
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['push', '-u', 'origin', 'trunk'], expect.objectContaining({ cwd: '/repos/myapp' }),
    );
  });
});

// ── Step 1: createGitHubRepo ──────────────────────────────────────────────────

describe('createGitHubRepo', () => {
  it('calls gh repo create when the remote repo does not yet exist', async () => {
    mockExecFile
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { exitCode: 1 }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const url = await createGitHubRepo('TeakWood', 'myapp');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['repo', 'create', 'TeakWood/myapp-beads', '--private', '--confirm'],
      expect.any(Object),
    );
    expect(url).toBe('git@github.com:TeakWood/myapp-beads.git');
  });

  it('skips gh repo create and returns URL when remote repo already exists', async () => {
    resolveExec('');
    const url = await createGitHubRepo('TeakWood', 'myapp');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).not.toHaveBeenCalledWith(
      'gh', expect.arrayContaining(['create']), expect.any(Object),
    );
    expect(url).toBe('git@github.com:TeakWood/myapp-beads.git');
  });
});

// ── Step 2: cloneBeadsRepo ────────────────────────────────────────────────────

describe('cloneBeadsRepo', () => {
  it('calls git clone with the remote URL and local path', async () => {
    resolveExec('');
    await cloneBeadsRepo('git@github.com:TeakWood/myapp-beads.git', '/repos/myapp-beads');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['clone', 'git@github.com:TeakWood/myapp-beads.git', '/repos/myapp-beads'],
      expect.any(Object),
    );
  });

  it('skips git clone when local path already exists', async () => {
    mockExistsSync.mockReturnValue(true);
    await cloneBeadsRepo('git@github.com:TeakWood/myapp-beads.git', '/repos/myapp-beads');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ── Step 3: initBeadsDb ───────────────────────────────────────────────────────

describe('initBeadsDb', () => {
  it('calls bd init --stealth with BEADS_DIR env and cwd set', async () => {
    resolveExec('');
    await initBeadsDb('/repos/myapp-beads');
    expect(mockExecFile).toHaveBeenCalledWith(
      'bd',
      ['init', '--stealth'],
      expect.objectContaining({
        cwd: '/repos/myapp-beads',
        env: expect.objectContaining({ BEADS_DIR: '/repos/myapp-beads' }),
      }),
    );
  });

  it('skips bd init when .dolt directory already exists', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.dolt'));
    await initBeadsDb('/repos/myapp-beads');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ── Step 4: createBeadsSymlink ────────────────────────────────────────────────

describe('createBeadsSymlink', () => {
  it('creates a symlink at <repoPath>/.beads pointing to the absolute beads path', () => {
    createBeadsSymlink('/repos/myapp', '/repos/myapp-beads');
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      '/repos/myapp-beads',
      join('/repos/myapp', '.beads'),
    );
  });

  it('skips symlinkSync when symlink already points to the correct target', () => {
    mockReadlinkSync.mockReturnValue('/repos/myapp-beads');
    createBeadsSymlink('/repos/myapp', '/repos/myapp-beads');
    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it('throws when symlink exists but points to a different path', () => {
    mockReadlinkSync.mockReturnValue('/repos/other-beads');
    expect(() => createBeadsSymlink('/repos/myapp', '/repos/myapp-beads')).toThrow(
      /\.beads symlink exists but points to/,
    );
    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });
});

// ── Step 5: addToGitignore ────────────────────────────────────────────────────

describe('addToGitignore', () => {
  it('creates .gitignore with .beads and the machine-specific config when absent', () => {
    mockExistsSync.mockReturnValue(false);
    addToGitignore('/repos/myapp');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.gitignore'),
      '.beads\n.shreni/kshetra.yaml\n',
      'utf8',
    );
  });

  it('ignores only .shreni/kshetra.yaml, not the whole .shreni dir (conventions docs stay tracked)', () => {
    mockExistsSync.mockReturnValue(false);
    addToGitignore('/repos/myapp');
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    expect(written).toContain('.shreni/kshetra.yaml');
    expect(written).not.toMatch(/^\.shreni\/?$/m);
  });

  it('appends only the missing markers when .gitignore exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('node_modules\n.beads\n');
    addToGitignore('/repos/myapp');
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.gitignore'),
      '.shreni/kshetra.yaml\n',
      'utf8',
    );
  });

  it('skips entirely when both markers are already present', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('node_modules\n.beads\n.shreni/kshetra.yaml\n');
    addToGitignore('/repos/myapp');
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('inserts a leading newline when the existing file lacks a trailing one', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('node_modules');
    addToGitignore('/repos/myapp');
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.gitignore'),
      '\n.beads\n.shreni/kshetra.yaml\n',
      'utf8',
    );
  });
});

// ── Step 6: setupClaudeHooks ──────────────────────────────────────────────────

describe('setupClaudeHooks', () => {
  it('calls bd setup claude with cwd=repoPath and BEADS_DIR env', async () => {
    resolveExec('');
    await setupClaudeHooks('/repos/myapp', '/repos/myapp-beads');
    expect(mockExecFile).toHaveBeenCalledWith(
      'bd',
      ['setup', 'claude'],
      expect.objectContaining({
        cwd: '/repos/myapp',
        env: expect.objectContaining({ BEADS_DIR: '/repos/myapp-beads' }),
      }),
    );
  });
});

// ── Step 7: generateKshetraYaml ───────────────────────────────────────────────

describe('generateKshetraYaml', () => {
  const OPTS = {
    slug: 'my-app',
    repoPath: '/repos/my-app',
    repoRemote: 'git@github.com:TeakWood/my-app.git',
    beadsPath: '/repos/my-app-beads',
    beadsRemote: 'git@github.com:TeakWood/my-app-beads.git',
    language: 'typescript',
  };

  it('contains the slug as the id', () => {
    expect(generateKshetraYaml(OPTS)).toContain('id: my-app');
  });

  it('title-cases the slug for the name field', () => {
    expect(generateKshetraYaml(OPTS)).toContain('name: My App');
  });

  it('includes repo path and remote', () => {
    const out = generateKshetraYaml(OPTS);
    expect(out).toContain('/repos/my-app');
    expect(out).toContain('git@github.com:TeakWood/my-app.git');
  });

  it('includes beads path, remote, and mode: embedded', () => {
    const out = generateKshetraYaml(OPTS);
    expect(out).toContain('/repos/my-app-beads');
    expect(out).toContain('mode: embedded');
  });

  it('sets the default model and maxRoundsPerBead', () => {
    const out = generateKshetraYaml(OPTS);
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('maxRoundsPerBead: 3');
  });

  it('writes a detected node toolchain profile (packageManager + commands)', () => {
    const out = generateKshetraYaml({
      ...OPTS,
      language: undefined,
      stack: {
        language: 'typescript',
        packageManager: 'pnpm',
        buildCommand: 'pnpm build',
        testRunner: 'pnpm test',
        lintCommand: '',
        unknown: false,
      },
    });
    expect(out).toContain('packageManager: pnpm');
    expect(out).toContain('buildCommand: pnpm build');
    expect(out).toContain('testRunner: pnpm test');
  });

  it('adds an inline TODO marker for an unknown ecosystem', () => {
    const out = generateKshetraYaml({
      ...OPTS,
      language: undefined,
      stack: { language: 'unknown', buildCommand: '', testRunner: '', lintCommand: '', unknown: true },
    });
    expect(out).toMatch(/language: unknown\s+# TODO/);
  });

  it('writes kshetra.yaml under <repoPath>/.shreni/', () => {
    writeKshetraConfig('/repos/myapp', 'id: myapp\n');
    expect(mockMkdirSync).toHaveBeenCalledWith(join('/repos/myapp', '.shreni'), { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.shreni', 'kshetra.yaml'),
      'id: myapp\n',
      'utf8',
    );
  });

  it('returns the .shreni config path', () => {
    expect(writeKshetraConfig('/repos/myapp', 'id: myapp\n')).toBe(
      join('/repos/myapp', '.shreni', 'kshetra.yaml'),
    );
  });

  it('emits a conventions block pointing at the scaffolded stubs', () => {
    const out = generateKshetraYaml({
      ...OPTS,
      conventions: { styleGuide: '.shreni/style-guide.md', architecture: '.shreni/arch.md' },
    });
    expect(out).toContain('conventions:');
    expect(out).toContain('styleGuide: .shreni/style-guide.md');
    expect(out).toContain('architecture: .shreni/arch.md');
  });

  it('omits the conventions block when no docs are provided', () => {
    expect(generateKshetraYaml(OPTS)).not.toContain('conventions:');
  });

  it('writes the selected provider and model into the agents block', () => {
    const out = generateKshetraYaml({ ...OPTS, agents: { provider: 'openai', model: 'gpt-x' } });
    expect(out).toContain('provider: openai');
    expect(out).toContain('model: gpt-x');
  });

  it('defaults the agents block to the claude profile', () => {
    const out = generateKshetraYaml(OPTS);
    expect(out).toContain('provider: anthropic');
    expect(out).toContain('model: claude-sonnet-4-6');
  });
});

// ── scaffoldConventions ───────────────────────────────────────────────────────

describe('scaffoldConventions', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
  });

  it('creates .shreni/style-guide.md and .shreni/arch.md stubs', () => {
    scaffoldConventions('/repos/myapp');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.shreni', 'style-guide.md'),
      expect.stringContaining('# Style Guide'),
      'utf8',
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.shreni', 'arch.md'),
      expect.stringContaining('# Architecture'),
      'utf8',
    );
  });

  it('returns repo-relative pointers for the config', () => {
    expect(scaffoldConventions('/repos/myapp')).toEqual({
      styleGuide: join('.shreni', 'style-guide.md'),
      architecture: join('.shreni', 'arch.md'),
    });
  });

  it('does not clobber existing conventions docs', () => {
    mockExistsSync.mockReturnValue(true);
    scaffoldConventions('/repos/myapp');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

// ── smokeCheckToolchain (§3.6.5, warn-only) ───────────────────────────────────

describe('smokeCheckToolchain', () => {
  const STACK = {
    language: 'typescript',
    packageManager: 'pnpm',
    buildCommand: 'pnpm build',
    testRunner: 'pnpm test',
    lintCommand: '',
    unknown: false,
  };

  it('returns no warnings when the gate tools are on PATH', () => {
    mockCommandExists.mockReturnValue(true);
    expect(smokeCheckToolchain(STACK)).toEqual([]);
  });

  it('warns (non-fatally) for a build/test tool missing from PATH', () => {
    mockCommandExists.mockReturnValue(false);
    const warnings = smokeCheckToolchain(STACK);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('stack.buildCommand');
    expect(warnings[0]).toContain('pnpm');
    expect(warnings.join('\n')).toContain('stack.testRunner');
    expect(warnings.join('\n')).toContain('.shreni/kshetra.yaml');
  });

  it('probes only the leading binary of each command', () => {
    mockCommandExists.mockReturnValue(true);
    smokeCheckToolchain(STACK);
    expect(mockCommandExists).toHaveBeenCalledWith('pnpm');
    expect(mockCommandExists).not.toHaveBeenCalledWith('build');
  });

  it('skips explicitly-skipped ("") and undefined gates', () => {
    mockCommandExists.mockReturnValue(false);
    const warnings = smokeCheckToolchain({
      language: 'unknown',
      buildCommand: '',
      testRunner: undefined,
      lintCommand: '',
      unknown: true,
    });
    expect(warnings).toEqual([]);
    expect(mockCommandExists).not.toHaveBeenCalled();
  });
});

// ── resolveAgents (provider selection §3.5) ───────────────────────────────────

describe('resolveAgents', () => {
  it('defaults to claude/anthropic with the registry default model', () => {
    expect(resolveAgents({})).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('maps the CLI-facing provider name to the internal enum', () => {
    expect(resolveAgents({ provider: 'claude' }).provider).toBe('anthropic');
    expect(resolveAgents({ provider: 'codex', model: 'gpt-x' }).provider).toBe('openai');
  });

  it('throws with the valid set on an invalid provider', () => {
    expect(() => resolveAgents({ provider: 'bogus' })).toThrow(/Valid providers: claude, codex, gemini/);
  });

  it('requires an explicit --model for a provider with no default (codex/gemini)', () => {
    expect(() => resolveAgents({ provider: 'gemini' })).toThrow(/no default model/);
    expect(resolveAgents({ provider: 'gemini', model: 'gemini-x' }).model).toBe('gemini-x');
  });

  it('lets an explicit --model override the registry default for claude', () => {
    expect(resolveAgents({ provider: 'claude', model: 'claude-opus-4-8' }).model).toBe('claude-opus-4-8');
  });
});

// ── Step 8: appendShreniIntegration ──────────────────────────────────────────

describe('SHRENI_SECTION content', () => {
  it('states the task-producer-only role boundary', () => {
    expect(SHRENI_SECTION).toContain('task producer only');
  });

  // Native execution (sw8.6) loads this file into the unattended agents too, so
  // the block must carve them out of the interactive-only prohibitions.
  it('carves out the Sthapathi-dispatched agents from the interactive rules', () => {
    expect(SHRENI_SECTION).toContain('does NOT apply to you');
    expect(SHRENI_SECTION).toMatch(/Silpi\/Viharapala\/Parikshaka/);
    expect(SHRENI_SECTION).toContain('Interactive sessions: task producer only');
  });

  it('lists bd update --claim as prohibited', () => {
    expect(SHRENI_SECTION).toContain('bd update --claim');
  });

  it('lists bd close as prohibited', () => {
    expect(SHRENI_SECTION).toContain('bd close');
  });

  it('lists git branch operations as prohibited', () => {
    expect(SHRENI_SECTION).toMatch(/git checkout.*-b|git branch/);
  });

  // sw8.5(b): the block must tell devs/agents to keep the config pointers in sync
  // with the real toolchain files.
  it('has a Toolchain config sync subsection naming .shreni/kshetra.yaml', () => {
    expect(SHRENI_SECTION).toContain('Toolchain config sync');
    expect(SHRENI_SECTION).toContain('.shreni/kshetra.yaml');
  });

  it('names the buildCommand/testRunner/lintCommand pointer fields', () => {
    expect(SHRENI_SECTION).toContain('stack.buildCommand');
    expect(SHRENI_SECTION).toContain('stack.testRunner');
    expect(SHRENI_SECTION).toContain('stack.lintCommand');
  });

  it('prefers project scripts over duplicated globs (escape hatches last)', () => {
    expect(SHRENI_SECTION).toMatch(/testFileGlobs|failCountPattern/);
    expect(SHRENI_SECTION).toContain('project script');
  });
});

describe('appendShreniIntegration', () => {
  it('appends the SHRENI INTEGRATION section to CLAUDE.md', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('# Existing content\n');
    appendShreniIntegration('/repos/myapp');
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', 'CLAUDE.md'),
      expect.stringContaining('SHRENI INTEGRATION'),
      'utf8',
    );
  });

  it('creates CLAUDE.md if it does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    appendShreniIntegration('/repos/myapp');
    expect(mockAppendFileSync).toHaveBeenCalled();
  });

  it('skips if SHRENI INTEGRATION already present', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('## SHRENI INTEGRATION\nalready here\n');
    appendShreniIntegration('/repos/myapp');
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});

// ── Step 9: createRagIndexStub ────────────────────────────────────────────────

describe('createRagIndexStub', () => {
  it('creates ~/.shreni/rag/<slug>/index.json with empty chunks', () => {
    createRagIndexStub('my-app');
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(join('.shreni', 'rag', 'my-app')),
      { recursive: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('index.json'),
      expect.stringContaining('"chunks"'),
      'utf8',
    );
  });

  it('skips writing if index.json already exists', () => {
    mockExistsSync.mockReturnValue(true);
    createRagIndexStub('my-app');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

// ── Step 10: registerWithSthapathi ────────────────────────────────────────────

describe('registerWithSthapathi', () => {
  it('calls registerKshetra with slug and configPath', () => {
    registerWithSthapathi('my-app', '/repos/my-app/kshetra.yaml');
    expect(mockRegisterKshetra).toHaveBeenCalledWith('my-app', '/repos/my-app/kshetra.yaml');
  });
});

// ── initKshetra orchestrator ──────────────────────────────────────────────────

describe('initKshetra', () => {
  beforeEach(() => {
    // App repo phase no-ops: .git exists and origin resolves.
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.git'));
    // App-repo origin check, gh repo view (exists→skip create), git clone,
    // bd init, bd setup claude, git remote
    mockExecFile
      .mockResolvedValueOnce({ stdout: 'git@github.com:TeakWood/myapp.git\n', stderr: '' }) // App repo: origin exists
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // gh repo view → repo exists
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // git clone
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // bd init
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // bd setup claude
      .mockResolvedValueOnce({ stdout: 'git@github.com:TeakWood/myapp.git\n', stderr: '' }) // git remote
      .mockResolvedValue({ stdout: '', stderr: '' });      // any subsequent
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('runs all 10 steps and registers the kshetra', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp' });
    expect(mockRegisterKshetra).toHaveBeenCalledWith('myapp', expect.stringContaining('kshetra.yaml'));
  });

  it('creates the .beads symlink', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp' });
    expect(mockSymlinkSync).toHaveBeenCalled();
  });

  it('writes kshetra.yaml', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp' });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('kshetra.yaml'),
      expect.stringContaining('myapp'),
      'utf8',
    );
  });

  it('uses TeakWood as default org', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp' });
    const ghCall = mockExecFile.mock.calls.find(c => c[0] === 'gh');
    expect(ghCall?.[1]).toContain('TeakWood/myapp-beads');
  });

  it('uses custom org when provided', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', org: 'Acme' });
    const ghCall = mockExecFile.mock.calls.find(c => c[0] === 'gh');
    expect(ghCall?.[1]).toContain('Acme/myapp-beads');
  });

  it('skips clone, bd init, and symlink creation when beads already fully initialized', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/repos/myapp-beads') return true;
      if (p.endsWith('.git')) return true;
      if (p.endsWith('.dolt')) return true;
      if (p.endsWith('.gitignore')) return true;
      if (p.endsWith('CLAUDE.md')) return true;
      if (p.endsWith('index.json')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = p as string;
      if (s.endsWith('.gitignore')) return '.beads\nnode_modules\n';
      if (s.endsWith('CLAUDE.md')) return '## SHRENI INTEGRATION\nalready here\n';
      return '';
    });
    mockReadlinkSync.mockReturnValue('/repos/myapp-beads');
    mockExecFile.mockReset()
      .mockResolvedValueOnce({ stdout: 'git@github.com:TeakWood/myapp.git\n', stderr: '' }) // App repo: origin exists
      .mockResolvedValueOnce({ stdout: '', stderr: '' })  // gh repo view → exists
      .mockResolvedValueOnce({ stdout: '', stderr: '' })  // bd setup claude
      .mockResolvedValueOnce({ stdout: 'git@github.com:TeakWood/myapp.git\n', stderr: '' }); // git remote

    await initKshetra({ slug: 'myapp', path: '/repos/myapp' });

    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockRegisterKshetra).toHaveBeenCalledWith('myapp', expect.stringContaining('kshetra.yaml'));
  });

  it('derives default beads path as sibling <repo>-beads when --beads-path is omitted', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp' });
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      '/repos/myapp-beads',
      expect.stringContaining('.beads'),
    );
  });

  it('uses custom beads path when beadsPath option is provided', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', beadsPath: '/custom/beads-store' });
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      '/custom/beads-store',
      expect.stringContaining('.beads'),
    );
    const bdInitCall = mockExecFile.mock.calls.find(
      (c) => c[0] === 'bd' && (c[1] as string[]).includes('init'),
    );
    expect(bdInitCall?.[2]).toMatchObject({
      cwd: '/custom/beads-store',
      env: expect.objectContaining({ BEADS_DIR: '/custom/beads-store' }),
    });
  });

  it('writes the resolved provider/model into the config', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', provider: 'codex', model: 'gpt-x' });
    expect(mockCheckProviderInstalled).toHaveBeenCalledWith('openai');
    const configWrite = mockWriteFileSync.mock.calls.find(
      c => typeof c[0] === 'string' && (c[0] as string).endsWith('kshetra.yaml'),
    );
    expect(configWrite?.[1]).toContain('provider: openai');
    expect(configWrite?.[1]).toContain('model: gpt-x');
  });

  it('hard-gates on a missing provider CLI: exits without writing config or registering', async () => {
    mockCheckProviderInstalled.mockReturnValueOnce({ ok: false, bin: 'claude', message: 'install claude' } as never);
    await expect(initKshetra({ slug: 'myapp', path: '/repos/myapp' })).rejects.toThrow('install claude');
    // Nothing written: no config, no symlink, no registration, no network calls.
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
  });

  it('--dry-run prints the plan and mutates nothing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', dryRun: true });
    // No network, no writes, no symlink, no registration.
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
    // Plan mentions the config target and the dry-run banner.
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('dry-run');
    expect(out).toContain(join('/repos/myapp', '.shreni', 'kshetra.yaml'));
    logSpy.mockRestore();
  });

  it('on a phase failure prints WHAT + recovery + the exact re-run, and skips later phases', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Fail the very first mutating phase (App repo): every git/gh call rejects.
    mockExecFile.mockReset().mockRejectedValue(new Error('gh: not authenticated'));
    await expect(
      initKshetra({ slug: 'myapp', path: '/repos/myapp', org: 'Acme' }),
    ).rejects.toThrow('gh: not authenticated');
    // Later phases never ran: no wiring, no config, no registration.
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
    const configWrite = mockWriteFileSync.mock.calls.find(
      c => typeof c[0] === 'string' && (c[0] as string).endsWith('kshetra.yaml'),
    );
    expect(configWrite).toBeUndefined();
    // Recovery guidance + the exact re-run command (with flags) were printed.
    const err = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(err).toContain('App repo failed');
    expect(err).toContain('To recover');
    expect(err).toContain('shreni init-kshetra --slug myapp --path /repos/myapp --org Acme');
    errSpy.mockRestore();
  });

  it('resumes without duplicating GitHub repo/symlink/config when outputs already exist', async () => {
    // Everything from a prior partial run is present: beads repo cloned + db
    // initialised, symlink correct, config dir populated.
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/repos/myapp-beads') return true;
      if (p.endsWith('.git')) return true;
      if (p.endsWith('.dolt')) return true;
      return false;
    });
    mockReadlinkSync.mockReturnValue('/repos/myapp-beads');
    mockExecFile.mockReset()
      .mockResolvedValueOnce({ stdout: 'git@github.com:TeakWood/myapp.git\n', stderr: '' }) // App repo: origin exists
      .mockResolvedValueOnce({ stdout: '', stderr: '' })  // gh repo view → exists (no create)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })  // bd setup claude
      .mockResolvedValueOnce({ stdout: 'git@github.com:TeakWood/myapp.git\n', stderr: '' }); // git remote

    await initKshetra({ slug: 'myapp', path: '/repos/myapp' });

    // No `gh repo create`, no `git clone`, no `bd init`, no new symlink.
    const created = mockExecFile.mock.calls.find(
      c => c[0] === 'gh' && (c[1] as string[]).includes('create'),
    );
    expect(created).toBeUndefined();
    const cloned = mockExecFile.mock.calls.find(c => c[0] === 'git' && (c[1] as string[]).includes('clone'));
    expect(cloned).toBeUndefined();
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    // Config re-written and re-registered (idempotent, single source of truth).
    expect(mockRegisterKshetra).toHaveBeenCalledWith('myapp', expect.stringContaining('kshetra.yaml'));
  });
});
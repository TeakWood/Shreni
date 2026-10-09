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
const mockChmodSync = vi.fn();
const mockRmSync = vi.fn();
vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  appendFileSync: mockAppendFileSync,
  symlinkSync: mockSymlinkSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  readlinkSync: mockReadlinkSync,
  chmodSync: mockChmodSync,
  rmSync: mockRmSync,
}));

const mockRegisterKshetra = vi.fn();
vi.mock('../kshetra/registry', () => ({ registerKshetra: mockRegisterKshetra }));

// Pack loading probes the packs dir on disk; stub the by-name resolver and keep
// the pure pieces (mergeStack) real. loadPack/listPacks are unit-tested in
// packs.test.ts against a real tmp dir.
const mockLoadPackByName = vi.fn();
vi.mock('../kshetra/packs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kshetra/packs')>();
  return { ...actual, loadPackByName: (...a: unknown[]) => mockLoadPackByName(...a) };
});

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

// readline: feed a canned answer to the interactive prompts (promptMergePolicy).
const mockQuestion = vi.fn<(q: string, cb: (a: string) => void) => void>();
vi.mock('readline', () => ({
  createInterface: () => ({ question: mockQuestion, close: vi.fn() }),
}));

// Base-branch helper (uvu.2) — mocked so resolveInitMainBranch tests control
// existence/creation without a real origin.
const mockCheckBaseBranch = vi.fn<() => Promise<{ exists: boolean }>>();
const mockCreateBaseBranch = vi.fn<() => Promise<{ branch: string; base: string }>>();
vi.mock('../sthapathi/base-branch', () => ({
  checkBaseBranch: () => mockCheckBaseBranch(),
  createBaseBranch: () => mockCreateBaseBranch(),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const {
  ensureAppRepo,
  addToGitignore,
  generateKshetraYaml,
  writeKshetraConfig,
  scaffoldConventions,
  materializePackTemplates,
  printPackTemplateDiffs,
  upgradeKshetraStack,
  smokeCheckToolchain,
  readExistingGates,
  formatGatesSummary,
  createRagIndexStub,
  registerWithSthapathi,
  resolveAgents,
  initKshetra,
  promptMergePolicy,
  resolveMergePolicy,
  resolveInitMainBranch,
  recordProjectId,
} = await import('./init-kshetra');

// ── helpers ───────────────────────────────────────────────────────────────────

function resolveExec(stdout: string) {
  mockExecFile.mockResolvedValue({ stdout, stderr: '' });
}

// Dispatch mock keyed on "<cmd> <args...>" prefixes — robust to call ordering,
// unlike mockResolvedValueOnce chains. `overrides` win over the defaults; an
// override value of null makes that command reject.
function resolveExecByCommand(overrides: Record<string, string | null> = {}) {
  mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
    const key = `${cmd} ${(args as string[]).join(' ')}`;
    for (const [prefix, stdout] of Object.entries(overrides)) {
      if (key.startsWith(prefix)) {
        return stdout === null
          ? Promise.reject(new Error(`mock rejection for "${prefix}"`))
          : Promise.resolve({ stdout, stderr: '' });
      }
    }
    if (key.startsWith('gh api user')) return Promise.resolve({ stdout: 'TeakWood\n', stderr: '' });
    if (key.startsWith('git remote get-url origin')) {
      return Promise.resolve({ stdout: 'git@github.com:TeakWood/myapp.git\n', stderr: '' });
    }
    if (key.startsWith('git rev-parse --abbrev-ref HEAD')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
    return Promise.resolve({ stdout: '', stderr: '' });
  });
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
  it('is a no-op when the repo already has an origin remote, without resolving an owner', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.git'));
    resolveExec('git@github.com:TeakWood/myapp.git');
    // A pre-wired repo (e.g. the certification harness's local bare origin) must
    // not force owner resolution — that regressed cert with 'gh auth login' (84m.11).
    const resolveOwner = vi.fn(async () => 'TeakWood');
    await ensureAppRepo(resolveOwner, 'myapp', '/repos/myapp');
    expect(resolveOwner).not.toHaveBeenCalled();
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

    await ensureAppRepo(async () => 'Acme', 'myapp', '/repos/myapp');

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

    await ensureAppRepo(async () => 'TeakWood', 'myapp', '/repos/myapp');

    const cmds = mockExecFile.mock.calls.map(c => `${c[0]} ${(c[1] as string[]).join(' ')}`);
    expect(cmds).not.toContain('git init -b main');
    expect(cmds.some(c => c.startsWith('gh repo create'))).toBe(false);
    expect(cmds.some(c => c.startsWith('git commit'))).toBe(false);
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['push', '-u', 'origin', 'trunk'], expect.objectContaining({ cwd: '/repos/myapp' }),
    );
  });
});

// ── Step 5: addToGitignore ────────────────────────────────────────────────────

describe('addToGitignore', () => {
  it('creates .gitignore with the machine-specific config and the repo map when absent (no .beads)', () => {
    mockExistsSync.mockReturnValue(false);
    addToGitignore('/repos/myapp');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.gitignore'),
      '.shreni/kshetra.yaml\n.shreni/repo-map.md\n',
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
      '.shreni/kshetra.yaml\n.shreni/repo-map.md\n',
      'utf8',
    );
  });

  it('skips entirely when all markers are already present', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('node_modules\n.beads\n.shreni/kshetra.yaml\n.shreni/repo-map.md\n');
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
      '\n.shreni/kshetra.yaml\n.shreni/repo-map.md\n',
      'utf8',
    );
  });
});

// ── Step 7: generateKshetraYaml ───────────────────────────────────────────────

describe('generateKshetraYaml', () => {
  const OPTS = {
    slug: 'my-app',
    repoPath: '/repos/my-app',
    repoRemote: 'git@github.com:TeakWood/my-app.git',
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

  it('writes no beads block', () => {
    const out = generateKshetraYaml(OPTS);
    expect(out).not.toContain('beads');
    expect(out).not.toContain('mode: embedded');
  });

  it('writes the database and the project when given', () => {
    const out = generateKshetraYaml({ ...OPTS, database: 'local', project: '00000000-0000-4000-8000-000000000001' });
    expect(out).toMatch(/^name: My App\nproject: 00000000-0000-4000-8000-000000000001\ndatabase: local\n/m);
  });

  it('sets the default model and maxRoundsPerBead', () => {
    const out = generateKshetraYaml(OPTS);
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('maxRoundsPerBead: 3');
  });

  it('defaults mainBranch to main when none is given (uvu.3)', () => {
    expect(generateKshetraYaml(OPTS)).toContain('mainBranch: main');
  });

  it('writes a custom mainBranch when provided (uvu.3)', () => {
    expect(generateKshetraYaml({ ...OPTS, mainBranch: 'develop' })).toContain('mainBranch: develop');
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

// ── resolveInitMainBranch (uvu.3) ─────────────────────────────────────────────

describe('resolveInitMainBranch', () => {
  beforeEach(() => {
    mockCheckBaseBranch.mockResolvedValue({ exists: true });
    mockCreateBaseBranch.mockResolvedValue({ branch: 'develop', base: 'main' });
  });

  it('non-TTY keeps the default main with no prompt and no origin check', async () => {
    const promptBranch = vi.fn();
    const branch = await resolveInitMainBranch('/repo', 'my-app', { isTTY: false }, { promptBranch });
    expect(branch).toBe('main');
    expect(promptBranch).not.toHaveBeenCalled();
    expect(mockCheckBaseBranch).not.toHaveBeenCalled();
  });

  it('returns the chosen branch when it already exists on origin (no create prompt)', async () => {
    mockCheckBaseBranch.mockResolvedValue({ exists: true });
    const promptCreate = vi.fn();
    const branch = await resolveInitMainBranch(
      '/repo', 'my-app', { isTTY: true },
      { promptBranch: async () => 'develop', promptCreate },
    );
    expect(branch).toBe('develop');
    expect(promptCreate).not.toHaveBeenCalled();
    expect(mockCreateBaseBranch).not.toHaveBeenCalled();
  });

  it('creates+pushes when the branch is missing and the operator says yes', async () => {
    mockCheckBaseBranch.mockResolvedValue({ exists: false });
    const branch = await resolveInitMainBranch(
      '/repo', 'my-app', { isTTY: true },
      { promptBranch: async () => 'develop', promptCreate: async () => true },
    );
    expect(branch).toBe('develop');
    expect(mockCreateBaseBranch).toHaveBeenCalledTimes(1);
  });

  it('completes with a warning (no create) when the operator declines', async () => {
    mockCheckBaseBranch.mockResolvedValue({ exists: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const branch = await resolveInitMainBranch(
      '/repo', 'my-app', { isTTY: true },
      { promptBranch: async () => 'develop', promptCreate: async () => false },
    );
    expect(branch).toBe('develop');
    expect(mockCreateBaseBranch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shreni base-branch create my-app'));
    warn.mockRestore();
  });

  it('a blank branch answer keeps main', async () => {
    mockCheckBaseBranch.mockResolvedValue({ exists: true });
    const branch = await resolveInitMainBranch('/repo', 'my-app', { isTTY: true }, { promptBranch: async () => 'main' });
    expect(branch).toBe('main');
  });

  it('does not block init when the origin check throws', async () => {
    mockCheckBaseBranch.mockRejectedValue(new Error('origin unreachable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const branch = await resolveInitMainBranch(
      '/repo', 'my-app', { isTTY: true },
      { promptBranch: async () => 'develop' },
    );
    expect(branch).toBe('develop');
    expect(mockCreateBaseBranch).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

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

// ── Packs: materialization, provenance, --upgrade (84m.2) ─────────────────────

const FAKE_PACK = {
  name: 'nextjs-vitest',
  version: 1,
  dir: '/packs/nextjs-vitest',
  stack: {
    language: 'typescript',
    framework: 'nextjs',
    packageManager: 'pnpm',
    buildCommand: 'pnpm build',
    testRunner: 'pnpm test',
    lintCommand: 'pnpm lint',
  },
};

describe('materializePackTemplates', () => {
  it('copies the three conventions templates into .shreni/ and returns pointers', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation((p: unknown) => `template: ${p as string}`);

    const conventions = materializePackTemplates(FAKE_PACK, '/repos/myapp');

    for (const f of ['style-guide.md', 'arch.md', 'review-guide.md']) {
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        join('/repos/myapp', '.shreni', f),
        `template: ${join('/packs/nextjs-vitest', f)}`,
        'utf8',
      );
    }
    expect(conventions).toEqual({
      styleGuide: join('.shreni', 'style-guide.md'),
      architecture: join('.shreni', 'arch.md'),
      reviewGuide: join('.shreni', 'review-guide.md'),
    });
  });

  it('never overwrites existing files — skip and warn', () => {
    mockExistsSync.mockReturnValue(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    materializePackTemplates(FAKE_PACK, '/repos/myapp');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warned).toContain('already exists');
    warnSpy.mockRestore();
  });
});

describe('upgradeKshetraStack', () => {
  it('updates stack values + provenance and preserves every other config block', () => {
    mockReadFileSync.mockReturnValue(
      'id: myapp\nagents:\n  provider: anthropic\n  model: m\nstack:\n  language: typescript\n  testRunner: old-runner\ngates:\n  coverage:\n    level: block\n',
    );
    upgradeKshetraStack('/repos/myapp/.shreni/kshetra.yaml', FAKE_PACK.stack, 'nextjs-vitest@2');
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    expect(written).toContain('testRunner: pnpm test');
    expect(written).not.toContain('old-runner');
    expect(written).toContain('pack: nextjs-vitest@2');
    expect(written).toContain('provider: anthropic');
    expect(written).toContain('level: block');
  });
});

describe('printPackTemplateDiffs', () => {
  it('runs diff -u per existing doc and prints the output when they differ', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFile.mockRejectedValue(
      Object.assign(new Error('differs'), { stdout: '--- current\n+++ pristine' }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printPackTemplateDiffs(FAKE_PACK, '/repos/myapp');

    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenCalledWith(
      'diff',
      ['-u', join('/repos/myapp', '.shreni', 'review-guide.md'), join('/packs/nextjs-vitest', 'review-guide.md')],
      expect.any(Object),
    );
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('differs from the pristine nextjs-vitest@1 template');
    expect(out).toContain('+++ pristine');
    logSpy.mockRestore();
  });

  it('prints nothing when docs match the template (diff exits 0)', async () => {
    mockExistsSync.mockReturnValue(true);
    resolveExec('');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await printPackTemplateDiffs(FAKE_PACK, '/repos/myapp');
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('generateKshetraYaml with a pack', () => {
  const OPTS = {
    slug: 'my-app',
    repoPath: '/repos/my-app',
    repoRemote: 'git@github.com:TeakWood/my-app.git',
    packStack: FAKE_PACK.stack,
    pack: 'nextjs-vitest@1',
    conventions: {
      styleGuide: '.shreni/style-guide.md',
      architecture: '.shreni/arch.md',
      reviewGuide: '.shreni/review-guide.md',
    },
  };

  it('writes every populated pack stack value (including framework)', () => {
    const out = generateKshetraYaml(OPTS);
    expect(out).toContain('framework: nextjs');
    expect(out).toContain('buildCommand: pnpm build');
    expect(out).toContain('testRunner: pnpm test');
    expect(out).toContain('lintCommand: pnpm lint');
  });

  it('records the pack provenance line', () => {
    expect(generateKshetraYaml(OPTS)).toContain('pack: nextjs-vitest@1');
  });

  it('points conventions.reviewGuide at the materialized review guide', () => {
    expect(generateKshetraYaml(OPTS)).toContain('reviewGuide: .shreni/review-guide.md');
  });

  it('omits provenance and reviewGuide on the no-pack path', () => {
    const out = generateKshetraYaml({ ...OPTS, packStack: undefined, pack: undefined, conventions: undefined, language: 'typescript' });
    expect(out).not.toContain('pack:');
    expect(out).not.toContain('reviewGuide');
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

// ── Quality gates at init (yds.15) ───────────────────────────────────────────

describe('readExistingGates', () => {
  it('returns undefined when no config exists', () => {
    expect(readExistingGates('/repos/myapp/.shreni/kshetra.yaml')).toBeUndefined();
  });

  it('returns the gates block from an existing config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('id: myapp\ngates:\n  coverage:\n    level: block\n');
    expect(readExistingGates('/repos/myapp/.shreni/kshetra.yaml')).toEqual({
      coverage: { level: 'block' },
    });
  });

  it('returns undefined when the config has no gates block', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('id: myapp\n');
    expect(readExistingGates('/repos/myapp/.shreni/kshetra.yaml')).toBeUndefined();
  });

  it('returns undefined on unparseable YAML', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('id: [unclosed');
    expect(readExistingGates('/repos/myapp/.shreni/kshetra.yaml')).toBeUndefined();
  });
});

describe('formatGatesSummary', () => {
  const defaults = {
    test: { level: 'block' as const },
    lint: { level: 'block' as const },
    coverage: { level: 'warn' as const },
    diffSize: { level: 'warn' as const, maxFiles: 40, maxLines: 1500 },
  };

  it('shows levels with the resolved commands', () => {
    const out = formatGatesSummary(defaults, {
      language: 'typescript', testRunner: 'pnpm test', lintCommand: 'pnpm lint', unknown: false,
    });
    expect(out).toContain('test:     block  pnpm test');
    expect(out).toContain('lint:     block  pnpm lint');
    expect(out).toContain('coverage: warn');
    expect(out).toContain('diffSize: warn (≤40 files, ≤1500 lines)');
  });

  it('marks empty commands as visible skips and unset ones as language defaults', () => {
    const out = formatGatesSummary(defaults, {
      language: 'python', lintCommand: '', unknown: false,
    });
    expect(out).toContain('test:     block  (language default)');
    expect(out).toContain('lint:     block  (skipped — empty command)');
  });
});

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
  const ID = '00000000-0000-4000-8000-000000000001';
  const CONFIG = '/repos/myapp/.shreni/kshetra.yaml';
  /** Files written, read back as the real fs would. */
  function disk(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial));
    mockWriteFileSync.mockImplementation(((p: string, c: string) => { files.set(p, c); }) as never);
    mockReadFileSync.mockImplementation(((p: string) => {
      // A pack's templates live in its own dir.
      if (p.startsWith('/packs/')) return `# ${p}\n`;
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p)!;
    }) as never);
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.git') || files.has(p));
    return files;
  }
  function engine(order: string[] = []) {
    return {
      database: vi.fn(async (db: string) => { order.push(`database ${db}`); }),
      project: vi.fn(async (input: { existing?: string }) => { order.push('project'); return input.existing ?? ID; }),
    };
  }
  /** initKshetra with a stub engine: the Database and Project phases are always on. */
  const init = (o: Omit<Parameters<typeof initKshetra>[0], 'engine'> & { engine?: ReturnType<typeof engine> }) =>
    initKshetra({ engine: engine(), ...o });
  let files: Map<string, string>;

  beforeEach(() => {
    // App repo phase no-ops: .git exists and origin resolves. Exec calls are
    // dispatched by command (resolveExecByCommand defaults): origin resolves,
    // gh api user yields the login, everything else succeeds with ''.
    files = disk();
    resolveExecByCommand();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('runs every phase and registers the kshetra', async () => {
    await init({ slug: 'myapp', path: '/repos/myapp' });
    expect(mockRegisterKshetra).toHaveBeenCalledWith('myapp', CONFIG);
  });

  it('writes kshetra.yaml with the project and database, and no beads block', async () => {
    await init({ slug: 'myapp', path: '/repos/myapp' });
    const config = files.get(CONFIG)!;
    expect(config).toContain('id: myapp');
    expect(config).toMatch(new RegExp(`^name: Myapp\nproject: ${ID}\ndatabase: local\n`, 'm'));
    expect(config).not.toContain('beads');
  });

  it('never runs bd, makes no beads repo and no .beads link, and gitignores no .beads', async () => {
    await init({ slug: 'myapp', path: '/repos/myapp' });
    expect(mockExecFile.mock.calls.filter(c => c[0] === 'bd')).toEqual([]);
    expect(mockExecFile.mock.calls.find(c => c[0] === 'gh' && (c[1] as string[]).includes('create'))).toBeUndefined();
    expect(mockExecFile.mock.calls.find(c => c[0] === 'git' && (c[1] as string[]).includes('clone'))).toBeUndefined();
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    const gitignore = files.get('/repos/myapp/.gitignore')!;
    expect(gitignore).toContain('.shreni/kshetra.yaml');
    expect(gitignore).toContain('.shreni/repo-map.md');
    expect(gitignore).not.toMatch(/^\.beads$/m);
  });

  /** An app repo with no origin yet: the first `git remote get-url origin` fails, later ones resolve. */
  function noOriginYet(login: string | null = 'TeakWood') {
    let originAsked = 0;
    mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
      const key = `${cmd} ${(args as string[]).join(' ')}`;
      if (key.startsWith('git remote get-url origin')) {
        return originAsked++ === 0 ? Promise.reject(new Error('no origin'))
          : Promise.resolve({ stdout: 'git@github.com:x/myapp.git\n', stderr: '' });
      }
      if (key.startsWith('gh api user')) return login === null ? Promise.reject(new Error('not logged in')) : Promise.resolve({ stdout: `${login}\n`, stderr: '' });
      if (key.startsWith('git rev-parse --abbrev-ref HEAD')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
  }

  it('resolves the owner of a created app repo from the gh login when --org is omitted', async () => {
    noOriginYet('navakanth');
    await init({ slug: 'myapp', path: '/repos/myapp' });
    const ghCall = mockExecFile.mock.calls.find(c => c[0] === 'gh' && (c[1] as string[]).includes('view'));
    expect(ghCall?.[1]).toContain('navakanth/myapp');
  });

  it('uses custom org when provided, without consulting gh', async () => {
    noOriginYet();
    await init({ slug: 'myapp', path: '/repos/myapp', org: 'Acme' });
    const ghCall = mockExecFile.mock.calls.find(c => c[0] === 'gh' && (c[1] as string[]).includes('view'));
    expect(ghCall?.[1]).toContain('Acme/myapp');
    expect(mockExecFile.mock.calls.find(c => c[0] === 'gh' && (c[1] as string[]).includes('user'))).toBeUndefined();
  });

  it('errors with --org guidance when no org is given and the gh login cannot be resolved', async () => {
    noOriginYet(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(init({ slug: 'myapp', path: '/repos/myapp' })).rejects.toThrow('--org');
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
  });

  it('a repo that already has an origin never needs an owner', async () => {
    resolveExecByCommand({ 'gh api user': null });
    await init({ slug: 'myapp', path: '/repos/myapp' });
    expect(mockRegisterKshetra).toHaveBeenCalled();
  });

  describe('the engine phases (policy spec, "Init")', () => {
    it('reaches the database before the config, and registers the project once the config is written', async () => {
      const order: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((l: unknown) => { if (typeof l === 'string' && l.startsWith('▶')) order.push(l); });
      const e = engine(order);
      await initKshetra({ slug: 'myapp', path: '/repos/myapp', engine: e });
      log.mockRestore();
      expect(order).toEqual(['▶ App repo …', '▶ Base branch …', '▶ Database …', 'database local', '▶ Config …', '▶ Project …', 'project', '▶ Register …']);
      // A Kshetra imports no beads at init: the beads argument is the tracker path's.
      expect(e.project).toHaveBeenCalledWith({ database: 'local', existing: undefined, repoUrl: expect.any(String) });
      // The Kshetra block and the prime hooks, always.
      expect(files.get('/repos/myapp/CLAUDE.md')).toMatch(/^<!-- shreni:begin kshetra v1 -->/);
      expect(files.get('/repos/myapp/.claude/settings.json')).toContain('shreni task prime');
      expect(files.get('/repos/myapp/.claude/settings.json')).not.toContain('bd prime');
    });

    it('the Config phase replaces an old SHRENI INTEGRATION section with the block', async () => {
      const { LEGACY_SECTION } = await import('../policy/init/instructions');
      files.set('/repos/myapp/CLAUDE.md', `# Mine\n${LEGACY_SECTION}`);
      await init({ slug: 'myapp', path: '/repos/myapp' });
      const text = files.get('/repos/myapp/CLAUDE.md')!;
      expect(text).toMatch(/^# Mine\n\n<!-- shreni:begin kshetra v1 -->/);
      expect(text).not.toContain('SHRENI INTEGRATION');
    });

    it('refuses a Kshetra still on beads, pointing at shreni migrate, before any phase runs', async () => {
      disk({
        '/repos/myapp/.shreni/kshetra.yaml': 'id: myapp\nname: Myapp\nbeads: { path: /repos/myapp-beads, remote: x }\n',
        '/repos/myapp-beads/issues.jsonl': '{"_type":"issue","id":"myapp-1"}\n',
      });
      const e = engine([]);
      await expect(initKshetra({ slug: 'myapp', path: '/repos/myapp', engine: e })).rejects.toThrow(/myapp is still on beads; run shreni migrate myapp/);
      expect(e.database).not.toHaveBeenCalled();
      expect(e.project).not.toHaveBeenCalled();
    });

    it('a re-run keeps the project and database the config names', async () => {
      files.set(CONFIG, `id: myapp\nname: Myapp\nproject: ${ID}\ndatabase: acme\n`);
      const e = engine([]);
      await initKshetra({ slug: 'myapp', path: '/repos/myapp', engine: e });
      expect(e.database).toHaveBeenCalledWith('acme');
      expect(e.project).toHaveBeenCalledWith(expect.objectContaining({ database: 'acme', existing: ID }));
      expect(files.get(CONFIG)!.match(/^project:/gm)).toHaveLength(1);
    });

    it('a Kshetra replacing a tracker takes its project and database, then removes tracker.yaml', async () => {
      const tracker = '/repos/myapp/.shreni/tracker.yaml';
      files.set(tracker, `name: myapp\nproject: ${ID}\ndatabase: acme\nproviders: [claude]\n`);
      const e = engine([]);
      await initKshetra({ slug: 'myapp', path: '/repos/myapp', engine: e, replaces: tracker });
      expect(e.project).toHaveBeenCalledWith(expect.objectContaining({ database: 'acme', existing: ID }));
      expect(files.get(CONFIG)).toContain(`project: ${ID}`);
      expect(mockRmSync).toHaveBeenCalledWith(tracker);
    });

    it('records the project id in place, keeping the rest of the file', () => {
      files.set('/c.yaml', '# mine\nname: web # the name\nrepo: {}\n');
      recordProjectId('/c.yaml', ID);
      expect(files.get('/c.yaml')).toBe(`# mine\nname: web # the name\nproject: ${ID}\nrepo: {}\n`);
      recordProjectId('/c.yaml', ID.replace(/1$/, '2'));
      expect(files.get('/c.yaml')!.match(/^project: .*2$/gm)).toHaveLength(1);
    });
  });

  it('writes an explicit gates block with the schema defaults into a fresh config', async () => {
    await init({ slug: 'myapp', path: '/repos/myapp' });
    const yamlOut = files.get(CONFIG)!;
    expect(yamlOut).toContain('gates:');
    expect(yamlOut).toMatch(/test:\s*\n\s*level: block/);
    expect(yamlOut).toMatch(/coverage:\s*\n\s*level: warn/);
    expect(yamlOut).toContain('maxFiles: 40');
    expect(yamlOut).toContain('maxLines: 1500');
  });

  it('preserves an existing gates block on re-init instead of resetting to defaults', async () => {
    files.set(CONFIG, 'id: myapp\ngates:\n  coverage:\n    level: block\n');
    await init({ slug: 'myapp', path: '/repos/myapp' });
    expect(files.get(CONFIG)).toMatch(/coverage:\s*\n\s*level: block/);
  });

  it('ends with the ready-to-work message', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await init({ slug: 'myapp', path: '/repos/myapp' });
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('Initialization done — Shreni is now ready to work on "myapp"');
    expect(out).toContain('Run `shreni start` to begin.');
    expect(out).not.toContain('beads repo');
  });

  it('writes the resolved provider/model into the config', async () => {
    await init({ slug: 'myapp', path: '/repos/myapp', provider: 'codex', model: 'gpt-x' });
    expect(mockCheckProviderInstalled).toHaveBeenCalledWith('openai');
    expect(files.get(CONFIG)).toContain('provider: openai');
    expect(files.get(CONFIG)).toContain('model: gpt-x');
  });

  it('hard-gates on a missing provider CLI: exits without writing config or registering', async () => {
    mockCheckProviderInstalled.mockReturnValueOnce({ ok: false, bin: 'claude', message: 'install claude' } as never);
    await expect(init({ slug: 'myapp', path: '/repos/myapp' })).rejects.toThrow('install claude');
    // Nothing written: no config, no registration, no network calls.
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
  });

  it('--dry-run prints the plan and mutates nothing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const e = engine();
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', dryRun: true, engine: e });
    // No network, no writes, no database, no registration.
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(e.database).not.toHaveBeenCalled();
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('dry-run');
    expect(out).toContain(join('/repos/myapp', '.shreni', 'kshetra.yaml'));
    expect(out).not.toContain('beads');
    logSpy.mockRestore();
  });

  it('on a phase failure prints WHAT + recovery + the exact re-run, and skips later phases', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Fail the very first mutating phase (App repo): every git/gh call rejects.
    mockExecFile.mockReset().mockRejectedValue(new Error('gh: not authenticated'));
    await expect(
      init({ slug: 'myapp', path: '/repos/myapp', org: 'Acme' }),
    ).rejects.toThrow('gh: not authenticated');
    // Later phases never ran: no config, no registration.
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
    expect(files.has(CONFIG)).toBe(false);
    const err = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(err).toContain('App repo failed');
    expect(err).toContain('To recover');
    expect(err).toContain('shreni init --mode kshetra --slug myapp --path /repos/myapp --org Acme');
    expect(err).not.toContain('--on-beads');
    errSpy.mockRestore();
  });

  it('--pack materializes stack values, provenance, and templates', async () => {
    mockLoadPackByName.mockReturnValue(FAKE_PACK);
    await init({ slug: 'myapp', path: '/repos/myapp', pack: 'nextjs-vitest' });
    expect(mockLoadPackByName).toHaveBeenCalledWith('nextjs-vitest');
    const config = files.get(CONFIG)!;
    expect(config).toContain('pack: nextjs-vitest@1');
    expect(config).toContain('framework: nextjs');
    expect(config).toContain('buildCommand: pnpm build');
    expect(config).toContain('reviewGuide:');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.shreni', 'review-guide.md'), expect.anything(), 'utf8',
    );
  });

  it('--language (explicit user value) wins over the pack value', async () => {
    mockLoadPackByName.mockReturnValue(FAKE_PACK);
    await init({ slug: 'myapp', path: '/repos/myapp', pack: 'nextjs-vitest', language: 'javascript' });
    expect(files.get(CONFIG)).toContain('language: javascript');
    expect(files.get(CONFIG)).toContain('testRunner: pnpm test');
  });

  it('rejects --pack combined with --no-pack before mutating anything', async () => {
    await expect(
      init({ slug: 'myapp', path: '/repos/myapp', pack: 'x', noPack: true }),
    ).rejects.toThrow('mutually exclusive');
    expect(mockLoadPackByName).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('rejects --upgrade without --pack', async () => {
    await expect(
      init({ slug: 'myapp', path: '/repos/myapp', upgrade: true }),
    ).rejects.toThrow('--upgrade requires --pack');
  });

  it('--upgrade updates stack values only, prints template diffs, and runs no init phases', async () => {
    mockLoadPackByName.mockReturnValue({ ...FAKE_PACK, version: 2 });
    files.set(CONFIG, 'id: myapp\nagents:\n  provider: anthropic\nstack:\n  language: typescript\n  testRunner: old-runner\n');
    mockExistsSync.mockImplementation(
      (p: string) => p.endsWith('kshetra.yaml') || p.endsWith('.md') || p.endsWith('.git'),
    );
    mockExecFile.mockReset().mockRejectedValue(
      Object.assign(new Error('differs'), { stdout: '--- current\n+++ pristine' }),
    );
    const e = engine();
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', pack: 'nextjs-vitest', upgrade: true, engine: e });
    const config = files.get(CONFIG)!;
    expect(config).toContain('pack: nextjs-vitest@2');
    expect(config).toContain('testRunner: pnpm test');
    expect(config).toContain('provider: anthropic');
    // Docs untouched; a diff was printed instead.
    expect(mockWriteFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('review-guide.md'), expect.anything(), 'utf8',
    );
    expect(mockExecFile).toHaveBeenCalledWith('diff', expect.anything(), expect.any(Object));
    // No repo/database/register phases.
    expect(e.database).not.toHaveBeenCalled();
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
  });

  it('--upgrade errors when there is no existing config to upgrade', async () => {
    mockLoadPackByName.mockReturnValue(FAKE_PACK);
    mockExistsSync.mockReturnValue(false);
    await expect(
      init({ slug: 'myapp', path: '/repos/myapp', pack: 'nextjs-vitest', upgrade: true }),
    ).rejects.toThrow('Nothing to upgrade');
  });

  it('a re-run resumes without duplicating the app repo, the config or the project', async () => {
    const e = engine();
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', engine: e });
    mockExecFile.mockClear();
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', engine: e });
    expect(mockExecFile.mock.calls.find(c => c[0] === 'gh' && (c[1] as string[]).includes('create'))).toBeUndefined();
    expect(e.project).toHaveBeenLastCalledWith(expect.objectContaining({ existing: ID }));
    expect(files.get(CONFIG)!.match(/^project:/gm)).toHaveLength(1);
    expect(files.get('/repos/myapp/CLAUDE.md')!.match(/shreni:begin/g)).toHaveLength(1);
    expect(mockRegisterKshetra).toHaveBeenCalledTimes(2);
  });
});

describe('promptMergePolicy (wax)', () => {
  const answer = (a: string) => mockQuestion.mockImplementation((_q, cb) => cb(a));

  it('returns pr when the operator types pr', async () => {
    answer('pr');
    expect(await promptMergePolicy()).toBe('pr');
  });

  it('returns push when the operator types push', async () => {
    answer('push');
    expect(await promptMergePolicy()).toBe('push');
  });

  it('defaults to push on an empty answer', async () => {
    answer('');
    expect(await promptMergePolicy()).toBe('push');
  });

  it('is case-insensitive', async () => {
    answer('PR');
    expect(await promptMergePolicy()).toBe('pr');
  });

  it('warns and keeps push on an unrecognised answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer('maybe');
    expect(await promptMergePolicy()).toBe('push');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveMergePolicy (wax)', () => {
  it('honours an explicit flag and never prompts', async () => {
    const prompt = vi.fn(async () => 'pr' as const);
    expect(await resolveMergePolicy('pr', { isTTY: true }, prompt)).toBe('pr');
    expect(await resolveMergePolicy('push', { isTTY: true }, prompt)).toBe('push');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('prompts on an interactive TTY when no flag is given', async () => {
    const prompt = vi.fn(async () => 'pr' as const);
    expect(await resolveMergePolicy(undefined, { isTTY: true }, prompt)).toBe('pr');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('returns undefined (silent push default) on a non-TTY run, without prompting', async () => {
    const prompt = vi.fn(async () => 'pr' as const);
    expect(await resolveMergePolicy(undefined, { isTTY: false }, prompt)).toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not prompt during a dry-run even on a TTY', async () => {
    const prompt = vi.fn(async () => 'pr' as const);
    expect(await resolveMergePolicy(undefined, { isTTY: true, dryRun: true }, prompt)).toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });
});

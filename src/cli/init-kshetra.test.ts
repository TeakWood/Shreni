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
vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  appendFileSync: mockAppendFileSync,
  symlinkSync: mockSymlinkSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
}));

const mockRegisterKshetra = vi.fn();
vi.mock('../kshetra/registry', () => ({ registerKshetra: mockRegisterKshetra }));

// ── imports after mocks ───────────────────────────────────────────────────────

const {
  createGitHubRepo,
  cloneBeadsRepo,
  initBeadsDb,
  createBeadsSymlink,
  addToGitignore,
  setupClaudeHooks,
  generateKshetraYaml,
  writeKshetraConfig,
  appendShreniIntegration,
  createRagIndexStub,
  registerWithSthapathi,
  initKshetra,
} = await import('./init-kshetra');

// ── helpers ───────────────────────────────────────────────────────────────────

function resolveExec(stdout: string) {
  mockExecFile.mockResolvedValue({ stdout, stderr: '' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
  resolveExec('');
});

// ── Step 1: createGitHubRepo ──────────────────────────────────────────────────

describe('createGitHubRepo', () => {
  it('calls gh repo create with org/slug-beads --private --confirm', async () => {
    resolveExec('');
    const url = await createGitHubRepo('TeakWood', 'myapp');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['repo', 'create', 'TeakWood/myapp-beads', '--private', '--confirm'],
      expect.any(Object),
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
});

// ── Step 5: addToGitignore ────────────────────────────────────────────────────

describe('addToGitignore', () => {
  it('creates .gitignore with .beads when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    addToGitignore('/repos/myapp');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.gitignore'),
      '.beads\n',
      'utf8',
    );
  });

  it('appends .beads when .gitignore exists and does not already contain it', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('node_modules\ndist\n');
    addToGitignore('/repos/myapp');
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', '.gitignore'),
      expect.stringContaining('.beads'),
      'utf8',
    );
  });

  it('skips appending if .beads already in .gitignore', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('node_modules\n.beads\n');
    addToGitignore('/repos/myapp');
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
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

  it('writes kshetra.yaml at <repoPath>/kshetra.yaml', () => {
    writeKshetraConfig('/repos/myapp', 'id: myapp\n');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/repos/myapp', 'kshetra.yaml'),
      'id: myapp\n',
      'utf8',
    );
  });
});

// ── Step 8: appendShreniIntegration ──────────────────────────────────────────

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
    // gh repo create, git clone, bd init, git remote get-url, bd setup claude all succeed
    mockExecFile
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // gh repo create
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
    const ghCall = mockExecFile.mock.calls[0];
    expect(ghCall?.[1]).toContain('TeakWood/myapp-beads');
  });

  it('uses custom org when provided', async () => {
    await initKshetra({ slug: 'myapp', path: '/repos/myapp', org: 'Acme' });
    const ghCall = mockExecFile.mock.calls[0];
    expect(ghCall?.[1]).toContain('Acme/myapp-beads');
  });
});
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  DEFAULT_DESIGN_DIR,
  resolveDesignDir,
  assertWithinDesignDir,
  resolveDocWrite,
  slugifyFeature,
  designDocRelPath,
  writeDesignDoc,
  withDocLink,
  linkDocIntoDecomposition,
  buildRememberFactArgv,
  DesignDocPathError,
} from './designdoc';
import type { KshetraConfig } from '../kshetra/config';
import type { Decomposition } from './decomposition';

// A repo rooted at a real temp dir so the write tests exercise the actual
// filesystem behaviour (mkdir + atomic-ish write) while staying isolated.
const REPO_ROOT = mkdtempSync(join(tmpdir(), 'suthradhara-designdoc-'));

function kshetra(repoPath: string = REPO_ROOT): KshetraConfig {
  return {
    id: 'myapp',
    name: 'Myapp',
    repo: { path: repoPath, remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: `${repoPath}-beads`, remote: '', mode: 'embedded' },
    stack: { language: 'typescript' },
    conventions: {},
    agents: { provider: 'anthropic', model: 'claude-opus-4-7', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  } as unknown as KshetraConfig;
}

afterEach(() => {
  rmSync(resolveDesignDir(kshetra()), { recursive: true, force: true });
});

describe('resolveDesignDir', () => {
  it('is <repo>/.shreni/design', () => {
    expect(resolveDesignDir(kshetra('/projects/myapp'))).toBe('/projects/myapp/.shreni/design');
    expect(DEFAULT_DESIGN_DIR).toBe('.shreni/design');
  });
});

describe('assertWithinDesignDir (the load-bearing path guard)', () => {
  const dir = '/projects/myapp/.shreni/design';

  it('accepts a file directly inside the design dir', () => {
    expect(assertWithinDesignDir(dir, `${dir}/sso.md`)).toBe(`${dir}/sso.md`);
  });

  it('accepts a file in a subdirectory of the design dir', () => {
    expect(assertWithinDesignDir(dir, `${dir}/auth/sso.md`)).toBe(`${dir}/auth/sso.md`);
  });

  it('denies a `../` traversal escape', () => {
    expect(() => assertWithinDesignDir(dir, `${dir}/../../src/index.ts`)).toThrow(
      DesignDocPathError,
    );
  });

  it('denies an absolute path outside the dir', () => {
    expect(() => assertWithinDesignDir(dir, '/projects/myapp/src/index.ts')).toThrow(
      DesignDocPathError,
    );
  });

  it('denies the design dir itself (not a file within)', () => {
    expect(() => assertWithinDesignDir(dir, dir)).toThrow(DesignDocPathError);
  });

  it('denies a sibling dir that shares the prefix string', () => {
    // `.../design-secrets` starts with `.../design` as a string but is NOT inside it.
    expect(() => assertWithinDesignDir(dir, `${dir}-secrets/x.md`)).toThrow(DesignDocPathError);
  });
});

describe('resolveDocWrite', () => {
  it('resolves a repo-relative in-dir path to a normalised ref', () => {
    const ref = resolveDocWrite(kshetra('/projects/myapp'), '.shreni/design/sso.md');
    expect(ref.relPath).toBe('.shreni/design/sso.md');
    expect(ref.absPath).toBe('/projects/myapp/.shreni/design/sso.md');
  });

  // The mandatory negative test (ARD §6.2, §15): an arbitrary source path is denied.
  it('DENIES a write to an arbitrary source path (src/index.ts)', () => {
    expect(() => resolveDocWrite(kshetra('/projects/myapp'), 'src/index.ts')).toThrow(
      DesignDocPathError,
    );
  });

  it('denies a repo-relative traversal that climbs out of the design dir', () => {
    expect(() =>
      resolveDocWrite(kshetra('/projects/myapp'), '.shreni/design/../../etc/passwd'),
    ).toThrow(DesignDocPathError);
  });
});

describe('slugifyFeature / designDocRelPath', () => {
  it('slugifies a feature name to kebab-case ascii', () => {
    expect(slugifyFeature('SSO login for the web app')).toBe('sso-login-for-the-web-app');
    expect(slugifyFeature('  CSV / TSV import!! ')).toBe('csv-tsv-import');
  });

  it('builds the default in-dir doc path from a feature name', () => {
    expect(designDocRelPath('SSO login')).toBe('.shreni/design/sso-login.md');
  });

  it('throws when a feature name has no usable characters', () => {
    expect(() => designDocRelPath('!!!')).toThrow();
  });
});

describe('writeDesignDoc (server authors the file)', () => {
  it('writes the doc inside the design dir, creating the dir', () => {
    const k = kshetra();
    const ref = writeDesignDoc({
      kshetra: k,
      relPath: designDocRelPath('SSO login'),
      content: '# SSO login\n\nChosen approach: OIDC.',
    });
    expect(ref.relPath).toBe('.shreni/design/sso-login.md');
    expect(existsSync(ref.absPath)).toBe(true);
    expect(readFileSync(ref.absPath, 'utf8')).toBe('# SSO login\n\nChosen approach: OIDC.\n');
  });

  it('ensures exactly one trailing newline', () => {
    const ref = writeDesignDoc({
      kshetra: kshetra(),
      relPath: designDocRelPath('already-newlined'),
      content: 'body\n',
    });
    expect(readFileSync(ref.absPath, 'utf8')).toBe('body\n');
  });

  it('refuses to write an empty doc', () => {
    expect(() =>
      writeDesignDoc({ kshetra: kshetra(), relPath: designDocRelPath('x'), content: '   ' }),
    ).toThrow(/empty/i);
  });

  // The guard fires BEFORE any filesystem side effect: an out-of-dir write
  // neither creates a directory nor a file.
  it('refuses an out-of-dir write without touching the filesystem', () => {
    const k = kshetra();
    expect(() =>
      writeDesignDoc({ kshetra: k, relPath: 'src/index.ts', content: 'malicious' }),
    ).toThrow(DesignDocPathError);
    expect(existsSync(join(k.repo.path, 'src/index.ts'))).toBe(false);
  });

  it('does NOT run any git operation (no .git is created or mutated)', () => {
    const k = kshetra();
    writeDesignDoc({
      kshetra: k,
      relPath: designDocRelPath('no-git'),
      content: 'design',
    });
    // Writing a doc must never initialise or touch a repo; the working tree gets
    // exactly one new file and nothing else.
    expect(existsSync(join(k.repo.path, '.git'))).toBe(false);
  });

  it('overwrites an existing doc in place (evolve, not fork — xa0.8 relies on this)', () => {
    const k = kshetra();
    const rel = designDocRelPath('evolving');
    writeDesignDoc({ kshetra: k, relPath: rel, content: 'v1' });
    const ref = writeDesignDoc({ kshetra: k, relPath: rel, content: 'v2' });
    expect(readFileSync(ref.absPath, 'utf8')).toBe('v2\n');
  });
});

describe('withDocLink (on-demand-read linkage)', () => {
  const path = '.shreni/design/sso.md';

  it('appends a link line to an existing description', () => {
    expect(withDocLink('Why this epic exists.', path)).toBe(
      `Why this epic exists.\n\nDesign doc (read before implementing): ${path}`,
    );
  });

  it('is the whole description when there was none', () => {
    expect(withDocLink(undefined, path)).toBe(
      `Design doc (read before implementing): ${path}`,
    );
    expect(withDocLink('', path)).toBe(`Design doc (read before implementing): ${path}`);
  });

  it('is idempotent — linking the same doc twice does not duplicate', () => {
    const once = withDocLink('desc', path);
    expect(withDocLink(once, path)).toBe(once);
  });

  it('refreshes a stale link to a different path rather than accumulating', () => {
    const stale = withDocLink('desc', '.shreni/design/old.md');
    const fresh = withDocLink(stale, path);
    expect(fresh).toBe(`desc\n\nDesign doc (read before implementing): ${path}`);
    expect(fresh).not.toContain('old.md');
  });
});

describe('linkDocIntoDecomposition', () => {
  function decomp(): Decomposition {
    return {
      epic: { ref: 'epic', title: 'SSO', type: 'epic', priority: 2, description: 'why' },
      children: [
        {
          ref: 'api',
          title: 'Auth API',
          type: 'task',
          priority: 1,
          acceptanceCriteria: 'token issued',
          description: 'the api',
        },
        {
          ref: 'ui',
          title: 'Login UI',
          type: 'feature',
          priority: 2,
          acceptanceCriteria: 'form renders',
        },
      ],
      deps: [{ blocked: 'ui', blocker: 'api' }],
    };
  }

  it('stamps the doc path into the epic and every child description', () => {
    const path = '.shreni/design/sso.md';
    const linked = linkDocIntoDecomposition(decomp(), path);
    expect(linked.epic.description).toContain(`Design doc (read before implementing): ${path}`);
    for (const c of linked.children) {
      expect(c.description).toContain(`Design doc (read before implementing): ${path}`);
    }
  });

  it('leaves acceptance criteria and deps untouched, and does not mutate the input', () => {
    const input = decomp();
    const linked = linkDocIntoDecomposition(input, '.shreni/design/sso.md');
    expect(linked.children[0].acceptanceCriteria).toBe('token issued');
    expect(linked.deps).toEqual([{ blocked: 'ui', blocker: 'api' }]);
    expect(input.epic.description).toBe('why'); // input unchanged
  });
});

describe('buildRememberFactArgv', () => {
  it('builds an argv array with a summary', () => {
    expect(
      buildRememberFactArgv({
        feature: 'SSO',
        docRelPath: '.shreni/design/sso.md',
        summary: 'established OIDC pattern',
      }),
    ).toEqual(['remember', 'SSO: established OIDC pattern See .shreni/design/sso.md.']);
  });

  it('builds a bare pointer without a summary', () => {
    expect(
      buildRememberFactArgv({ feature: 'SSO', docRelPath: '.shreni/design/sso.md' }),
    ).toEqual(['remember', 'SSO design recorded. See .shreni/design/sso.md.']);
  });

  it('never emits a shell string — operator text stays a single argv element', () => {
    const argv = buildRememberFactArgv({
      feature: '"; rm -rf ~',
      docRelPath: '.shreni/design/x.md',
    });
    expect(argv[0]).toBe('remember');
    expect(argv).toHaveLength(2);
    expect(argv[1]).toContain('"; rm -rf ~'); // literal, one element, no shell can see it
  });
});

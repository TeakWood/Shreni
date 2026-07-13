import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPack, listPacks, mergeStack, PackError, PACK_TEMPLATE_FILES } from './packs.js';

const VALID_PACK_YAML = `
name: nextjs-vitest
version: 1
description: Next.js App Router + TypeScript + vitest + eslint
detect:
  files: ["next.config.*"]
  packageJson:
    dependencies: ["next"]
    devDependencies: ["vitest"]
stack:
  language: typescript
  framework: nextjs
  packageManager: pnpm
  buildCommand: pnpm build
  testRunner: pnpm test
  lintCommand: pnpm lint
`;

let dir: string;

function writePack(packDir: string, yamlContent: string, templates: readonly string[] = PACK_TEMPLATE_FILES): void {
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'pack.yaml'), yamlContent);
  for (const f of templates) writeFileSync(join(packDir, f), `# ${f}\n`);
}

beforeEach(() => {
  dir = join(tmpdir(), `shreni-packs-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadPack', () => {
  it('parses a valid pack directory', () => {
    const packDir = join(dir, 'nextjs-vitest');
    writePack(packDir, VALID_PACK_YAML);
    const pack = loadPack(packDir);

    expect(pack.name).toBe('nextjs-vitest');
    expect(pack.version).toBe(1);
    expect(pack.dir).toBe(packDir);
    expect(pack.detect?.files).toEqual(['next.config.*']);
    expect(pack.detect?.packageJson?.dependencies).toEqual(['next']);
    expect(pack.stack.language).toBe('typescript');
    expect(pack.stack.buildCommand).toBe('pnpm build');
  });

  it('rejects unknown top-level fields', () => {
    const packDir = join(dir, 'p');
    writePack(packDir, VALID_PACK_YAML + '\nhooks: ["./evil.sh"]\n');
    expect(() => loadPack(packDir)).toThrow(PackError);
    expect(() => loadPack(packDir)).toThrow(/hooks/);
  });

  it('rejects stack fields that StackConfigSchema does not know (G1 subset rule)', () => {
    const packDir = join(dir, 'p');
    writePack(packDir, VALID_PACK_YAML.replace('stack:', 'stack:\n  notARealField: x'));
    expect(() => loadPack(packDir)).toThrow(PackError);
    expect(() => loadPack(packDir)).toThrow(/notARealField/);
  });

  it('rejects unknown detect fields', () => {
    const packDir = join(dir, 'p');
    writePack(packDir, VALID_PACK_YAML.replace('detect:', 'detect:\n  shell: ["run me"]'));
    expect(() => loadPack(packDir)).toThrow(/shell/);
  });

  it('requires a language in the pack stack', () => {
    const packDir = join(dir, 'p');
    writePack(packDir, VALID_PACK_YAML.replace('  language: typescript\n', ''));
    expect(() => loadPack(packDir)).toThrow(/language/);
  });

  it('rejects an invalid pack name', () => {
    const packDir = join(dir, 'p');
    writePack(packDir, VALID_PACK_YAML.replace('name: nextjs-vitest', 'name: NextJS!'));
    expect(() => loadPack(packDir)).toThrow(PackError);
  });

  it('accepts a pack without a detect block', () => {
    const packDir = join(dir, 'p');
    writePack(packDir, VALID_PACK_YAML.replace(/detect:[\s\S]*?devDependencies: \["vitest"\]\n/, ''));
    expect(loadPack(packDir).detect).toBeUndefined();
  });

  it('errors when pack.yaml is missing', () => {
    const packDir = join(dir, 'empty');
    mkdirSync(packDir, { recursive: true });
    expect(() => loadPack(packDir)).toThrow(/Cannot read pack.yaml/);
  });

  it('errors on invalid YAML', () => {
    const packDir = join(dir, 'p');
    writePack(packDir, 'name: [unclosed');
    expect(() => loadPack(packDir)).toThrow(/Invalid YAML/);
  });

  it('errors when a conventions template is missing', () => {
    const packDir = join(dir, 'p');
    writePack(packDir, VALID_PACK_YAML, ['style-guide.md', 'arch.md']);
    expect(() => loadPack(packDir)).toThrow(/review-guide\.md/);
  });
});

describe('listPacks', () => {
  it('returns every valid pack under the root', () => {
    writePack(join(dir, 'a-pack'), VALID_PACK_YAML.replace('nextjs-vitest', 'a-pack'));
    writePack(join(dir, 'b-pack'), VALID_PACK_YAML.replace('nextjs-vitest', 'b-pack'));
    mkdirSync(join(dir, 'not-a-pack'));
    writeFileSync(join(dir, 'stray-file.md'), 'x');

    const names = listPacks(dir).map(p => p.name).sort();
    expect(names).toEqual(['a-pack', 'b-pack']);
  });

  it('returns [] for a missing root dir', () => {
    expect(listPacks(join(dir, 'nope'))).toEqual([]);
  });

  it('throws when a listed pack is broken', () => {
    writePack(join(dir, 'broken'), 'name: broken\nversion: 1\n');
    expect(() => listPacks(dir)).toThrow(PackError);
  });
});

describe('mergeStack', () => {
  const packStack = {
    language: 'typescript',
    framework: 'nextjs',
    packageManager: 'pnpm',
    buildCommand: 'pnpm build',
    testRunner: 'pnpm test',
    lintCommand: 'pnpm lint',
  };

  it('fills in pack values where the user is silent', () => {
    const merged = mergeStack({ language: 'typescript' }, packStack);
    expect(merged.buildCommand).toBe('pnpm build');
    expect(merged.framework).toBe('nextjs');
  });

  it('lets explicit user values win over pack values', () => {
    const merged = mergeStack({ language: 'typescript', testRunner: 'pnpm test:unit' }, packStack);
    expect(merged.testRunner).toBe('pnpm test:unit');
    expect(merged.lintCommand).toBe('pnpm lint');
  });

  it('treats an explicit empty string as a deliberate user skip that wins', () => {
    const merged = mergeStack({ lintCommand: '' }, packStack);
    expect(merged.lintCommand).toBe('');
  });

  it('handles an undefined user stack (pure pack materialization)', () => {
    expect(mergeStack(undefined, packStack)).toEqual(packStack);
  });

  it('leaves fields unset by both user and pack absent, so profile defaults apply at runtime', () => {
    const merged = mergeStack({}, { language: 'go' });
    expect(merged.buildCommand).toBeUndefined();
    expect(merged.testRunner).toBeUndefined();
  });
});

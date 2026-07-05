import { describe, it, expect } from 'vitest';
import { cliArgs, selfExec, isStandaloneBinary } from './self-exec.js';

describe('cliArgs', () => {
  it('drops node + script path under node (argv.slice(2))', () => {
    expect(cliArgs(['node', '/x/index.js', 'start', '--all'])).toEqual(['start', '--all']);
  });

  it('works for a SEA argv, where Node pads argv[1] with the exec path', () => {
    expect(cliArgs(['/usr/local/bin/shreni', '/usr/local/bin/shreni', 'start', '--all'])).toEqual(['start', '--all']);
  });
});

describe('selfExec', () => {
  it('re-invokes node on the current entry script under node (sea=false)', () => {
    const launch = selfExec('__worker', ['myapp'], false);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([process.argv[1] ?? '', '__worker', 'myapp']);
  });

  it('re-invokes the binary directly under a SEA (sea=true)', () => {
    const launch = selfExec('__worker', ['myapp'], true);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(['__worker', 'myapp']);
  });

  it('supports a subcommand with no extra args', () => {
    expect(selfExec('__phalaka-server', [], true).args).toEqual(['__phalaka-server']);
  });
});

describe('isStandaloneBinary', () => {
  it('is false under a normal node/test process', () => {
    expect(isStandaloneBinary()).toBe(false);
  });
});
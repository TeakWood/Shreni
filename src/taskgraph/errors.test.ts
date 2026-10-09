import { describe, it, expect } from 'vitest';
import {
  TaskGraphError, CycleError, NotFound, ValidationError, MoveRefused, LeaseLost, LeaseHeld,
  VersionMismatch, SchemaBehind, Unavailable,
} from './errors';

describe('typed errors', () => {
  it('carry stable codes and their details', () => {
    const cases: [TaskGraphError, string, Record<string, unknown>][] = [
      [new CycleError('web-a', 'web-b'), 'CycleError', { taskId: 'web-a', dependsOnId: 'web-b' }],
      [new NotFound('task', 'web-a'), 'NotFound', { entity: 'task', id: 'web-a' }],
      [new ValidationError([{ validator: 'v', severity: 'error', message: 'm' }]), 'ValidationError',
        { findings: [{ validator: 'v', severity: 'error', message: 'm' }] }],
      [new MoveRefused('web-a', 'open', 'DependentsLive', ['web-b']), 'MoveRefused',
        { taskId: 'web-a', state: 'open', reason: 'DependentsLive', waiting: ['web-b'] }],
      [new LeaseLost('web-a', 'att-1'), 'LeaseLost', { taskId: 'web-a', attemptId: 'att-1' }],
      [new LeaseHeld('web-a', 'my-laptop/1'), 'LeaseHeld', { taskId: 'web-a', holder: 'my-laptop/1' }],
      [new VersionMismatch('lifecycle shreni.task 1 is not active (2 is)'), 'VersionMismatch', {}],
      [new SchemaBehind('0002_x'), 'SchemaBehind', { migration: '0002_x' }],
      [new Unavailable('connection dropped'), 'Unavailable', {}],
    ];
    for (const [err, code, fields] of cases) {
      expect(err).toBeInstanceOf(TaskGraphError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.name).toBe(code);
      expect(err.message).not.toBe('');
      expect(err).toMatchObject(fields);
    }
  });

  it('name the guard reason, or the waiting tasks, in MoveRefused', () => {
    expect(new MoveRefused('web-a', 'open', 'no open PR').message).toContain('no open PR');
    expect(new MoveRefused('web-a', 'open', 'DependentsLive', ['web-b', 'web-c']).message).toContain('web-b, web-c');
  });

  it('keep the underlying error as the cause of Unavailable, and no cause without one', () => {
    const cause = new Error('ECONNRESET');
    expect(new Unavailable('connection dropped', cause).cause).toBe(cause);
    expect('cause' in new Unavailable('connection dropped')).toBe(false);
  });

  it('show the warnings when a ValidationError has no errors', () => {
    expect(new ValidationError([{ validator: 'v', severity: 'warning', message: 'large plan' }]).message)
      .toContain('large plan');
  });
});

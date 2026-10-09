import { describe, it, expect } from 'vitest';
import { testLifecycle } from './test/lifecycle';
import { checkPermission } from './permissions';
import { NotPermitted } from './errors';

const l = testLifecycle();

describe('checkPermission', () => {
  it('allows a role listed for any state', () => {
    expect(() => checkPermission(l, 'links.add', 'agent', 'claimed')).not.toThrow();
    expect(() => checkPermission(l, 'plans.create', 'planner')).not.toThrow();
  });

  it('allows a role listed for the task\'s state, and refuses it in any other', () => {
    expect(() => checkPermission(l, 'tasks.update', 'planner', 'proposed')).not.toThrow();
    const err = (() => { try { checkPermission(l, 'tasks.update', 'planner', 'open'); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(NotPermitted);
    expect(err).toMatchObject({ code: 'NotPermitted', call: 'tasks.update', role: 'planner', state: 'open' });
  });

  it('refuses a role not listed for the call', () => {
    expect(() => checkPermission(l, 'notes.add', 'planner', 'open')).toThrow(NotPermitted);
    expect(() => checkPermission(l, 'lifecycles.activate', 'orchestrator')).toThrow(/orchestrator.*lifecycles\.activate/);
  });

  it('refuses every role for a call the permissions don\'t list', () => {
    const bare = testLifecycle();
    delete bare.permissions['notes.add'];
    expect(() => checkPermission(bare, 'notes.add', 'developer', 'open')).toThrow(NotPermitted);
  });

  it('refuses a state-limited permission when there is no task state to check', () => {
    expect(() => checkPermission(l, 'tasks.update', 'planner')).toThrow(NotPermitted);
  });
});

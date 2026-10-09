import type { Call, Lifecycle } from './lifecycle';
import { NotPermitted } from './errors';

// Permissions for the calls that aren't moves (engine spec, "Roles and
// access"): for each call, the roles allowed and, if given, the states the task
// must be in. A call the permissions don't list is refused for every role.

/**
 * Throws NotPermitted unless `role` may make `call`. `state` is the state of the
 * task the call acts on (for deps, the task that waits); a role limited to
 * certain states is refused when there is no task state to check.
 */
export function checkPermission(lifecycle: Lifecycle, call: Call, role: string, state?: string): void {
  const roles = lifecycle.permissions[call];
  const allowed = roles && Object.hasOwn(roles, role) ? roles[role] : undefined;
  if (allowed === true) return;
  if (allowed && state !== undefined && allowed.includes(state)) return;
  throw new NotPermitted(call, role, state);
}

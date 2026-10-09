// Advisory lock namespaces. Engine locks use the two-key form
// pg_advisory_xact_lock(namespace, key), so keys in different namespaces can't
// collide the way hashtext of prefixed strings can in one 32-bit space.
export const LOCK_NAMESPACE = {
  migrate: 74_670_001,
  events: 74_670_002,
} as const;

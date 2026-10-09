// The task JSON the tracker's show returns (TrackerCalls.show): an array whose
// first element is the requested task and whose remaining elements are its
// dependencies; each carries an `acceptance_criteria` field.

// Extract a task's acceptance criteria from that payload. Returns the trimmed
// criteria text for `id`, or '' when the payload is unparseable, `id` is absent,
// or the task has no criteria recorded — callers render their own placeholder.
export function parseAcceptanceCriteria(taskDetailsJson: string, id: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(taskDetailsJson);
  } catch {
    return '';
  }
  if (!Array.isArray(parsed)) return '';
  const task = parsed.find(
    (b): b is { id?: string; acceptance_criteria?: string } =>
      typeof b === 'object' && b !== null && (b as { id?: string }).id === id,
  );
  const criteria = task?.acceptance_criteria;
  return typeof criteria === 'string' ? criteria.trim() : '';
}

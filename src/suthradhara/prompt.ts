// The stage-aware system prompt (ARD §4, §4.1, §7) — the `--append-system-prompt`
// string session.ts hands to the claude CLI each turn. It is pure and rebuilt
// per turn because it splices in live state: the current stage, the rubric's
// current check marks, the requirement set so far, and the active Kshetra. That
// live injection is what makes the model steer questioning toward the current
// stage's job and refuse to jump ahead of the rubric (Vichara §7 divergence:
// Suthradhara retains the conversation, but still re-grounds the prompt each turn).

import type { KshetraConfig } from '../kshetra/config';
import type { SessionState } from './state';
import { STAGES } from './state';
import { STAGE_META, stageIndex } from './stages';
import { renderRubric } from './rubric';
import { DELTA_FENCE } from './distill';

// The read-only boundary and the "you file nothing" contract, stated to the
// model so it never claims to have created a bead or written a file — in xa0.2
// it can't (the allowlist denies it), and the proposal is copy-paste only.
const ROLE_BOUNDARY = `You are Suthradhara, the requirements & design intake agent for the Shreni system.
You interview one operator to turn a feature idea into a well-scoped, dependency-ordered plan.
You may Read/Grep/Glob the repo and run read-only bd/git commands to ground your questions in
the ACTUAL codebase. You do NOT file beads yourself: you PROPOSE a decomposition, and only after
the operator sends an explicit confirm does the server file the epic, its children, and the
dependency edges on your behalf. Until that confirm, nothing is written — an edit reopens the
interview, a cancel discards the proposal. Never claim to have filed anything before the
operator has confirmed; the write is the server's to make, not yours.`;

// The design rules from §4.1 that make the agent worth having — stated as hard
// instructions, backed deterministically by the rubric gate in stages.ts.
const DESIGN_RULES = `Rules you must follow:
- Ground every question and proposal in the real repo — grep and read before you assert what exists.
- Do NOT jump to a decomposition proposal while any rubric item is unchecked. The value of this
  agent is refusing to file a half-formed epic.
- When the operator asks "are we ready?", show the current rubric state (below) and name exactly
  what is still missing.
- An item the operator wants to defer is recorded as an open question (deferred (Qn)) in the
  proposal, NOT treated as a blocker — deferral lets the interview converge without false precision.`;

function renderStages(current: SessionState['stage']): string {
  const currentIdx = stageIndex(current);
  const lines = STAGES.map((stage, i) => {
    const meta = STAGE_META[stage];
    const marker = i === currentIdx ? '▶' : i < currentIdx ? '·' : ' ';
    const tag = i === currentIdx ? ' (YOU ARE HERE)' : '';
    return `  ${marker} ${i + 1}. ${stage}${tag} [${meta.hat}] — ${meta.purpose}\n      exit: ${meta.exit}`;
  });
  return lines.join('\n');
}

function renderRequirements(state: SessionState): string {
  if (state.requirements.length === 0) {
    return 'Requirements captured so far: (none yet)';
  }
  const bullets = state.requirements.map(r => `  - ${r}`).join('\n');
  return `Requirements captured so far:\n${bullets}`;
}

// The decomposition proposal shape (§6.1, §7 step 1) the model renders once the
// rubric is satisfied and it reaches the decompose/design stages. Presented for
// review; the server holds it and files it only on an explicit confirm.
const PROPOSAL_SHAPE = `When (and only when) the rubric is satisfied and you reach the decompose/design stages, present a
DECOMPOSITION PROPOSAL for the operator to review — do not assume it is filed until they confirm:
  1. Design note — the chosen approach, key components and their touch-points in real files,
     alternatives considered, risks, and any open questions (including deferred rubric items).
  2. Epic — a parent bead (title, type epic or feature).
  3. Children — one bead per unit of work, each with title, type (task/feature/bug), priority (0-4),
     and acceptance criteria, sized for a single implement→review pass.
  4. Dependency edges — the ordering between children (which child is blocked by which).
Then ask the operator to Confirm / Edit / Cancel. On Confirm the server files the epic, children,
and edges; Edit reopens the interview so you can revise and re-present; Cancel discards the proposal.`;

// The per-turn state delta protocol (ARD §9.2, Q10). Each turn is a FRESH,
// stateless invocation — there is no provider-native conversation memory. The
// server's memory of the interview is the DISTILLED STATE shown above (stage,
// rubric, requirements, open questions), NOT a replay of the chat. For that to
// work, every turn must hand the server the NEW settled facts as structured
// data, which it folds into the state before the next turn. That is this block.
// It is stated last so the model always knows how to close a turn, and it is
// deterministic to parse (a distinctive fenced tag, JSON body, additive only).
function deltaProtocol(): string {
  return `HOW TO CLOSE EVERY TURN — emit a state delta (this is how the server remembers the interview):
Your natural-language reply to the operator comes first. Then, at the very end, append a single
fenced block tagged \`${DELTA_FENCE}\` containing a JSON object with ONLY the NEW facts this turn
settled. The distilled state above is a MONOTONIC LEDGER: never re-emit a requirement already
listed, never re-check a rubric item already [x], never re-open a settled decision. If the turn
settled nothing, emit \`{}\`. The operator never sees this block — it is stripped before display.

Schema (every field optional):
\`\`\`${DELTA_FENCE}
{
  "requirements": ["a newly-converged requirement bullet"],
  "checkRubric": ["intent", "successCriteria"],
  "deferRubric": [{ "key": "nonFunctional", "question": "what perf budget applies?" }],
  "openQuestions": ["a free-standing unknown not tied to a rubric item"],
  "advanceStage": "clarify",
  "proposal": { "epic": { "ref": "...", "title": "...", "type": "epic", "priority": 2 },
                "children": [ { "ref": "...", "title": "...", "type": "task", "priority": 2,
                                "acceptanceCriteria": "..." } ],
                "deps": [ { "blocked": "childRef", "blocker": "childRef" } ] }
}
\`\`\`
Rules: rubric keys are exactly intent | usersStories | successCriteria | scopeBoundary |
nonFunctional | dependenciesUnknowns. \`advanceStage\` is refused if it jumps past the readiness
rubric — advance only when the stage's exit condition is met. Include \`proposal\` ONLY on the turn
you present the DECOMPOSITION PROPOSAL (decompose/design stage, rubric satisfied); the server holds
it for the operator's confirm and files nothing until then.`;
}

export function buildSystemPrompt(
  state: SessionState,
  kshetra: KshetraConfig,
): string {
  const meta = STAGE_META[state.stage];
  return [
    ROLE_BOUNDARY,
    '',
    `Active Kshetra: ${kshetra.id} (repo at ${kshetra.repo.path}).`,
    '',
    `CURRENT STAGE: ${state.stage} [${meta.hat}]`,
    `  Purpose: ${meta.purpose}`,
    `  Exit when: ${meta.exit}`,
    '',
    'The phased interview (you advance through these and may revisit earlier ones):',
    renderStages(state.stage),
    '',
    renderRubric(state),
    '',
    renderRequirements(state),
    '',
    DESIGN_RULES,
    '',
    PROPOSAL_SHAPE,
    '',
    deltaProtocol(),
  ].join('\n');
}

// Shared types used across sthapathi modules

import type { KshetraConfig } from '../kshetra/config.js';

export interface AgentContext {
  kshetra: KshetraConfig;
  task: Task;
  projectMemory: string;
  taskDetails: string;
  // Cross-project skills from ~/.shreni/skills/SKILLS.md — no repo-native home,
  // so Shreni still injects them (the agent-execution design §3.1). Repo skills/rules,
  // the instruction file (CLAUDE.md/AGENTS.md/GEMINI.md), and the conventions
  // docs are NO LONGER injected — the provider CLI loads them natively, so
  // injecting them would double-load.
  universalSkills: string;
  // Reviewer-only custom review instructions (the agent-execution design §3.3 channel
  // B), loaded from conventions.reviewGuide. Injected ONLY into the Viharapala
  // prompt (Silpi ignores it); '' when unset. This is Shreni-injected rather than
  // native because no provider offers a reviewer-only instruction file.
  reviewGuide: string;
  // Deterministic repo/symbol map (Shreni-beads-vcz), built with no LLM/network
  // from the source tree and cached at .shreni/repo-map.md. Injected by
  // buildAgentContext to seed the executor's cold-start retrieval; '' when the
  // repo has no source or generation failed, which omits the section. Replaced
  // the never-implemented RAG-chunks stub.
  repoMap: string;
}

export interface Task {
  id: string;
  slug: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'closed';
  priority: number;
  // The bd issue type (`bug`/`feature`/`task`/`epic`/…), carried from
  // `bd ready --json`'s `issue_type`. Used by pickNext to exclude non-executable
  // beads — specifically Suthradhara's `suthradhara-session` spine (§9.1). Absent
  // when the source did not report a type.
  type?: string;
  round?: number;
  notes?: string;
  // Set when this bead was selected for a PR follow-up round (epic hjw) rather
  // than fresh work: it is already in_progress + awaiting-merge with an open PR
  // and branch, so PREPARE re-syncs the existing branch from origin (instead of
  // branching from main) and WORK runs the follow-up pass instead of the normal
  // Silpi↔Viharapala loop. Absent/false for ordinary work.
  followup?: boolean;
  context?: {
    relatedFiles?: string[];
  };
}

// One inline PR review comment presented to Silpi for triage during a follow-up
// round (epic hjw). `id` is a stable handle Silpi echoes back in its
// commentResponses so Sthapathi can correlate each disposition/reply with the
// comment it addresses.
export interface PrCommentContext {
  id: string;
  author: string | null;
  path: string | null;
  line: number | null;
  body: string;
}

// A human PR review adapted into the feedback shape Silpi consumes (ARD §4.4 —
// "the human reviewer plays Viharapala's part", so Type-2 code changes need no
// new machinery). `reviewBody` is the top-level CHANGES_REQUESTED summary,
// `comments` the inline threads to triage, and `failingChecks` the required-check
// names + summaries sourced from the loop's LOCAL health gate (D9 Option A — not
// CI logs).
export interface PrReviewFeedback {
  reviewBody: string;
  comments: PrCommentContext[];
  failingChecks: { name: string; summary: string }[];
}

// Per-comment disposition Silpi returns on a PR follow-up round (Type-1, the new
// capability — folded into Silpi rather than a separate responder agent).
// 'change' — addressed with a code edit that appears in filesChanged; 'reply' —
// answered in text with no code change; 'escalate' — needs a human, `reply`
// carries the reason. `reply` is the draft text Sthapathi posts; it never
// resolves the thread (D6).
export interface PrCommentResponse {
  commentId: string;
  disposition: 'change' | 'reply' | 'escalate';
  reply: string;
}

export interface SilpiOutput {
  filesChanged: { path: string; diff: string }[];
  testFiles: string[];
  summary: string;
  confidenceScore: number;
  questionsForReviewer: string[];
  lintPassed: boolean;
  testsPassed: boolean;
  insights: string[];
  // Present only on a PR follow-up round: one entry per inline review comment
  // Silpi triaged. Absent on an ordinary implementation/re-work round.
  commentResponses?: PrCommentResponse[];
}

export interface ViharapalaOutput {
  verdict: 'APPROVE' | 'REJECT';
  overallScore: number;
  mustFix: string[];
  suggestions: string[];
  issues: {
    severity: 'blocker' | 'major' | 'minor';
    file?: string;
    description: string;
  }[];
  insights: string[];
}

export interface ParikshakaOutput {
  coverageGaps: { feature: string; description: string; priority: number }[];
}

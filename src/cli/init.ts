import { basename, resolve } from 'path';
import { createInterface } from 'readline';
import { initKshetra } from './init-kshetra';

export interface InitOpts {
  slug?: string;
  path?: string;
  org?: string;
  language?: string;
  beadsPath?: string;
  provider?: string;
  model?: string;
  mergePolicy?: 'push' | 'pr';
  dryRun?: boolean;
}

// Ask a question, showing `def` as the bracketed default; empty input keeps it.
async function promptWithDefault(question: string, def: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>(res => rl.question(`${question} [${def}]: `, res));
    return answer.trim() || def;
  } finally {
    rl.close();
  }
}

// `shreni init` — the friendly, minimal-args front door to onboarding (yds.1).
// It resolves the two things init-kshetra always needs — slug and path — so the
// common case is a single command: on a TTY it prompts with sensible defaults
// (path = cwd, slug = its basename); non-interactively it falls back to those
// same defaults. Everything else (provider selection, the beads-repo creation,
// config, hooks, registration) is delegated unchanged to initKshetra.
//
// NOTE (yds.1 scope): this wraps the existing flow — it does NOT create the app
// repo or its GitHub remote. The repo at --path must already exist with an
// `origin` remote (enforced by initKshetra's Config phase). Auto-scaffolding a
// brand-new app repo is deliberately out of scope for this wrapper.
export async function runInit(opts: InitOpts): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY);

  const rawPath =
    opts.path ??
    (interactive ? await promptWithDefault('Repo path', process.cwd()) : process.cwd());
  const path = resolve(rawPath);

  const slug =
    opts.slug ??
    (interactive ? await promptWithDefault('Kshetra slug', basename(path)) : basename(path));

  return initKshetra({
    slug,
    path,
    org: opts.org,
    language: opts.language,
    beadsPath: opts.beadsPath,
    provider: opts.provider,
    model: opts.model,
    mergePolicy: opts.mergePolicy,
    dryRun: opts.dryRun,
  });
}
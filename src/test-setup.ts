import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Isolate the home directory for the whole test process so nothing can write
// into the developer's real `~/.shreni` (activity logs, kshetra state, etc.).
//
// `os.homedir()` reads the HOME (POSIX) / USERPROFILE (Windows) env var first,
// so overriding them here redirects every homedir()-derived path — e.g.
// activity-log.ts's emit() — into a throwaway temp dir. Without this, fixture
// events (the `sishya` kshetra, `proj-42` task) leaked into the real log.
const fakeHome = mkdtempSync(join(tmpdir(), 'shreni-test-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
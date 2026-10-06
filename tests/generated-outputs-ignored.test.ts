import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Production tools write receipts/reports containing Clerk user ids + Stripe subscription ids into the working directory.
// Every default output location used by a tool must be git-ignored; adding a tool with a new default output without
// updating .gitignore fails this test.
const TOOLS = ['scripts/prod-entitlement-reconcile.ts', 'scripts/reconcile-dry-run.ts', 'scripts/forensics/webhook-payload-contract.ts', 'scripts/repair-stale-cancellations.ts'];
const defaultsOf = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(l => l.includes('--out'))
  .flatMap(l => { const m = /\|\|\s*'([^']+)'|:\s*'([^']+\.json)'/.exec(l); return m ? [m[1] || m[2]] : []; });
const ignored = (p: string) => { try { execFileSync('git', ['check-ignore', '-q', p], { stdio: 'ignore' }); return true; } catch { return false; } };

describe('generated production outputs are git-ignored', () => {
  it('finds a default output for every tool (guards the extraction itself)', () => {
    for (const t of TOOLS) expect(defaultsOf(t), t).not.toHaveLength(0);
  });
  it.each(TOOLS)('%s default output is ignored', (t) => {
    for (const d of defaultsOf(t)) expect(ignored(d.endsWith('.json') ? d : `${d}/receipt.json`), `${t} writes ${d}`).toBe(true);
  });
  it('does not use a blanket *.json rule', () => {
    expect(readFileSync('.gitignore', 'utf8')).not.toMatch(/^\*\*?\/?\*\.json\s*$/m);
  });
});

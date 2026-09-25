import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The Glama entry points to this repository. Keep its source separate, and pin
// its revision so updates to the MCP server cannot silently change trade code.
const repo = 'https://github.com/glabun002/after-hours-dip-agent.git';
const revision = '4a1c9859d25e9ee98853923bb787421a5c6d2585';
const runtime = resolve('.runtime');
const target = resolve(runtime, 'after-hours-dip-agent');
mkdirSync(runtime, { recursive: true });
if (!existsSync(target)) execFileSync('git', ['clone', repo, target], { stdio: 'inherit' });
execFileSync('git', ['fetch', 'origin', revision], { cwd: target, stdio: 'inherit' });
execFileSync('git', ['checkout', '--detach', revision], { cwd: target, stdio: 'inherit' });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();
const trackedChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: target, encoding: 'utf8' }).trim();
if (head !== revision || trackedChanges) throw new Error('Pinned upstream checkout differs from the reviewed revision');
execFileSync('npm', ['ci'], { cwd: target, stdio: 'inherit' });
console.log(`MCP server ready at ${target} (${revision})`);

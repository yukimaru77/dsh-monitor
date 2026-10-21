import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from '../index.js';

/** Minimal DSH context: tool/command registries, agent lifecycle hooks and a fixed cwd. */
function harness(cwd) {
  const tools = new Map(), commands = new Map(), listeners = new Map(), cleanups = [];
  const ctx = {
    on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); },
    effect: fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    commands: { register: command => { commands.set(command.name, command); return () => commands.delete(command.name); } },
    workingDirectory: { ensure: async () => cwd },
  };
  apply(ctx);
  const agent = (status = 'idle') => {
    const delivered = [];
    return { status, delivered, followup: m => delivered.push(['followup', m]), inject: m => delivered.push(['inject', m]) };
  };
  const call = (name, args, owner) => tools.get(name).execute(args, { agent: owner, signal: new AbortController().signal });
  const run = (name, rawInput, owner) => commands.get(name).handler({ agent: owner, rawInput, signal: new AbortController().signal });
  const dispose = () => { for (const cleanup of cleanups.reverse()) cleanup(); };
  return { tools, commands, listeners, agent, call, run, dispose };
}
const textOf = message => message.content.map(block => block.text).join('');
async function until(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error('timed out'); await delay(20); }
}

test('registers the Pi tool and command names', t => {
  const h = harness(process.cwd()); t.after(h.dispose);
  assert.deepEqual([...h.tools.keys()], ['monitor_start', 'monitor_watch_path', 'monitor_list', 'monitor_stop']);
  assert.deepEqual([...h.commands.keys()], ['monitor', 'monitor-watch', 'monitors', 'monitor-stop']);
});

test('a finished command wakes an idle session once with its output and exit status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-monitor-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir); t.after(h.dispose);
  const owner = h.agent('idle');
  const started = await h.call('monitor_start', { description: 'build', command: 'pwd; echo out; echo err >&2; exit 3', instruction: 'Fix it.' }, owner);
  assert.match(started, /^Started monitor mon-1: build/);
  await until(() => owner.delivered.length === 1);
  const [mode, message] = owner.delivered[0];
  assert.equal(mode, 'followup');
  assert.equal(message.source.kind, 'monitor');
  const body = textOf(message);
  assert.match(body, /untrusted external data/);
  assert.match(body, /Handling instruction: Fix it\./);
  assert.ok(body.includes(`| ${await import('node:fs').then(fs => fs.realpathSync(dir))}`) || body.includes(`| ${dir}`), 'runs in the session working directory');
  assert.match(body, /\| out\n/);
  assert.match(body, /\| err\n/);
  assert.match(body, /Monitor mon-1 stopped: process exited code=3 signal=null/);
  assert.match(await h.call('monitor_list', { status: 'stopped' }, owner), /mon-1 \[stopped\] shell "build"/);
});

test('interval batches go to a busy session by injection and empty intervals stay silent', async t => {
  const h = harness(process.cwd()); t.after(h.dispose);
  const owner = h.agent('running');
  await h.call('monitor_start', { description: 'ticks', command: 'echo one; sleep 1; sleep 1', interval_minutes: 0.005 }, owner);
  await until(() => owner.delivered.length >= 1);
  await delay(700);
  assert.equal(owner.delivered.length, 1, 'later empty intervals send nothing');
  assert.equal(owner.delivered[0][0], 'inject');
  assert.match(textOf(owner.delivered[0][1]), /\| one/);
  assert.equal((await h.run('monitor-stop', ' all', owner)).text, 'Stopped 1 monitor(s).');
  await until(() => owner.delivered.length === 2);
  assert.match(textOf(owner.delivered[1][1]), /stopped: manual stop; process exited/);
});

test('monitors belong to their session: others cannot list or stop them, and session end stops them silently', async t => {
  const h = harness(process.cwd()); t.after(h.dispose);
  const a = h.agent(), b = h.agent();
  const result = await h.run('monitor', ' sleeper :: sleep 30', a);
  assert.deepEqual(result, { kind: 'success', text: 'Started mon-1' });
  assert.equal(await h.call('monitor_list', {}, b), 'No running monitors.');
  assert.equal(await h.call('monitor_stop', { id: 'mon-1' }, b), 'No monitor found with id mon-1.');
  h.listeners.get('agent/disposed')({ agent: a });
  await delay(300);
  assert.equal(a.delivered.length, 0, 'no wakeup to an ended session');
  assert.equal((await h.run('monitor', ' missing separator', a)).kind, 'error');
});

test('path watcher reports changes and a stop notice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-monitor-watch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir); t.after(h.dispose);
  const owner = h.agent();
  assert.deepEqual(await h.run('monitor-watch', ' . config dir', owner), { kind: 'success', text: 'Started mon-1' });
  await delay(100);
  await writeFile(join(dir, 'a.txt'), 'x');
  await until(() => owner.delivered.length >= 1);
  assert.match(textOf(owner.delivered[0][1]), /a\.txt/);
  await h.call('monitor_stop', { id: 'mon-1' }, owner);
  await until(() => owner.delivered.some(([, m]) => /Monitor mon-1 stopped: manual stop/.test(textOf(m))));
});

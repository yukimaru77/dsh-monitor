import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from '../index.js';

/** In-memory job registry with the read cursor semantics of @deepseek-ai/dsh-jobs. */
function fakeJobs() {
  const jobs = new Map(), listeners = [];
  const emit = event => listeners.forEach(fn => fn(event));
  return {
    events: { subscribe: (_filter, fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); } },
    get(id) { const j = jobs.get(id); if (!j) throw new Error('unknown job'); return j.view; },
    read(id) { const j = jobs.get(id); const chunks = j.chunks.slice(j.cursor); j.cursor = j.chunks.length; return { chunks, lossy: false, job: j.view }; },
    start(id, owner, label = 'build') {
      const view = { id, kind: 'bash', label, owner, status: 'running' };
      jobs.set(id, { view, chunks: [], cursor: 0 });
      emit({ type: 'registered', job: view });
    },
    write(id, text, channel = 'stdout') { jobs.get(id).chunks.push({ at: Date.now(), text, channel }); },
    settle(id) { const j = jobs.get(id); j.view = { ...j.view, status: 'completed' }; emit({ type: 'settled', job: j.view, cause: 'producer', awaited: false }); },
    agentRead: id => { const j = jobs.get(id); j.cursor = j.chunks.length; },
  };
}

function harness(cwd, options = {}) {
  const tools = new Map(), commands = new Map(), listeners = new Map(), cleanups = [];
  const agents = new Map();
  const contexts = new Map();
  const jobs = fakeJobs();
  const ctx = {
    on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); },
    effect: fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    commands: { register: command => { commands.set(command.name, command); return () => commands.delete(command.name); } },
    workingDirectory: { ensure: async () => cwd },
    agents: { get: id => agents.get(id) },
    jobs,
    systemPrompt: { context: c => { contexts.set(c.name, c); return () => contexts.delete(c.name); } },
    ...options.ctx,
  };
  const { ctx: _extra, ...config } = options;
  apply(ctx, config);
  const agent = (id = 'session-1', status = 'idle') => {
    const delivered = [];
    const a = { id, session: { id }, status, delivered, followup: m => delivered.push(['followup', m]), inject: m => delivered.push(['inject', m]) };
    agents.set(id, a);
    return a;
  };
  const call = (name, args, owner) => tools.get(name).execute(args, { agent: owner, signal: new AbortController().signal });
  const run = (name, rawInput, owner) => commands.get(name).handler({ agent: owner, rawInput, signal: new AbortController().signal });
  const dispose = () => { for (const cleanup of cleanups.reverse()) cleanup(); };
  return { tools, commands, listeners, agent, call, run, dispose, jobs, contexts, ctx };
}
const textOf = message => message.content.map(block => block.text).join('');
async function until(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error('timed out'); await delay(20); }
}

test('offers command monitors only; paths are watched with a command', t => {
  const h = harness(process.cwd()); t.after(h.dispose);
  assert.deepEqual([...h.tools.keys()], ['monitor_start', 'monitor_list', 'monitor_stop']);
  assert.deepEqual([...h.commands.keys()], ['monitor', 'monitors', 'monitor-stop']);
});

test('the model is told how bash jobs and monitors report back, and to keep monitors quiet', t => {
  const h = harness(process.cwd()); t.after(h.dispose);
  const text = h.contexts.get('shell-commands').text();
  assert.match(text, /bash waits up to 10 seconds/);
  assert.match(text, /every 30 minutes/);
  assert.match(text, /instead of blocking on job_output/);
  assert.match(text, /prints continuously wakes you endlessly and fills the context/);
  assert.match(h.tools.get('monitor_start').description, /fills its context/);
});

test('a finished command wakes an idle session with its output and exit status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-monitor-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir); t.after(h.dispose);
  const owner = h.agent('session-1', 'idle');
  const started = await h.call('monitor_start', { description: 'build', command: 'pwd; echo out; echo err >&2; exit 3', instruction: 'Fix it.' }, owner);
  assert.match(started, /^Started monitor mon-1: build/);
  await until(() => owner.delivered.some(([, m]) => /stopped: process exited/.test(textOf(m))));
  const [mode, message] = owner.delivered[0];
  assert.equal(mode, 'followup');
  assert.equal(message.source.kind, 'monitor');
  const body = owner.delivered.map(([, m]) => textOf(m)).join('\n');
  assert.match(body, /untrusted external data/);
  assert.match(body, /Handling instruction: Fix it\./);
  assert.ok(body.includes(`| ${await import('node:fs').then(fs => fs.realpathSync(dir))}`) || body.includes(`| ${dir}`), 'runs in the session working directory');
  assert.match(body, /\| out\n/);
  assert.match(body, /\| err\n/);
  assert.match(body, /Monitor mon-1 stopped: process exited code=3 signal=null/);
  assert.match(await h.call('monitor_list', { status: 'stopped' }, owner), /mon-1 \[stopped\] shell "build"/);
});

test('by default each burst of output is sent as it appears', async t => {
  const h = harness(process.cwd()); t.after(h.dispose);
  const owner = h.agent('session-1', 'idle');
  await h.call('monitor_start', { description: 'bursts', command: 'echo one; echo two; sleep 2; echo three; sleep 2' }, owner);
  await until(() => owner.delivered.length === 1);
  assert.match(textOf(owner.delivered[0][1]), /\| one\n\| two/);
  assert.doesNotMatch(textOf(owner.delivered[0][1]), /three|stopped/);
  await until(() => owner.delivered.length === 2);
  assert.match(textOf(owner.delivered[1][1]), /\| three/);
  assert.doesNotMatch(textOf(owner.delivered[1][1]), /one|stopped/);
  await until(() => owner.delivered.length === 3);
  assert.match(textOf(owner.delivered[2][1]), /stopped: process exited code=0/);
});

test('interval batches go to a busy session by injection and empty intervals stay silent', async t => {
  const h = harness(process.cwd()); t.after(h.dispose);
  const owner = h.agent('session-1', 'running');
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
  const a = h.agent('a'), b = h.agent('b');
  const result = await h.run('monitor', ' sleeper :: sleep 30', a);
  assert.deepEqual(result, { kind: 'success', text: 'Started mon-1' });
  assert.equal(await h.call('monitor_list', {}, b), 'No running monitors.');
  assert.equal(await h.call('monitor_stop', { id: 'mon-1' }, b), 'No monitor found with id mon-1.');
  h.listeners.get('agent/disposed')({ agent: a });
  await delay(300);
  assert.equal(a.delivered.length, 0, 'no wakeup to an ended session');
  assert.equal((await h.run('monitor', ' missing separator', a)).kind, 'error');
});

test('a running bash job reports unread output with its job id each interval; empty intervals are silent', async t => {
  const h = harness(process.cwd(), { reportIntervalMs: 40 }); t.after(h.dispose);
  const owner = h.agent('session-1', 'idle');
  h.jobs.start('bash-1', 'session-1', 'npm test');
  h.jobs.write('bash-1', 'seen\n');
  h.jobs.agentRead('bash-1'); // the agent already read this with job_output
  h.jobs.write('bash-1', 'one\ntwo\n');
  h.jobs.write('bash-1', 'warn\n', 'stderr');
  h.jobs.write('bash-1', 'internal\n', 'log');
  await until(() => owner.delivered.length === 1);
  const [mode, message] = owner.delivered[0];
  assert.equal(mode, 'followup');
  const body = textOf(message);
  assert.match(body, /Job: bash-1 \(npm test\)/);
  assert.match(body, /job_output\(job_id="bash-1"\)/);
  assert.match(body, /\| one\n\| two\n\| warn/);
  assert.doesNotMatch(body, /seen|internal/);
  await delay(100);
  assert.equal(owner.delivered.length, 1, 'no new output, no report');
  owner.status = 'running';
  h.jobs.write('bash-1', 'three\n');
  await until(() => owner.delivered.length === 2);
  assert.equal(owner.delivered[1][0], 'inject', 'a busy session gets the report at its next step');
  h.jobs.settle('bash-1');
  h.jobs.write('bash-1', 'after\n');
  await delay(100);
  assert.equal(owner.delivered.length, 2, 'completion is left to dsh-tool-jobs');
});

test('non-bash jobs and unowned jobs are not reported', async t => {
  const h = harness(process.cwd(), { reportIntervalMs: 30 }); t.after(h.dispose);
  const owner = h.agent('session-1');
  h.jobs.start('bash-x', undefined);
  h.jobs.write('bash-x', 'x\n');
  await delay(100);
  assert.equal(owner.delivered.length, 0);
});

/** One live goal per agent with the activation edges of @deepseek-ai/dsh-goal. */
function fakeGoals() {
  const goals = new Map(), log = [];
  return {
    log,
    set: (agent, goal) => goals.set(agent, { id: 'goal-1', revision: 1, phase: 'active', activation: 'armed', ...goal }),
    get: agent => goals.get(agent) && { ...goals.get(agent) },
    disarm(agent) { log.push('disarm'); goals.get(agent).activation = 'disarmed'; },
    resume(agent, ref) {
      const goal = goals.get(agent);
      assert.deepEqual(ref, { id: goal.id, revision: goal.revision });
      log.push('resume'); goal.activation = 'armed'; goal.revision += 1;
    },
  };
}
function goalHarness() {
  const goals = fakeGoals();
  const h = harness(process.cwd(), { ctx: { get: name => (name === 'goals' ? goals : undefined), jobs: { ...fakeJobs(), list: () => listed } } });
  let listed = [];
  const owner = h.agent('session-1', 'idle');
  const emit = event => h.listeners.get('session/event')(owner.session, event);
  const turn = (text, reason = 'completed', { user = false, before = [] } = {}) => {
    emit({ type: 'turn/start', data: { turn: 1 } });
    if (user) emit({ type: 'user/message', data: { source: { kind: 'user' } } });
    for (const step of before) emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: step }, { type: 'tool-call', name: 'read' }] } } });
    emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
    emit({ type: 'turn/end', data: { reason: { kind: reason } } });
  };
  /** A first GOAL_WAIT asks; the next turn ending with GOAL_WAIT enters the wait. */
  const confirmedWait = text => { turn(text); turn(text); };
  const status = s => h.listeners.get('agent/status')({ agent: owner, status: s });
  return { ...h, goals, owner, turn, confirmedWait, status, setJobs: jobs => { listed = jobs; } };
}

test('GOAL_WAIT with a running bash job disarms goal rounds until the next turn rearms them', t => {
  const h = goalHarness(); t.after(h.dispose);
  h.goals.set(h.owner);
  h.setJobs([{ id: 'job-1', kind: 'bash', owner: 'session-1', status: 'running' }]);
  h.turn('The build runs in job-1.\nGOAL_WAIT');
  assert.equal(h.goals.get(h.owner).activation, 'armed');
  assert.match(h.contexts.get('goal-wait').text({ scope: h.owner }), /not entered yet[\s\S]*end this turn with GOAL_WAIT again/);
  h.turn('Nothing independent remains.\nGOAL_WAIT');
  assert.equal(h.goals.get(h.owner).activation, 'disarmed');
  assert.equal(h.goals.get(h.owner).phase, 'active');
  // The job notification opens a turn: the goal is rearmed and that turn continues it.
  h.status('running');
  assert.equal(h.goals.get(h.owner).activation, 'armed');
  assert.deepEqual(h.goals.log, ['disarm', 'resume']);
});

test('GOAL_WAIT counts a running monitor of this session but not jobs of others or finished ones', async t => {
  const h = goalHarness(); t.after(h.dispose);
  h.goals.set(h.owner);
  h.setJobs([{ id: 'job-1', kind: 'bash', owner: 'session-2', status: 'running' }, { id: 'job-2', kind: 'bash', owner: 'session-1', status: 'completed' }]);
  h.confirmedWait('GOAL_WAIT');
  assert.equal(h.goals.get(h.owner).activation, 'armed');
  await h.call('monitor_start', { command: 'sleep 30', description: 'sleeper' }, h.owner);
  h.confirmedWait('GOAL_WAIT');
  assert.equal(h.goals.get(h.owner).activation, 'disarmed');
  await h.call('monitor_stop', { id: '1' }, h.owner).catch(() => {});
});

test('GOAL_WAIT without a wake source stays armed and the next turn is told why', t => {
  const h = goalHarness(); t.after(h.dispose);
  h.goals.set(h.owner);
  const context = () => h.contexts.get('goal-wait').text({ scope: h.owner });
  assert.match(context(), /end your final response with GOAL_WAIT/);
  assert.match(context(), /bash command still running as a job/);
  assert.doesNotMatch(context(), /was not entered/);
  h.turn('Waiting.\nGOAL_WAIT');
  assert.deepEqual(h.goals.log, []);
  assert.match(context(), /GOAL_WAIT was not entered because no monitor is running/);
  h.turn('Did more work.');
  assert.doesNotMatch(context(), /was not entered/);
});

test('GOAL_WAIT is ignored without an active goal, in aborted turns, and a goal paused while waiting stays paused', t => {
  const h = goalHarness(); t.after(h.dispose);
  h.setJobs([{ id: 'job-1', kind: 'bash', owner: 'session-1', status: 'running' }]);
  h.turn('GOAL_WAIT');
  assert.equal(h.contexts.get('goal-wait').text({ scope: h.owner }), '');
  h.goals.set(h.owner);
  h.turn('GOAL_WAIT');
  h.turn('GOAL_WAIT', 'aborted');
  h.turn('GOAL_WAIT');
  assert.deepEqual(h.goals.log, []);
  h.turn('GOAL_WAIT');
  assert.deepEqual(h.goals.log, ['disarm']);
  h.goals.set(h.owner, { phase: 'paused', activation: 'disarmed' });
  h.status('running');
  assert.deepEqual(h.goals.log, ['disarm']);
  assert.equal(h.goals.get(h.owner).phase, 'paused');
});

test('GOAL_WAIT confirmation counts consecutive turns: tool steps inside a turn are fine, other turns and user input reset it', t => {
  const h = goalHarness(); t.after(h.dispose);
  h.goals.set(h.owner);
  h.setJobs([{ id: 'job-1', kind: 'bash', owner: 'session-1', status: 'running' }]);
  // The confirming turn may read files first; only its final response counts.
  h.turn('GOAL_WAIT');
  h.turn('Checked: nothing else.\nGOAL_WAIT', 'completed', { before: ['Let me look at the logs.', 'And the notes.'] });
  assert.deepEqual(h.goals.log, ['disarm']);
  h.status('running');
  // A turn without GOAL_WAIT between them drops the pending confirmation.
  h.turn('GOAL_WAIT'); h.turn('Found more to do.'); h.turn('GOAL_WAIT');
  assert.deepEqual(h.goals.log, ['disarm', 'resume']);
  // So does new user input in the confirming turn.
  h.turn('GOAL_WAIT', 'completed', { user: true });
  assert.deepEqual(h.goals.log, ['disarm', 'resume']);
  h.turn('GOAL_WAIT');
  assert.deepEqual(h.goals.log, ['disarm', 'resume', 'disarm']);
});

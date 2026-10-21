// npm run test:casino — the client's deadline ticker (src/lib/deadlineTicker.js) with fake timers (0.18.1).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const { startDeadlineTicker, tickRetryDelay, TICK_FAST_MS, TICK_SLOW_MS } = await import(pathToFileURL(`${root}/src/lib/deadlineTicker.js`).href);

const flush = () => new Promise((r) => setImmediate(r));
// A rig: fake clock (Date and setTimeout), a visibility switch, and a send() that records its calls.
function rig({ deadlineIn = 5000, reply = () => ({ ok: true, applied: false }), jitter = 0 } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const deadline = Date.now() + deadlineIn;
  const state = { visible: true, listeners: new Set(), ticks: [] };
  const send = async () => {
    state.ticks.push(Date.now() - deadline);
    return reply(state.ticks.length);
  };
  const stop = startDeadlineTicker({
    deadline, jitterMs: jitter, send, now: () => Date.now(), random: () => 0,
    isVisible: () => state.visible,
    onVisible: (fn) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
  });
  // In 100 ms steps, so a timer scheduled after a reply arrives (it is set after an await) is seen like a real clock would.
  const advance = async (ms) => { for (let left = ms; left > 0; left -= 100) { mock.timers.tick(Math.min(100, left)); await flush(); } };
  const setVisible = async (v) => { state.visible = v; for (const fn of [...state.listeners]) fn(); await flush(); };
  return { state, stop, advance, setVisible, deadline };
}

test('retry delay: 2 s (+ up to 0.4 s) for the first 30 s after the deadline, then 10 s (+ up to 2 s)', () => {
  assert.equal(tickRetryDelay(0, () => 0), TICK_FAST_MS);
  assert.equal(tickRetryDelay(29_999, () => 0.999999) < TICK_FAST_MS + 400, true);
  assert.equal(tickRetryDelay(30_000, () => 0), TICK_SLOW_MS);
  assert.equal(tickRetryDelay(120_000, () => 0.999999) < TICK_SLOW_MS + 2000, true);
  assert.equal(tickRetryDelay(120_000, () => 0.999999) >= TICK_SLOW_MS, true);
});

test('a server that fails every tick: 2 s apart for 30 s past the deadline, then 10 s apart', async () => {
  const r = rig({ reply: () => { throw new Error('quota'); } });
  try {
    await r.advance(5000); // the deadline
    await r.advance(40_000 + 5000); // 45 s of the table sitting there
    // Ticks at 0, 2, 4 … 30 s late (16), then 40 s late.
    const fast = r.state.ticks.filter((t) => t <= 30_000);
    assert.equal(fast.length, 16);
    assert.ok(fast.every((t, i) => i === 0 || t - fast[i - 1] === 2000), `2 s apart: ${fast}`);
    const slow = r.state.ticks.filter((t) => t > 30_000);
    assert.deepEqual(slow, [40_000], `then 10 s apart: ${slow}`);
    await r.advance(60_000);
    const gaps = r.state.ticks.slice(-5).map((t, i, a) => (i ? t - a[i - 1] : null)).slice(1);
    assert.ok(gaps.every((g) => g === 10_000), `10 s gaps: ${gaps}`);
  } finally { r.stop(); mock.timers.reset(); }
});

test('no ticks while the page is hidden; exactly one the moment it is visible again, then the normal rhythm', async () => {
  const r = rig();
  try {
    await r.setVisible(false);
    await r.advance(5000 + 60_000); // the deadline passes and a minute goes by
    assert.deepEqual(r.state.ticks, [], 'nothing sent while hidden');
    await r.setVisible(true);
    assert.equal(r.state.ticks.length, 1, 'one tick on becoming visible');
    assert.equal(r.state.ticks[0], 60_000);
    await r.setVisible(true); // a second visibility event does not double it
    assert.equal(r.state.ticks.length, 1);
    await r.advance(10_000);
    assert.equal(r.state.ticks.length, 2, 'then the slow rhythm (more than 30 s late)');
    // Hidden in the middle of the rhythm: the next due tick waits.
    await r.setVisible(false);
    await r.advance(30_000);
    assert.equal(r.state.ticks.length, 2);
    await r.setVisible(true);
    assert.equal(r.state.ticks.length, 3);
  } finally { r.stop(); mock.timers.reset(); }
});

test('when ticks succeed the next hand opens within about 1 s of the deadline, and "not yet" replies aim just past the deadline', async () => {
  // The server's clock is 300 ms behind ours: the first tick is "not yet" (deadline echoed back) and the retry lands at once.
  let moved = false;
  let dl = null;
  const r = rig({ jitter: 800, reply: (n) => (n === 1 ? { ok: true, applied: false, deadline: dl } : ((moved = true), { ok: true, applied: true })) });
  dl = r.deadline;
  try {
    await r.advance(4999);
    assert.equal(r.state.ticks.length, 0, 'not before the deadline');
    await r.advance(1);
    assert.equal(r.state.ticks.length, 1, 'first tick at the deadline');
    await r.advance(1000);
    assert.equal(moved, true, 'the successful tick came within 1 s');
    assert.ok(r.state.ticks[1] <= 1000, `second tick ${r.state.ticks[1]} ms after the deadline`);
  } finally { r.stop(); mock.timers.reset(); }
});

test('stop() ends everything: no ticks afterwards, no visibility listener left', async () => {
  const r = rig();
  await r.advance(5000);
  const n = r.state.ticks.length;
  r.stop();
  assert.equal(r.state.listeners.size, 0);
  await r.advance(100_000);
  assert.equal(r.state.ticks.length, n);
  mock.timers.reset();
});

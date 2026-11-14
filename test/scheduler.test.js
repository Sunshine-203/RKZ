const test = require('node:test');
const assert = require('node:assert');
const { schedule } = require('../src/scheduler');

const step = (id, minutes, extra = {}) => ({ id, ord: Number(id.slice(1)), minutes, doneMinutes: 0, status: 'todo', ...extra });

test('fits steps into daily time and splits long steps', () => {
  const r = schedule({ today: '2026-11-14', dailyMinutes: 60, assignments: [
    { id: 'a', deadline: '2026-11-17', createdAt: '1', steps: [step('s1', 90), step('s2', 30)] },
  ] });
  assert.deepStrictEqual(r.byStep.s1.sessions, [{ date: '2026-11-14', minutes: 60 }, { date: '2026-11-15', minutes: 30 }]);
  assert.deepStrictEqual(r.byStep.s2.sessions, [{ date: '2026-11-15', minutes: 30 }]);
  assert.strictEqual(r.byAssignment.a.risk, 'green');
});

test('flags work that will not fit before the deadline', () => {
  const r = schedule({ today: '2026-11-14', dailyMinutes: 20, assignments: [
    { id: 'a', deadline: '2026-11-15', createdAt: '1', steps: [step('s1', 30), step('s2', 30)] },
  ] });
  assert.strictEqual(r.byAssignment.a.risk, 'red');
  assert.strictEqual(r.byAssignment.a.unscheduledMinutes, 20);
  assert.strictEqual(r.byStep.s2.unscheduledMinutes, 20);
});

test('earliest deadline goes first across assignments', () => {
  const r = schedule({ today: '2026-11-14', dailyMinutes: 60, assignments: [
    { id: 'late', deadline: '2026-11-20', createdAt: '1', steps: [step('l1', 60)] },
    { id: 'soon', deadline: '2026-11-14', createdAt: '2', steps: [step('n1', 60)] },
  ] });
  assert.deepStrictEqual(r.byStep.n1.sessions, [{ date: '2026-11-14', minutes: 60 }]);
  assert.deepStrictEqual(r.byStep.l1.sessions, [{ date: '2026-11-15', minutes: 60 }]);
  assert.strictEqual(r.byAssignment.soon.risk, 'yellow'); // finishes on the due day
});

test('done steps are preserved and partial steps only schedule what is left', () => {
  const r = schedule({ today: '2026-11-14', dailyMinutes: 60, assignments: [
    { id: 'a', deadline: '2026-11-16', createdAt: '1', steps: [step('s1', 60, { status: 'done' }), step('s2', 60, { status: 'partial', doneMinutes: 40 })] },
  ] });
  assert.deepStrictEqual(r.byStep.s1.sessions, []);
  assert.deepStrictEqual(r.byStep.s2.sessions, [{ date: '2026-11-14', minutes: 20 }]);
});

test('past deadline is overdue', () => {
  const r = schedule({ today: '2026-11-14', dailyMinutes: 60, assignments: [
    { id: 'a', deadline: '2026-11-10', createdAt: '1', steps: [step('s1', 30)] },
  ] });
  assert.strictEqual(r.byAssignment.a.risk, 'overdue');
});

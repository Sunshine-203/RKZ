// RKZ's own scheduler — works with no AI at all.
// Earliest-deadline-first: fills each day's study minutes with steps in order,
// splits long steps across days, and reports any minutes that can't fit before the deadline.

const MIN_CHUNK = 10; // don't create tiny 3-minute sessions unless they finish a step

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function remainingOf(step) {
  if (step.status === 'done') return 0;
  return Math.max(0, step.minutes - (step.doneMinutes || 0));
}

/**
 * @param {{today:string, dailyMinutes:number, assignments:Array}} input
 * assignments: [{id, deadline:'YYYY-MM-DD', createdAt, steps:[{id, ord, minutes, doneMinutes, status}]}]
 */
function schedule({ today, dailyMinutes, assignments }) {
  const capacity = new Map(); // date -> minutes left that day
  const capOf = (d) => (capacity.has(d) ? capacity.get(d) : dailyMinutes);

  const byStep = {};
  const byAssignment = {};
  const agenda = new Map(); // date -> [{assignmentId, stepId, minutes}]

  const ordered = [...assignments].sort(
    (a, b) => a.deadline.localeCompare(b.deadline) || String(a.createdAt).localeCompare(String(b.createdAt))
  );

  for (const a of ordered) {
    const span = daysBetween(today, a.deadline); // days available = span + 1 (today..deadline)
    let dayIdx = 0;
    let remainingTotal = 0;
    let unscheduledTotal = 0;
    let finishDate = null;

    for (const s of [...a.steps].sort((x, y) => x.ord - y.ord)) {
      let rem = remainingOf(s);
      remainingTotal += rem;
      const sessions = [];

      while (rem > 0 && dayIdx <= span) {
        const d = addDays(today, dayIdx);
        const c = capOf(d);
        const usable = c >= MIN_CHUNK || (c > 0 && c >= rem) ? c : 0;
        if (usable <= 0) { dayIdx++; continue; }

        const take = Math.min(usable, rem);
        capacity.set(d, c - take);
        rem -= take;

        const last = sessions[sessions.length - 1];
        if (last && last.date === d) last.minutes += take;
        else sessions.push({ date: d, minutes: take });

        if (!agenda.has(d)) agenda.set(d, []);
        agenda.get(d).push({ assignmentId: a.id, stepId: s.id, minutes: take });
        if (!finishDate || d > finishDate) finishDate = d;
      }

      unscheduledTotal += rem;
      byStep[s.id] = { sessions, unscheduledMinutes: rem, remainingMinutes: remainingOf(s) };
    }

    let risk;
    if (a.steps.length > 0 && remainingTotal === 0) risk = 'done';
    else if (span < 0 && remainingTotal > 0) risk = 'overdue';
    else if (unscheduledTotal > 0) risk = 'red';
    else if (finishDate === a.deadline) risk = 'yellow';
    else risk = 'green';

    byAssignment[a.id] = { risk, remainingMinutes: remainingTotal, unscheduledMinutes: unscheduledTotal, finishDate };
  }

  const agendaList = [...agenda.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([date, items]) => ({ date, items }));

  return { byStep, byAssignment, agenda: agendaList };
}

module.exports = { schedule, addDays, daysBetween, MIN_CHUNK };

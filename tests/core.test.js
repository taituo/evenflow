import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../public/shared/types/sheet.js';
import { Engine, fmtValue, computeAll } from '../public/shared/engine.js';
import { shiftFormula, autoClose } from '../public/shared/formula.js';

const wb = () => S.create('t');
const val = (st, sheet, a) => {
  const en = new Engine(st);
  const m = /^([A-Z]+)(\d+)$/.exec(a);
  let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return fmtValue(en.value(sheet, c - 1, +m[2] - 1));
};

test('formulas: arithmetic, precedence, functions, errors', () => {
  const st = wb();
  S.apply(st, { op: 'set', cells: {
    A1: '2', A2: '3', A3: '4,5', A4: 'x',
    B1: '=A1+A2*A3', B2: '=-2^2', B3: '=SUM(A1:A4)', B4: '=A1/0', B5: '=IF(A1>1,"big","small")',
    B6: '=B7', B7: '=B6', B8: '=COUNTIF(A1:A4,">2")', B9: '=VLOOKUP(3,A1:B3,2,FALSE)',
    B10: '=IFERROR(A4*2;"bad")', B11: '=ROUND(1/3,3)', B12: '=AND(A1=2, ISNUMBER(A3))', B13: '=50%', B14: '=0.1+0.2',
    B15: '=A1&"-"&A2', B16: '=nope(1)', B17: '=SUM(A1:A3', B18: '=TEXTJOIN(",",TRUE,A1:A4)',
  } });
  const v = (a) => val(st, 'Sheet1', a);
  assert.equal(v('B1'), '15.5');
  assert.equal(v('B2'), '4');
  assert.equal(v('B3'), '9.5');
  assert.equal(v('B4'), '#DIV/0!');
  assert.equal(v('B5'), 'big');
  assert.equal(v('B6'), '#CYCLE!');
  assert.equal(v('B8'), '2');
  assert.equal(v('B9'), '4');
  assert.equal(v('B10'), 'bad');
  assert.equal(v('B11'), '0.333');
  assert.equal(v('B12'), 'TRUE');
  assert.equal(v('B13'), '0.5');
  assert.equal(v('B14'), '0.3');
  assert.equal(v('B15'), '2-3');
  assert.equal(v('B16'), '#NAME?');
  assert.equal(v('B17'), '#ERROR!');
  assert.equal(v('B18'), '2,3,4.5,x');
});

test('cross-sheet refs and quoted names', () => {
  const st = wb();
  S.apply(st, { op: 'addSheet', name: 'My Data' });
  S.apply(st, { op: 'set', cells: { "'My Data'!C3": '10', A1: "='My Data'!C3*2" } });
  assert.equal(val(st, 'Sheet1', 'A1'), '20');
});

test('move rewrites references (Sheets cut/paste semantics)', () => {
  const st = wb();
  S.apply(st, { op: 'set', cells: { C23: '1', D32: '2', H1: '=C23+D32', H2: '=SUM(C23:D32)', H3: '=F23', F23: 'old' } });
  const res = S.apply(st, { op: 'move', from: 'C23:D32', to: 'F23' });
  const c = st.sheets[0].cells;
  assert.equal(c.F23.v, '1');
  assert.equal(c.G32.v, '2');
  assert.equal(c.C23, undefined);
  assert.equal(c.H1.v, '=F23+G32');
  assert.equal(c.H2.v, '=SUM(F23:G32)');
  assert.equal(c.H3.v, '=#REF!'); // pointed at overwritten target
  assert.equal(val(st, 'Sheet1', 'H1'), '3');
  assert.equal(res.changes[0].k, 'move');
  assert.deepEqual(res.changes[0].rewritten.sort(), ['Sheet1!H1', 'Sheet1!H2', 'Sheet1!H3']);
  // undo
  for (const inv of res.inverse) S.apply(st, inv);
  assert.equal(st.sheets[0].cells.H1.v, '=C23+D32');
});

test('move formula across sheets keeps pointing at origin sheet', () => {
  const st = wb();
  S.apply(st, { op: 'addSheet', name: 'B' });
  S.apply(st, { op: 'set', cells: { A1: '5', A2: '=A1*2' } });
  S.apply(st, { op: 'move', from: 'A2', to: 'B!C1' });
  assert.equal(st.sheets[1].cells.C1.v, '=Sheet1!A1*2');
  assert.equal(val(st, 'B', 'C1'), '10');
});

test('insert/delete rows and cols shift refs', () => {
  const st = wb();
  S.apply(st, { op: 'set', cells: { A1: '1', A2: '2', A3: '3', B1: '=SUM(A1:A3)', B2: '=A3' } });
  S.apply(st, { op: 'insertRows', at: 2, count: 2 });
  const c = st.sheets[0].cells;
  assert.equal(c.A5.v, '3');
  assert.equal(c.B1.v, '=SUM(A1:A5)');
  assert.equal(c.B4.v, '=A5');
  S.apply(st, { op: 'deleteRows', at: 5, count: 1 });
  assert.equal(c.B1 ? st.sheets[0].cells.B1.v : '', '=SUM(A1:A4)');
  assert.equal(st.sheets[0].cells.B4.v, '=#REF!');
  S.apply(st, { op: 'insertCols', at: 'A', count: 1 });
  assert.equal(st.sheets[0].cells.C1.v, '=SUM(B1:B4)');
});

test('rename sheet rewrites refs; delete sheet -> #REF!', () => {
  const st = wb();
  S.apply(st, { op: 'addSheet', name: 'Data' });
  S.apply(st, { op: 'set', cells: { 'Data!A1': '7', A1: '=Data!A1' } });
  S.apply(st, { op: 'renameSheet', sheet: 'Data', name: 'Numbers' });
  assert.equal(st.sheets[0].cells.A1.v, '=Numbers!A1');
  S.apply(st, { op: 'deleteSheet', sheet: 'Numbers' });
  assert.equal(st.sheets[0].cells.A1.v, '=#REF!');
});

test('shiftFormula / autoClose', () => {
  assert.equal(shiftFormula('=A1+$B$2+B$3+Other!C4', 2, 1), '=B3+$B$2+C$3+Other!D6');
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
  assert.equal(autoClose('=SUM(A1:A3'), '=SUM(A1:A3)');
});

test('computeAll + set values block', () => {
  const st = wb();
  S.apply(st, { op: 'set', range: 'B2', values: [['a', 1], ['b', 2]] });
  S.apply(st, { op: 'set', cells: { D1: '=SUM(C2:C3)' } });
  assert.equal(computeAll(st).get('Sheet1!D1'), '3');
});

test('fuzz: every op followed by its inverse restores the workbook exactly', () => {
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
  const canon = (st) => JSON.stringify(st, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
  const L = 'ABCDEFGH';
  const cell = () => L[rnd(8)] + (1 + rnd(12));
  const rng = () => { const a = rnd(8), b = rnd(8), r1 = 1 + rnd(12), r2 = 1 + rnd(12); return `${L[Math.min(a, b)]}${Math.min(r1, r2)}:${L[Math.max(a, b)]}${Math.max(r1, r2)}`; };
  for (let round = 0; round < 2000; round++) {
    const st = wb();
    S.apply(st, { op: 'addSheet', name: 'Two' });
    const cells = {};
    for (let i = 0; i < 25; i++) {
      const k = rnd(4);
      cells[(rnd(3) ? '' : 'Two!') + cell()] = k === 0 ? String(rnd(100)) : k === 1 ? `=${cell()}+${cell()}` : k === 2 ? `=SUM(${rng()})` : `=Two!${cell()}*2`;
    }
    S.apply(st, { op: 'set', cells });
    S.apply(st, { op: 'format', range: rng(), style: { b: true } });
    S.apply(st, { op: 'note', cell: cell(), text: 'n' });
    try { S.apply(st, { op: 'table', name: 'T1', range: rng() }); } catch {}
    try { S.apply(st, { op: 'table', name: 'T2', range: 'Two!' + rng() }); } catch {}
    try { S.apply(st, { op: 'merge', range: rng() }); } catch {}
    try { S.apply(st, { op: 'borders', range: rng(), type: 'all' }); } catch {}
    S.apply(st, { op: 'addChart', type: 'line', range: rng(), at: cell() });
    S.apply(st, { op: 'addChart', type: 'kpi', value: 'Two!' + cell(), at: cell() });
    S.apply(st, { op: 'slide', id: 's1', title: 'One', cards: ['chart1'], bg: { image: '/a.gif', filter: 'dither' } });
    S.apply(st, { op: 'slide', id: 's2', title: 'Two', text: 'x' });
    S.apply(st, { op: 'panel', id: 'p1', title: 'P', text: 't' });
    S.apply(st, { op: 'cond', range: rng(), rules: [{ when: '<', value: 10, light: 'green' }, { when: '>=', value: '=A1', light: 'red' }] });
    S.apply(st, { op: 'cond', range: 'Two!' + rng(), rules: [{ when: 'contains', value: 'x', style: { fill: '#ff0000' } }, { when: '>', value: '=Sheet1!' + cell(), light: 'red' }] });
    S.apply(st, { op: 'cond', range: rng(), rules: [{ when: '<', value: '=Two!' + cell(), light: 'blue' }] });
    const before = canon(st);
    const ops = [
      () => ({ op: 'move', from: rng(), to: (rnd(4) ? '' : 'Two!') + cell() }),
      () => ({ op: 'insertRows', at: 1 + rnd(12), count: 1 + rnd(3) }),
      () => ({ op: 'deleteRows', at: 1 + rnd(12), count: 1 + rnd(3) }),
      () => ({ op: 'insertCols', at: L[rnd(8)], count: 1 + rnd(2) }),
      () => ({ op: 'deleteCols', at: L[rnd(8)], count: 1 + rnd(2) }),
      () => ({ op: 'deleteSheet', sheet: 'Two' }),
      () => ({ op: 'renameSheet', sheet: 'Two', name: 'Deux' }),
      () => ({ op: 'appendRows', table: 'T1', rows: [['a', 'b'], { A: 1 }] }),
      () => ({ op: 'removeRows', table: 'T1', rows: [1, 2] }),
      () => ({ op: 'addColumn', table: 'T1', name: 'Uusi' }),
      () => ({ op: 'updateRows', table: 'T1', rows: [1], set: { A: 'x' } }),
      () => ({ op: 'merge', range: rng(), type: ['all', 'horizontal', 'vertical'][rnd(3)] }),
      () => ({ op: 'unmerge', range: rng() }),
      () => ({ op: 'updateChart', id: 'chart1', type: 'bar', at: cell(), range: rng() }),
      () => ({ op: 'deleteChart', id: 'chart2' }),
      () => ({ op: 'borders', range: rng(), type: ['all', 'outer', 'inner', 'clear', 'left'][rnd(5)], style: 'dashed' }),
      () => ({ op: 'slide', id: ['s1', 's2', 's3'][rnd(3)], index: rnd(3), title: 'T' + rnd(9), bg: rnd(2) ? null : { theme: 'ocean' }, duration: rnd(10) }),
      () => ({ op: 'removeSlide', id: ['s1', 's2'][rnd(2)] }),
      () => ({ op: 'panel', id: ['p1', 'p2'][rnd(2)], text: 'v' + rnd(9), span: 1 + rnd(2) }),
      () => ({ op: 'removePanel', id: 'p1' }),
      () => ({ op: 'liveLayout', order: ['a', 'b'], links: rnd(2) ? false : null, flow: rnd(2) ? 'horizontal' : null }),
      () => ({ op: 'view', grid: !!rnd(2), theme: 'ember', font: 'serif' }),
      () => ({ op: 'cond', range: rng(), rules: [{ when: 'between', value: 1, value2: 5, light: 'amber' }], id: rnd(2) ? 'c1' : undefined }),
      () => ({ op: 'removeCond', id: 'c1' }),
    ];
    const op = ops[rnd(ops.length)]();
    let res;
    try { res = S.apply(st, op); } catch (e) { assert.equal(canon(st), before, 'failed op must not mutate'); continue; }
    const redoInv = [];
    for (const inv of res.inverse) redoInv.unshift(...S.apply(st, inv).inverse);
    assert.equal(canon(st), before, `round ${round} op ${JSON.stringify(op)}`);
    // redo, then undo again
    const after = (() => { const t = JSON.parse(before); S.apply(t, op); return canon(t); })();
    const inv2 = [];
    for (const o of redoInv) inv2.unshift(...S.apply(st, o).inverse);
    assert.equal(canon(st), after, `redo round ${round} op ${JSON.stringify(op)}`);
  }
});

test('whole column / row references', () => {
  const st = wb();
  S.apply(st, { op: 'set', cells: { A1: '1', A2: '2', A5: '3', B1: '=SUM(A:A)', C1: '=SUMIF(A:A,">1")', D3: '=SUM(2:2)', B2: '5' } });
  assert.equal(val(st, 'Sheet1', 'B1'), '6');
  assert.equal(val(st, 'Sheet1', 'C1'), '5');
  assert.equal(val(st, 'Sheet1', 'D3'), '7');
  S.apply(st, { op: 'insertRows', at: 1, count: 1 });
  assert.equal(st.sheets[0].cells.B2.v, '=SUM(A:A)');
  assert.equal(st.sheets[0].cells.D4.v, '=SUM(3:3)');
  S.apply(st, { op: 'insertCols', at: 'A', count: 1 });
  assert.equal(st.sheets[0].cells.C2.v, '=SUM(B:B)');
  assert.equal(shiftFormula('=SUM(A:A)+A1', 3, 1), '=SUM(B:B)+B4');
});

test('named tables: records, structured refs, follow structure', () => {
  const st = wb();
  S.apply(st, { op: 'set', range: 'B4', values: [['Name', 'Status', 'Owner'], ['Servos', 'open', 'Alex'], ['Battery', 'done', 'Sam']] });
  S.apply(st, { op: 'set', range: 'G4', values: [['Part', 'Price'], ['Servo', 12]] });
  S.apply(st, { op: 'table', name: 'Tasks', range: 'B4:D6' });
  S.apply(st, { op: 'table', name: 'Parts', range: 'G4:H5' });
  assert.throws(() => S.apply(st, { op: 'table', name: 'X', range: 'C5:H9' }), /Overlaps/);
  S.apply(st, { op: 'set', cells: { A1: '=COUNTIF(Tasks[Status],"open")', A2: '=SUM(Parts[Price])' } });
  assert.equal(val(st, 'Sheet1', 'A1'), '1');
  let r = S.apply(st, { op: 'appendRows', table: 'Tasks', rows: [{ Name: 'Wires', Status: 'open' }] });
  assert.equal(st.sheets[0].tables[0].range, 'B4:D7');
  assert.equal(st.sheets[0].cells.C7.v, 'open');
  assert.equal(val(st, 'Sheet1', 'A1'), '2');
  S.apply(st, { op: 'updateRows', table: 'Tasks', key: 'servos', set: { Status: 'done' } });
  assert.equal(st.sheets[0].cells.C5.v, 'done');
  assert.equal(S.tableLabel(st, 'Sheet1', 'C5'), 'Tasks[Servos].Status');
  S.apply(st, { op: 'addColumn', table: 'Tasks', name: 'Notes' });
  assert.equal(st.sheets[0].tables[0].range, 'B4:E7');
  // G column was free? Parts starts at G, E free -> no insert
  assert.equal(st.sheets[0].tables[1].range, 'G4:H5');
  S.apply(st, { op: 'insertRows', at: 1, count: 2 });
  assert.equal(st.sheets[0].tables[0].range, 'B6:E9');
  S.apply(st, { op: 'move', from: 'B6:E9', to: 'B20' });
  assert.equal(st.sheets[0].tables.find((t) => t.name === 'Tasks').range, 'B20:E23');
  r = S.apply(st, { op: 'removeRows', table: 'Tasks', match: { Status: 'done' } });
  assert.equal(st.sheets[0].tables.find((t) => t.name === 'Tasks').range, 'B20:E21');
  assert.equal(st.sheets[0].cells.B21.v, 'Wires');
  const rt = S.read(st, '@Tasks');
  assert.deepEqual(rt.columns, ['Name', 'Status', 'Owner', 'Notes']);
  S.apply(st, { op: 'renameTable', name: 'Tasks', newName: 'Tasks' });
  assert.equal(st.sheets[0].cells.A3.v, '=COUNTIF(Tasks[Status],"open")');
});

test('borders and merges (Sheets semantics)', () => {
  const st = wb();
  S.apply(st, { op: 'set', cells: { A1: 'Title', B1: 'x', A2: '1' } });
  let r = S.apply(st, { op: 'merge', range: 'A1:C1' });
  assert.deepEqual(st.sheets[0].merges, ['A1:C1']);
  assert.equal(st.sheets[0].cells.B1, undefined);
  S.apply(st, r.inverse[0]); for (const o of r.inverse.slice(1)) S.apply(st, o);
  assert.equal(st.sheets[0].cells.B1.v, 'x');
  S.apply(st, { op: 'merge', range: 'A1:C1' });
  S.apply(st, { op: 'insertCols', at: 'B', count: 1 });
  assert.deepEqual(st.sheets[0].merges, ['A1:D1']);
  S.apply(st, { op: 'borders', range: 'A2:B3', type: 'outer', style: 'thick', color: '#ff0000' });
  const c = st.sheets[0].cells;
  assert.equal(c.A2.s.bd.t, 'thick #ff0000');
  assert.equal(c.A1.s.bd.b, 'thick #ff0000'); // shared edge written on neighbour too
  assert.equal(c.B3.s.bd.r, 'thick #ff0000');
  assert.equal(c.A2.s.bd.r, undefined);
  S.apply(st, { op: 'borders', range: 'A2:B3', type: 'clear' });
  assert.equal(c.A2.s?.bd, undefined);
  S.apply(st, { op: 'unmerge', range: 'B1' });
  assert.equal(st.sheets[0].merges, undefined);
});

test('charts: live data from range/table, follow structure, exact undo', () => {
  const st = wb();
  S.apply(st, { op: 'set', range: 'B2', values: [['Month', 'Income', 'Costs'], ['Jan', 10, 4], ['Feb', 12, 5], ['Mar', 9, 7]] });
  S.apply(st, { op: 'table', name: 'Money', range: 'B2:D5' });
  S.apply(st, { op: 'addChart', type: 'column', range: 'B2:D5', at: 'G2', title: 'Money' });
  S.apply(st, { op: 'addChart', type: 'pie', table: 'Money', x: 'Month', y: ['Income'], at: 'G20' });
  S.apply(st, { op: 'set', cells: { F1: '=SUM(Money[Income])' } });
  S.apply(st, { op: 'addChart', type: 'kpi', value: 'F1', title: 'Income yht.', at: 'M2' });
  let d = S.chartData(st, 'Sheet1', st.sheets[0].charts[0]);
  assert.deepEqual(d.labels, ['Jan', 'Feb', 'Mar']);
  assert.deepEqual(d.series.map((s) => s.name), ['Income', 'Costs']);
  assert.deepEqual(S.chartData(st, 'Sheet1', st.sheets[0].charts[1]).series[0].values, [10, 12, 9]);
  assert.equal(S.chartData(st, 'Sheet1', st.sheets[0].charts[2]).kpi.text, '31');
  S.apply(st, { op: 'insertRows', at: 1, count: 2 });
  assert.equal(st.sheets[0].charts[0].range, 'B4:D7');
  assert.equal(st.sheets[0].charts[0].at, 'G4');
  assert.equal(st.sheets[0].charts[2].value, 'F3');
  S.apply(st, { op: 'renameTable', name: 'Money', newName: 'Cash' });
  assert.equal(st.sheets[0].charts[1].table, 'Cash');
  const r = S.apply(st, { op: 'updateChart', id: 'chart1', type: 'line', range: '@Cash' });
  assert.equal(st.sheets[0].charts[0].table, 'Cash');
  for (const o of r.inverse) S.apply(st, o);
  assert.equal(st.sheets[0].charts[0].range, 'B4:D7');
  assert.equal(st.sheets[0].charts[0].table, undefined);
  assert.equal(st.sheets[0].charts[0].type, 'column');
});

test('traffic lights: rules, formulas as thresholds, follow moves and inserts, exact undo', async () => {
  const { condStyle, parseRule } = await import('../public/shared/cond.js');
  const st = wb();
  S.apply(st, { op: 'set', cells: { A1: '5', A2: '50', A3: '500', A4: 'done', A5: '', B1: '100' } });
  S.apply(st, { op: 'cond', range: 'A1:A5', rules: [{ when: '<', value: 10, light: 'green' }, { when: '>', value: '=B1', light: 'red' }, { when: '=', value: 'DONE', light: 'blue' }, { when: 'empty', light: 'gray' }] });
  const en = new Engine(st), sh = st.sheets[0];
  const L = (r) => condStyle(en, sh, 0, r, en.value(sh, 0, r))?.light ?? null;
  assert.deepEqual([0, 1, 2, 3, 4].map(L), ['green', null, 'red', 'blue', 'gray']);
  // the threshold is a live formula
  S.apply(st, { op: 'set', cells: { B1: '20' } });
  const en2 = new Engine(st);
  assert.equal(condStyle(en2, sh, 0, 1, en2.value(sh, 0, 1)).light, 'red');
  // structure: insert above shifts, move to another sheet carries the rules
  S.apply(st, { op: 'insertRows', at: 1, count: 2 });
  assert.equal(sh.conds[0].range, 'A3:A7');
  assert.equal(sh.conds[0].rules[1].value, '=B3', 'formula threshold follows the insert');
  S.apply(st, { op: 'addSheet', name: 'Two' });
  const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((q) => [q, v[q]])) : v));
  const before = canon(st);
  const r = S.apply(st, { op: 'move', from: 'A3:A7', to: 'Two!C1' });
  assert.equal(sh.conds, undefined);
  assert.equal(st.sheets[1].conds[0].range, 'C1:C5');
  assert.equal(st.sheets[1].conds[0].rules[1].value, '=Sheet1!B3', 'threshold still points at Sheet1');
  for (const inv of r.inverse) S.apply(st, inv);
  assert.equal(canon(st), before);
  // validation + CLI shorthand
  assert.throws(() => S.apply(st, { op: 'cond', range: 'A1', rules: [{ when: 'nope', light: 'red' }] }), /Unknown rule/);
  assert.throws(() => S.apply(st, { op: 'cond', range: 'A1', rules: [{ when: '<', value: 1, light: 'pink' }] }), /Unknown light/);
  assert.deepEqual(parseRule('between 100 200:amber'), { when: 'between', value: 100, value2: 200, light: 'amber' });
  assert.deepEqual(parseRule('>=Settings:red').when, '>=');
  assert.deepEqual(parseRule('<=Settings!B1:red'), { when: '<=', value: 'Settings!B1', light: 'red' });
  assert.deepEqual(parseRule('<==Settings!B1:red'), { when: '<=', value: '=Settings!B1', light: 'red' });
  assert.deepEqual(parseRule('contains late:#ff0000'), { when: 'contains', value: 'late', style: { fill: '#ff0000' } });
});

test('a bordered block moves with its whole frame and leaves no lines behind', () => {
  const st = wb();
  S.apply(st, { op: 'set', cells: { B2: 'a', C3: 'b' } });
  S.apply(st, { op: 'borders', range: 'B2:C3', type: 'outer', style: 'medium', color: '#188038' });
  const before = JSON.stringify(st);
  const r = S.apply(st, { op: 'move', from: 'B2:C3', to: 'F8' });
  const sh = st.sheets[0];
  const bdAt = (A) => sh.cells[A]?.s?.bd || null;
  for (const A of ['B1', 'C1', 'A2', 'A3', 'D2', 'D3', 'B4', 'C4']) assert.equal(bdAt(A), null, `no line left at ${A}`);
  assert.equal(bdAt('F7').b, 'medium #188038', 'mirror above the new place');
  assert.equal(bdAt('E8').r, 'medium #188038', 'mirror left of the new place');
  assert.equal(bdAt('F8').t, 'medium #188038');
  for (const inv of r.inverse) S.apply(st, inv);
  const canon = (x) => JSON.stringify(JSON.parse(x), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((q) => [q, v[q]])) : v));
  assert.equal(canon(JSON.stringify(st)), canon(before));
});

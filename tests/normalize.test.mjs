import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, dept, idNum, isoDateToSerial, istDateTimeText, padId, person, priority, project, safeText, serialNow, serialToMs } from '../src/normalize.js';

test('clean strips emoji and extra spaces', () => {
  assert.equal(clean('  📣  Marketing '), 'Marketing');
  assert.equal(clean('🎞️ Product Demo'), 'Product Demo');
  assert.equal(clean(null), '');
});

test('person → Title Case', () => {
  assert.equal(person('geetanshu '), 'Geetanshu');
  assert.equal(person('DEEP'), 'Deep');
  assert.equal(person('rahul  polastya'), 'Rahul Polastya');
});

test('departments', () => {
  assert.equal(dept('📣 Marketing'), 'Marketing');
  assert.equal(dept('Digital marketing'), 'Marketing');
  assert.equal(dept('Markting'), 'Marketing');
  assert.equal(dept('SMM'), 'Social Media');
  assert.equal(dept('social-media'), 'Social Media');
  assert.equal(dept('SEO team'), 'SEO');
  assert.equal(dept('Webiste'), 'Website');
  assert.equal(dept('💻 Tech / Development'), 'Tech / Development');
  assert.equal(dept('hr'), 'HR');
  assert.equal(dept('🤝 Client Servicing'), 'Client Servicing');
  assert.equal(dept(''), '(Not specified)');
});

test('projects', () => {
  assert.equal(project('Nature mania '), 'NatureMania');
  assert.equal(project('way-veda'), 'Wayveda');
  assert.equal(project('CK'), 'College Knowledge');
  assert.equal(project('dc'), 'Digital Chaabi');
  assert.equal(project('Dr. Neha'), 'Dr Neha Mehta');
  assert.equal(project('MFB'), 'My Fit Brain');
  assert.equal(project('meda partners'), 'MeDa');
  assert.equal(project('life at meda'), 'Life at MeDa');
  assert.equal(project('some new client'), 'Some New Client');
  assert.equal(project(''), '(Not specified)');
});

test('priority', () => {
  assert.equal(priority('🔴 Urgent (Today)'), 0);
  assert.equal(priority('🟠 High (1-2 days)'), 1);
  assert.equal(priority('🟡 Normal (3-5 days)'), 2);
  assert.equal(priority('🟢 Low (this week)'), 3);
  assert.equal(priority(''), 4);
});

test('task ids', () => {
  assert.equal(idNum('TSK-391'), 391);
  assert.equal(idNum('tsk-007 '), 7);
  assert.equal(idNum('Click'), null);
  assert.equal(padId(7), 'TSK-007');
  assert.equal(padId(1576), 'TSK-1576');
});

test('IST serial dates round-trip', () => {
  const ms = Date.UTC(2026, 2, 23, 9, 35, 2); // 15:05:02 IST
  assert.ok(Math.abs(serialToMs(serialNow(ms)) - ms) < 1);
  assert.equal(Math.floor(serialNow(ms)), 46104); // 23 Mar 2026
  assert.deepEqual(istDateTimeText(ms), { date: '23/03/2026', time: '15:05:02' });
  assert.equal(isoDateToSerial('2026-03-23'), 46104);
  assert.equal(isoDateToSerial('nope'), null);
});

test('safeText blocks formula injection', () => {
  assert.equal(safeText('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.equal(safeText('@me'), "'@me");
  assert.equal(safeText('  normal  '), 'normal');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../src/application');

function buildDrawing() {
  const L = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'DOOR_900', '70', '0', '10', '0', '20', '0',
    '0', 'LWPOLYLINE', '5', 'B1', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '900', '20', '0', '10', '900', '20', '50', '10', '0', '20', '50',
    '0', 'ENDBLK', '5', 'E1', '8', '0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES'
  ];
  L.push('0', 'LWPOLYLINE', '5', 'R1', '8', 'A-ROOM', '90', '4', '70', '1');
  for (const [x, y] of [[0, 0], [6000, 0], [6000, 4000], [0, 4000]]) L.push('10', String(x), '20', String(y));
  L.push('0', 'HATCH', '5', 'W1', '8', 'A-WALL', '92', '2');
  for (const [x, y] of [[0, -115], [6000, -115], [6000, 115], [0, 115]]) L.push('10', String(x), '20', String(y));
  L.push('0', 'INSERT', '5', 'D1', '8', 'A-DOOR', '2', 'DOOR_900', '10', '2000', '20', '0');
  for (let i = 0; i < 20; i++) {
    L.push('0', 'LINE', '5', 'AN' + i, '8', 'A-NOTE', '10', String(i * 100), '20', '5000', '11', String(i * 100 + 50), '21', '5200');
  }
  for (let i = 0; i < 15; i++) {
    L.push('0', 'LINE', '5', 'DM' + i, '8', 'A-DIMS', '10', String(i * 200), '20', '-500', '11', String(i * 200 + 100), '21', '-700');
  }
  for (let i = 0; i < 10; i++) {
    L.push('0', 'INSERT', '5', 'XR' + i, '8', 'A-FURN', '2', 'xref-external-library-item' + i, '10', String(i * 500), '20', '6000');
  }
  L.push('0', 'ENDSEC', '0', 'EOF');
return L.join(String.fromCharCode(10)) + String.fromCharCode(10);}

function measureAndQueue() {
  const app = createApplication({ schedule: (cb) => cb() });
  const project = app.createProject({ name: 'T27' });
  const source = app.createSourceDocument({ filename: 'noisy.dxf', content: buildDrawing(), projectId: project.id, sourceSheet: 'A', studioId: 'st' });
  const run = app.getRun(app.startProcessing(source.id).id);
  const queue = app.getExceptionQueue(project.id);
  return { app, project, run, queue, boq: run.boq };
}

test('geometry on annotation layers is advisory, not blocking', () => {
  const { queue } = measureAndQueue();
  const annotationGroups = queue.groups.filter((g) => /A-NOTE|A-DIMS/.test(g.groupKey));
  assert.ok(annotationGroups.length > 0, 'annotation-layer groups exist');
  for (const group of annotationGroups) {
    assert.equal(group.severity, 'advisory', group.groupKey + ' should be advisory');
  }
});

test('xref-block entities are advisory, since the geometry lives outside the file', () => {
  const { queue } = measureAndQueue();
  const xrefGroups = queue.groups.filter((g) => /xref/i.test(g.groupKey));
  assert.ok(xrefGroups.length > 0, 'xref groups exist');
  for (const group of xrefGroups) {
    assert.equal(group.severity, 'advisory', group.groupKey + ': the geometry is outside this file');
  }
});

test('the operator sees a manageable queue', () => {
  const { queue } = measureAndQueue();
  assert.ok(queue.counts.groups <= 10, 'groups should be manageable: ' + queue.counts.groups);
  const blocking = queue.groups.filter((g) => g.severity === 'blocking');
  assert.ok(blocking.length <= 5, 'blocking groups should be few: ' + blocking.length);
});

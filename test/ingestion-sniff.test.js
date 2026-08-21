const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { sniffContent } = require('../src/ingestion/sniff');

const fixture = (name) => readFileSync(`${__dirname}/fixtures/${name}`);

test('a real DXF written by a CAD tool is recognised', () => {
  /* Regression: the DXF specification right-justifies group codes in a
     three-character field, so every real writer emits "  0" then "SECTION".
     Our hand-written fixtures were left-aligned, so a sniffer that required the
     code flush against the newline passed every test we had and rejected every
     real file with "Unsupported drawing format". */
  const real = fixture('real-format-plan.dxf');
  assert.equal(real.toString('latin1').startsWith('  0'), true,
    'the fixture really is padded, or this test proves nothing');
  assert.equal(sniffContent(real).format, 'dxf');
  assert.equal(sniffContent(real).mediaType, 'application/dxf');
});

test('the hand-written fixtures are still recognised', () => {
  for (const name of ['clean-plan.dxf', 'blocks-plan.dxf', 'residual-blocks.dxf']) {
    assert.equal(sniffContent(fixture(name)).format, 'dxf', name);
  }
});

test('group codes are recognised at any of the widths a writer may use', () => {
  const body = (pad) => pad + '0\nSECTION\n' + pad + '2\nHEADER\n' + pad + '0\nENDSEC\n';
  for (const pad of ['', ' ', '  ', '   ', '\t']) {
    assert.equal(sniffContent(body(pad)).format, 'dxf', 'padding ' + JSON.stringify(pad));
  }
});

test('CRLF line endings are recognised', () => {
  assert.equal(sniffContent('  0\r\nSECTION\r\n  2\r\nHEADER\r\n').format, 'dxf');
});

test('the other formats are unaffected', () => {
  assert.equal(sniffContent(fixture('vector-plan.pdf')).format, 'pdf');
  assert.equal(sniffContent(fixture('raster-200x100.png')).format, 'png');
});

test('a binary DWG is still refused as DWG, not mistaken for DXF', () => {
  assert.equal(sniffContent(Buffer.from('AC1027  binary', 'latin1')).format, 'dwg');
});

test('the sniffer has not been loosened into accepting anything', () => {
  const notDxf = [
    'hello world',
    '0\nNOTASECTION\n2\nHEADER',
    'SECTION\n2\nHEADER',
    '  1\nSECTION\n  2\nHEADER',
    '',
    'randomtext\nwith newlines\nbut no dxf structure'
  ];
  for (const candidate of notDxf) {
    assert.equal(sniffContent(candidate).format, 'unknown', JSON.stringify(candidate.slice(0, 24)));
  }
});

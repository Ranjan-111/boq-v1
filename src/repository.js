/* Durable store (R1).
   SQLite behind a narrow interface: src/application.js calls these methods and
   never sees SQL. Plain portable SQL, no ORM, so the move to Postgres -- when
   the project goes multi-tenant or runs more than one node -- is a swap of this
   file rather than a rewrite.

   Shape rule: relational where we query, JSON where we do not. Bounds are four
   real indexed columns because fitting a viewport is a range query on four
   numbers; polygons ride along as JSON text because nothing queries inside them. */

const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL,
  current_boq_version_id TEXT, state_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS buildings (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  version INTEGER NOT NULL, state_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS storeys (
  id TEXT PRIMARY KEY, building_id TEXT NOT NULL, project_id TEXT NOT NULL,
  name TEXT NOT NULL, level TEXT, version INTEGER NOT NULL, state_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS boq_versions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL,
  label TEXT, status TEXT NOT NULL, state_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, version INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL, format TEXT NOT NULL,
  project_id TEXT, building_id TEXT, storey_id TEXT, source_sheet TEXT,
  boq_version_id TEXT, typical_multiplier INTEGER NOT NULL DEFAULT 1,
  content BLOB, state_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS source_documents_scope ON source_documents (project_id, building_id, storey_id);

CREATE TABLE IF NOT EXISTS processing_runs (
  id TEXT PRIMARY KEY, source_document_id TEXT NOT NULL, status TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  project_id TEXT, building_id TEXT, storey_id TEXT, boq_version_id TEXT,
  state_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS processing_runs_document ON processing_runs (source_document_id);

/* One row per stable source object id. See the dedup note on saveRun. */
CREATE TABLE IF NOT EXISTS source_objects (
  source_object_id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL, source_document_version INTEGER NOT NULL,
  building_id TEXT, storey_id TEXT, zone_id TEXT, sheet_id TEXT, page_id TEXT,
  geometry_source TEXT NOT NULL, coordinate_space TEXT NOT NULL, geometry_resolution TEXT NOT NULL,
  min_x REAL, min_y REAL, max_x REAL, max_y REAL,
  geometry_json TEXT NOT NULL, transform_json TEXT, rotation REAL,
  native_handle TEXT, region_id TEXT,
  provenance_version TEXT NOT NULL, geometry_digest TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS source_objects_bounds ON source_objects (min_x, min_y, max_x, max_y);
CREATE INDEX IF NOT EXISTS source_objects_document ON source_objects (source_document_id, source_document_version);

CREATE TABLE IF NOT EXISTS boq_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, position INTEGER NOT NULL,
  measurement TEXT NOT NULL, label TEXT, quantity REAL NOT NULL, unit TEXT NOT NULL,
  measurement_status TEXT NOT NULL, confidence_json TEXT, provenance_extra_json TEXT,
  aggregation_json TEXT);
CREATE INDEX IF NOT EXISTS boq_lines_run ON boq_lines (run_id);

CREATE TABLE IF NOT EXISTS contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, boq_line_id INTEGER NOT NULL,
  position INTEGER NOT NULL, source_object_id TEXT NOT NULL, measurement TEXT NOT NULL,
  sign TEXT NOT NULL CHECK (sign IN ('add', 'deduct')),
  quantity REAL NOT NULL, unit TEXT NOT NULL, rule_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL, typical_multiplier INTEGER NOT NULL, rule_inputs_json TEXT);
CREATE INDEX IF NOT EXISTS contributions_line ON contributions (boq_line_id);
CREATE INDEX IF NOT EXISTS contributions_run ON contributions (run_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
  subject_id TEXT, payload_json TEXT);
CREATE INDEX IF NOT EXISTS audit_events_subject ON audit_events (subject_id);

/* Append-only enforced by the store itself, not by convention. */
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
`;

const json = (value) => (value === undefined ? null : JSON.stringify(value));
const parse = (value) => (value === null || value === undefined ? null : JSON.parse(value));

function digestOf(value) {
  return require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createRepository({ file = ':memory:' } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  let queries = 0;
  const run = (sql, ...args) => { queries += 1; return db.prepare(sql).run(...args); };
  const all = (sql, ...args) => { queries += 1; return db.prepare(sql).all(...args); };
  const get = (sql, ...args) => { queries += 1; return db.prepare(sql).get(...args); };
  const placeholders = (list) => list.map(() => '?').join(',');

  function appendAudit({ kind, subjectId = null, payload = null, at = new Date().toISOString() }) {
    run('INSERT INTO audit_events (at, kind, subject_id, payload_json) VALUES (?, ?, ?, ?)', at, kind, subjectId, json(payload));
  }
  function listAudit({ subjectId } = {}) {
    const rows = subjectId
      ? all('SELECT * FROM audit_events WHERE subject_id = ? ORDER BY id', subjectId)
      : all('SELECT * FROM audit_events ORDER BY id');
    return rows.map((row) => ({ id: row.id, at: row.at, kind: row.kind, subjectId: row.subject_id, payload: parse(row.payload_json) }));
  }

  function saveSourceDocument(document) {
    /* Bytes ride in a BLOB, not in the JSON envelope: a Buffer does not survive
       JSON.stringify as bytes, and the content is exactly what contentSha256
       promises is immutable for this version. */
    const { content, ...envelope } = document;
    run(`INSERT INTO source_documents (id, filename, version, content_sha256, format, project_id, building_id, storey_id, source_sheet, boq_version_id, typical_multiplier, content, state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, building_id = excluded.building_id,
           storey_id = excluded.storey_id, source_sheet = excluded.source_sheet, boq_version_id = excluded.boq_version_id,
           typical_multiplier = excluded.typical_multiplier, content = excluded.content, state_json = excluded.state_json`,
      document.id, document.filename, document.version, document.contentSha256, document.format,
      document.projectId ?? null, document.buildingId ?? null, document.storeyId ?? null,
      document.sourceSheet ?? null, document.boqVersionId ?? null, document.typicalMultiplier ?? 1,
      content ? Buffer.from(content) : null, json(envelope));
  }
  function getSourceDocument(id) {
    const row = get('SELECT content, state_json FROM source_documents WHERE id = ?', id);
    if (!row) return null;
    const envelope = parse(row.state_json);
    return row.content === null ? envelope : { ...envelope, content: row.content };
  }
  function allSourceDocuments() {
    return all('SELECT content, state_json FROM source_documents').map((row) => {
      const envelope = parse(row.state_json);
      return row.content === null ? envelope : { ...envelope, content: row.content };
    });
  }
  function allRunIds() { return all('SELECT id FROM processing_runs ORDER BY rowid').map((row) => row.id); }
  /* Most recent first, so a bounded startup keeps the runs anyone is likely to
     look at and leaves the tail to be fetched on demand. */
  function recentRunIds(limit = 200) { return all('SELECT id FROM processing_runs ORDER BY rowid DESC LIMIT ?', limit).map((row) => row.id); }
  function countRuns() { return get('SELECT COUNT(*) AS total FROM processing_runs').total; }

  /* Many runs in a bounded number of queries: one for the envelopes, three for
     their lines, contributions and source objects. */
  function getRuns(runIds = []) {
    if (!runIds.length) return [];
    const rows = all(`SELECT id, state_json FROM processing_runs WHERE id IN (${placeholders(runIds)})`, ...runIds);
    const results = resultsFor(runIds);
    const objectsById = new Map(results.sourceObjects.map((object) => [object.sourceObjectId, object]));
    return rows.map((row) => {
      const { boqShape, ...envelope } = parse(row.state_json);
      if (!boqShape) return envelope;
      const lines = results.linesByRun.get(row.id) || [];
      const referenced = [...new Set(lines.flatMap((line) => line.provenance.contributions.map((entry) => entry.sourceObjectId)))];
      return { ...envelope, boq: {
        versions: boqShape.versions, ruleset: boqShape.ruleset,
        ...(boqShape.assumptions ? { assumptions: boqShape.assumptions } : {}),
        sourceObjects: referenced.map((id) => objectsById.get(id)).filter(Boolean),
        aggregation: boqShape.aggregation,
        ...(boqShape.unclassified ? { unclassified: boqShape.unclassified } : {}),
        lines } };
    });
  }
  function saveEntity(table, id, columns, record) {
    const names = ['id', ...Object.keys(columns), 'state_json'];
    const values = [id, ...Object.values(columns), json(record)];
    const updates = [...Object.keys(columns), 'state_json'].map((name) => `${name} = excluded.${name}`).join(', ');
    run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT(id) DO UPDATE SET ${updates}`, ...values);
  }
  function allEntities(table) { return all(`SELECT state_json FROM ${table}`).map((row) => parse(row.state_json)); }

  /* Source objects are deduplicated on `sourceObjectId`, which R2 defines to be
     stable across reprocessing of one document version. Geometry is a pure
     function of immutable inputs (that version's bytes, the parser version), so
     two runs of the same version genuinely describe the same object -- storing N
     identical copies is what a primary key exists to prevent, and it is what
     would turn the rollup into a fan-out join.

     Per-run audit correctness is not lost: what a run claimed is recoverable
     through run -> lines -> contributions -> object. Only the shared, immutable
     description is shared.

     The one edge is a parser change altering geometry under an id that already
     exists. That is never silently overwritten: the first write wins, so runs
     keep the geometry they actually measured, and the divergence is recorded on
     the audit trail instead.

     Consequence of first-write-wins: building_id / storey_id / sheet_id on this
     row are the assignment as first observed, and an operator can reassign a
     document afterwards. They are therefore NOT authoritative -- the application
     overlays the assignment of the run being read when it materialises an
     object. The columns stay because they are useful for scoped queries and for
     audit ("where was this when we first saw it"), not as current truth. */
  function putSourceObject(object) {
    const digest = digestOf({ geometry: object.geometry, bounds: object.bounds });
    const existing = get('SELECT geometry_digest FROM source_objects WHERE source_object_id = ?', object.sourceObjectId);
    if (existing) {
      if (existing.geometry_digest !== digest) {
        appendAudit({ kind: 'source_object_geometry_divergence', subjectId: object.sourceObjectId, payload: { storedDigest: existing.geometry_digest, incomingDigest: digest } });
      }
      return;
    }
    run(`INSERT INTO source_objects (source_object_id, source_document_id, source_document_version, building_id, storey_id, zone_id, sheet_id, page_id,
           geometry_source, coordinate_space, geometry_resolution, min_x, min_y, max_x, max_y,
           geometry_json, transform_json, rotation, native_handle, region_id, provenance_version, geometry_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      object.sourceObjectId, object.sourceDocumentId, object.sourceDocumentVersion,
      object.buildingId ?? null, object.storeyId ?? null, object.zoneId ?? null, object.sheetId ?? null, object.pageId ?? null,
      object.geometrySource, object.coordinateSpace, object.geometryResolution,
      object.bounds?.[0] ?? null, object.bounds?.[1] ?? null, object.bounds?.[2] ?? null, object.bounds?.[3] ?? null,
      json(object.geometry), json(object.transform), object.rotation ?? null,
      object.nativeHandle ?? null, object.regionId ?? null, object.version, digest);
  }

  function rowToSourceObject(row) {
    return {
      version: row.provenance_version, sourceObjectId: row.source_object_id,
      sourceDocumentId: row.source_document_id, sourceDocumentVersion: row.source_document_version,
      buildingId: row.building_id, storeyId: row.storey_id, zoneId: row.zone_id,
      sheetId: row.sheet_id, pageId: row.page_id,
      geometrySource: row.geometry_source, coordinateSpace: row.coordinate_space,
      geometryResolution: row.geometry_resolution,
      geometry: parse(row.geometry_json), bounds: [row.min_x, row.min_y, row.max_x, row.max_y],
      transform: parse(row.transform_json), rotation: row.rotation,
      nativeHandle: row.native_handle, regionId: row.region_id
    };
  }
  function rowToContribution(row) {
    return {
      sourceObjectId: row.source_object_id, measurement: row.measurement, sign: row.sign,
      quantity: row.quantity, unit: row.unit, ruleId: row.rule_id,
      rulesetVersion: row.ruleset_version, runId: row.run_id,
      typicalMultiplier: row.typical_multiplier, ruleInputs: parse(row.rule_inputs_json)
    };
  }

  const saveRun = db.transaction((runRecord) => {
    const { boq, ...envelope } = runRecord;
    run('DELETE FROM contributions WHERE run_id = ?', runRecord.id);
    run('DELETE FROM boq_lines WHERE run_id = ?', runRecord.id);
    run(`INSERT INTO processing_runs (id, source_document_id, status, superseded, project_id, building_id, storey_id, boq_version_id, state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, superseded = excluded.superseded,
           project_id = excluded.project_id, building_id = excluded.building_id, storey_id = excluded.storey_id,
           boq_version_id = excluded.boq_version_id, state_json = excluded.state_json`,
      runRecord.id, runRecord.sourceDocumentId, runRecord.status, runRecord.superseded ? 1 : 0,
      runRecord.projectId ?? null, runRecord.buildingId ?? null, runRecord.storeyId ?? null,
      runRecord.boqVersionId ?? null, json({ ...envelope, boqShape: boq ? { versions: boq.versions, ruleset: boq.ruleset, aggregation: boq.aggregation, assumptions: boq.assumptions ?? null, unclassified: boq.unclassified ?? null } : null }));
    if (!boq) return;
    for (const object of boq.sourceObjects || []) putSourceObject(object);
    (boq.lines || []).forEach((line, position) => {
      const { contributions, measurementStatus, aggregation, version, ...extra } = line.provenance || {};
      const inserted = run(`INSERT INTO boq_lines (run_id, position, measurement, label, quantity, unit, measurement_status, confidence_json, provenance_extra_json, aggregation_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runRecord.id, position, line.measurement, line.label ?? null, line.quantity, line.unit,
        line.measurementStatus, json(line.confidence), json({ version, extra }), json(aggregation));
      (contributions || []).forEach((entry, order) => {
        run(`INSERT INTO contributions (run_id, boq_line_id, position, source_object_id, measurement, sign, quantity, unit, rule_id, ruleset_version, typical_multiplier, rule_inputs_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runRecord.id, inserted.lastInsertRowid, order, entry.sourceObjectId, entry.measurement, entry.sign,
          entry.quantity, entry.unit, entry.ruleId, entry.rulesetVersion, entry.typicalMultiplier, json(entry.ruleInputs));
      });
    });
  });

  function getRun(runId) {
    const row = get('SELECT state_json FROM processing_runs WHERE id = ?', runId);
    if (!row) return null;
    const { boqShape, ...envelope } = parse(row.state_json);
    if (!boqShape) return envelope;
    const lineRows = all('SELECT * FROM boq_lines WHERE run_id = ? ORDER BY position', runId);
    const contributionRows = all('SELECT * FROM contributions WHERE run_id = ? ORDER BY boq_line_id, position', runId);
    const byLine = new Map();
    for (const entry of contributionRows) {
      if (!byLine.has(entry.boq_line_id)) byLine.set(entry.boq_line_id, []);
      byLine.get(entry.boq_line_id).push(rowToContribution(entry));
    }
    const objectIds = [...new Set(contributionRows.map((entry) => entry.source_object_id))];
    const objectRows = objectIds.length ? all(`SELECT * FROM source_objects WHERE source_object_id IN (${placeholders(objectIds)})`, ...objectIds) : [];
    const lines = lineRows.map((line) => {
      const { version, extra } = parse(line.provenance_extra_json) || { version: undefined, extra: {} };
      return {
        measurement: line.measurement, label: line.label, quantity: line.quantity, unit: line.unit,
        confidence: parse(line.confidence_json), measurementStatus: line.measurement_status,
        provenance: {
          version, contributions: byLine.get(line.id) || [],
          measurementStatus: line.measurement_status, aggregation: parse(line.aggregation_json),
          ...(extra || {})
        }
      };
    });
    return { ...envelope, boq: { versions: boqShape.versions, ruleset: boqShape.ruleset, ...(boqShape.assumptions ? { assumptions: boqShape.assumptions } : {}), sourceObjects: objectRows.map(rowToSourceObject), aggregation: boqShape.aggregation, ...(boqShape.unclassified ? { unclassified: boqShape.unclassified } : {}), lines } };
  }

  /* Candidate runs for a set of documents, in one query. Which of them wins for
     a given assignment key is a policy decision that stays in the application --
     expressing "latest revision per sheet, tie-broken by run sequence" in SQL
     would risk changing a quantity for no gain. */
  function completedRuns(sourceDocumentIds = []) {
    if (!sourceDocumentIds.length) return [];
    return all(`SELECT id, source_document_id, state_json FROM processing_runs
       WHERE source_document_id IN (${placeholders(sourceDocumentIds)}) AND status = 'completed' AND superseded = 0`, ...sourceDocumentIds)
      .map((row) => ({ id: row.id, sourceDocumentId: row.source_document_id, envelope: parse(row.state_json) }));
  }

  /* Lines, contributions and referenced source objects for many runs at once:
     three queries regardless of how many runs were selected. */
  function resultsFor(runIds = []) {
    if (!runIds.length) return { linesByRun: new Map(), sourceObjects: [] };
    const lineRows = all(`SELECT * FROM boq_lines WHERE run_id IN (${placeholders(runIds)}) ORDER BY run_id, position`, ...runIds);
    const contributionRows = all(`SELECT * FROM contributions WHERE run_id IN (${placeholders(runIds)}) ORDER BY boq_line_id, position`, ...runIds);
    const objectIds = [...new Set(contributionRows.map((entry) => entry.source_object_id))];
    const objectRows = objectIds.length ? all(`SELECT * FROM source_objects WHERE source_object_id IN (${placeholders(objectIds)})`, ...objectIds) : [];
    const byLine = new Map();
    for (const entry of contributionRows) {
      if (!byLine.has(entry.boq_line_id)) byLine.set(entry.boq_line_id, []);
      byLine.get(entry.boq_line_id).push(rowToContribution(entry));
    }
    const linesByRun = new Map();
    for (const row of lineRows) {
      if (!linesByRun.has(row.run_id)) linesByRun.set(row.run_id, []);
      const { version, extra } = parse(row.provenance_extra_json) || { version: undefined, extra: {} };
      linesByRun.get(row.run_id).push({
        measurement: row.measurement, label: row.label, quantity: row.quantity, unit: row.unit,
        confidence: parse(row.confidence_json), measurementStatus: row.measurement_status,
        provenance: { version, contributions: byLine.get(row.id) || [], measurementStatus: row.measurement_status, aggregation: parse(row.aggregation_json), ...(extra || {}) }
      });
    }
    return { linesByRun, sourceObjects: objectRows.map(rowToSourceObject) };
  }

  /* Bounded: one query for the runs, one for their lines, one for their
     contributions, one for the referenced objects. Adding contributing runs
     widens the IN lists; it does not add queries. */
  function rollup({ sourceDocumentIds = [], scope, scopeId, boqVersionId = null, includeRun = () => true }) {
    const empty = { scope, scopeId, boqVersionId, lines: [], sourceObjects: [] };
    if (!sourceDocumentIds.length) return empty;
    const runRows = all(`SELECT id, source_document_id, state_json FROM processing_runs
       WHERE source_document_id IN (${placeholders(sourceDocumentIds)}) AND status = 'completed' AND superseded = 0`, ...sourceDocumentIds)
      .map((row) => ({ id: row.id, sourceDocumentId: row.source_document_id, envelope: parse(row.state_json) }))
      .filter((entry) => includeRun(entry.envelope));
    if (!runRows.length) return empty;
    const runIds = runRows.map((entry) => entry.id);
    const lineRows = all(`SELECT * FROM boq_lines WHERE run_id IN (${placeholders(runIds)}) ORDER BY run_id, position`, ...runIds);
    const contributionRows = all(`SELECT * FROM contributions WHERE run_id IN (${placeholders(runIds)}) ORDER BY boq_line_id, position`, ...runIds);
    const objectIds = [...new Set(contributionRows.map((entry) => entry.source_object_id))];
    const objectRows = objectIds.length ? all(`SELECT * FROM source_objects WHERE source_object_id IN (${placeholders(objectIds)})`, ...objectIds) : [];
    const byLine = new Map();
    for (const entry of contributionRows) {
      if (!byLine.has(entry.boq_line_id)) byLine.set(entry.boq_line_id, []);
      byLine.get(entry.boq_line_id).push(rowToContribution(entry));
    }
    const lines = new Map();
    for (const row of lineRows) {
      const line = lines.get(row.measurement) || {
        measurement: row.measurement, label: row.label, quantity: 0, unit: row.unit,
        measurementStatus: 'not_measurable',
        provenance: { version: 'provenance-v2', contributions: [], measurementStatus: 'not_measurable', aggregation: { scope, scopeId } }
      };
      line.quantity = Number((line.quantity + row.quantity).toFixed(6));
      line.provenance.contributions.push(...(byLine.get(row.id) || []));
      lines.set(row.measurement, line);
    }
    return { scope, scopeId, boqVersionId, lines: [...lines.values()], sourceObjects: objectRows.map(rowToSourceObject) };
  }

  return {
    saveSourceDocument, getSourceDocument, allSourceDocuments, allRunIds, recentRunIds, countRuns, getRuns, saveEntity, allEntities,
    saveRun, getRun, rollup, completedRuns, resultsFor, appendAudit, listAudit,
    countSourceObjects: () => get('SELECT COUNT(*) AS total FROM source_objects').total,
    measureQueries(work) { const before = queries; const result = work(); return { result, queries: queries - before }; },
    unsafeExec: (sql) => db.prepare(sql).run(),
    isOpen: () => db.open,
    close: () => db.close()
  };
}

module.exports = { createRepository, SCHEMA };

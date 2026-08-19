const form = document.querySelector('#upload-form');
const message = document.querySelector('#message');
const runSection = document.querySelector('#run');
const reviewSection = document.querySelector('#review');
const runSummary = document.querySelector('#run-summary');
const boqLines = document.querySelector('#boq-lines');
const reprocess = document.querySelector('#reprocess');
let currentRunId = null;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit('/api/source-documents', new FormData(form));
});

reprocess.addEventListener('click', async () => {
  await submit(`/api/runs/${currentRunId}/reprocess`);
});

async function submit(url, body) {
  message.textContent = 'Submitting drawing…';
  message.className = '';
  form.querySelector('button').disabled = true;
  try {
    const response = await fetch(url, { method: 'POST', body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    currentRunId = result.processingRun.id;
    message.textContent = `Source ${result.processingRun.sourceDocument.id} v${result.processingRun.sourceDocument.version} accepted.`;
    runSection.hidden = false;
    reviewSection.hidden = true;
    reprocess.hidden = true;
    await pollRun();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
  } finally {
    form.querySelector('button').disabled = false;
  }
}

async function pollRun() {
  const response = await fetch(`/api/runs/${currentRunId}`);
  const run = await response.json();
  renderRun(run);
  if (run.status === 'completed') {
    renderBoq(run.boq.lines);
    reprocess.hidden = false;
    return;
  }
  if (run.status === 'failed') {
    message.textContent = run.error;
    message.className = 'error';
    return;
  }
  setTimeout(pollRun, 50);
}

function renderRun(run) {
  const unitStatus = run.units
    ? Object.assign(document.createElement('span'), {
      className: `stage ${run.units.source === 'operator-assumption' ? 'running' : 'completed'}`,
      textContent: `units: ${run.units.name} (${run.units.source})`
    })
    : null;
  runSummary.replaceChildren(...[
    Object.assign(document.createElement('strong'), { textContent: `${run.id}: ${run.status}` }),
    ...(unitStatus ? [unitStatus] : []),
    ...run.stages.map((stage) => {
      const element = document.createElement('span');
      element.className = `stage ${stage.status}`;
      element.textContent = `${stage.name}: ${stage.status}`;
      return element;
    })
  ]);
}

function renderBoq(lines) {
  boqLines.replaceChildren(...lines.map((line) => {
    const row = document.createElement('tr');
    const provenance = `${line.provenance.sourceDocumentId} v${line.provenance.sourceDocumentVersion}\n${line.provenance.sourceHandles.join(', ')}`;
    for (const value of [
      line.label,
      String(line.quantity),
      line.unit,
      `${line.confidence.level}: ${line.confidence.evidence.join(', ')}`,
      line.measurementStatus,
      provenance
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  reviewSection.hidden = false;
}

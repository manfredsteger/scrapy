// API-level regression test for the concurrent-tab write guards on projects.
// Run with the dev server up: node scripts/concurrency-regression.mjs [baseUrl]
const B = process.argv[2] || 'http://127.0.0.1:5000';
const j = (m, u, b) => fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures++;
}

// --- Scenario 1: lease + CAS on the generic project PUT -------------------
{
  const p = await (await j('POST', '/api/projects', { domain: 'test-concurrency.example', status: 'scraping', queue: ['a', 'b'], processed: [], results: [], errors: [] })).json();
  let r = await j('PUT', `/api/projects/${p.id}`, { queue: ['b'], processed: ['a'], lockOwner: 'tab1' });
  const d = await r.json();
  check('owner progress write succeeds and takes lease', r.status === 200 && d.scrapeLock?.owner === 'tab1');

  r = await j('PUT', `/api/projects/${p.id}`, { queue: [], processed: ['a', 'b'], lockOwner: 'tab2' });
  check('foreign progress write rejected (locked)', r.status === 409 && (await r.json()).reason === 'locked');

  r = await j('PUT', `/api/projects/${p.id}`, { queue: ['x'], lockOwner: 'tab1', expectedVersion: 0 });
  check('stale CAS rejected (version_conflict)', r.status === 409 && (await r.json()).reason === 'version_conflict');

  r = await j('PUT', `/api/projects/${p.id}`, { displayName: 'renamed', lockOwner: 'tab2' });
  const d2 = await r.json();
  check('unrelated write cannot steal the lease', r.status === 200 && d2.scrapeLock?.owner === 'tab1');

  await fetch(B + `/api/projects/${p.id}`, { method: 'DELETE' });
}

// --- Scenario 2: stale stop from a second tab must not erase progress -----
{
  const p = await (await j('POST', '/api/projects', { domain: 'test-stalestop.example', status: 'scraping', queue: ['a', 'b', 'c'], processed: [], results: [], errors: [] })).json();
  // Active owner advances the queue (holds the lease)
  await j('PUT', `/api/projects/${p.id}`, { queue: ['b', 'c'], processed: ['a'], lockOwner: 'tab1' });
  // Second tab stops from stale UI state, sending an empty queue payload
  let r = await j('PUT', `/api/projects/${p.id}`, { status: 'idle', queue: [], lockOwner: 'tab2' });
  const d = await r.json();
  check('foreign stop honored (status change allowed)', r.status === 200 && d.status === 'idle');
  check('foreign stop does NOT erase owner queue', Array.isArray(d.queue) && d.queue.length === 2, `queue=${JSON.stringify(d.queue)}`);
  check('foreign stop clears the lease', !d.scrapeLock);
  // Owner stop (same lease holder) may clear its own queue
  await j('PUT', `/api/projects/${p.id}`, { status: 'scraping', queue: ['b', 'c'], lockOwner: 'tab1' });
  await j('PUT', `/api/projects/${p.id}`, { processed: ['a'], lockOwner: 'tab1' });
  r = await j('PUT', `/api/projects/${p.id}`, { status: 'idle', queue: [], lockOwner: 'tab1' });
  const d3 = await r.json();
  check('owner stop may clear its own queue', r.status === 200 && d3.queue.length === 0);
  await fetch(B + `/api/projects/${p.id}`, { method: 'DELETE' });
}

// --- Scenario 3: guarded server-side endpoints -----------------------------
{
  const p = await (await j('POST', '/api/projects', { domain: 'example.com', status: 'content_scraping', queue: ['https://example.com/'], processed: [], results: [{ loc: 'https://example.com/', images: [], videos: [] }], errors: [] })).json();
  await j('PUT', `/api/projects/${p.id}`, { queue: ['https://example.com/'], lockOwner: 'tab1' });

  let r = await j('POST', '/api/scrape/content', { urls: ['https://example.com/'], projectId: p.id, lockOwner: 'tab2' });
  check('content batch from foreign tab rejected', r.status === 409);

  r = await j('POST', `/api/projects/${p.id}/start-extraction`, { lockOwner: 'tab2' });
  check('start-extraction from foreign tab rejected', r.status === 409);

  r = await j('POST', `/api/projects/${p.id}/sync-errors`, { lockOwner: 'tab2' });
  check('sync-errors from foreign tab rejected', r.status === 409);

  r = await j('POST', '/api/scrape/content', { urls: ['https://example.com/'], projectId: p.id, lockOwner: 'tab1' });
  const d = await r.json();
  check('content batch from owner succeeds with version', r.status === 200 && typeof d.version === 'number');

  if (typeof d.version === 'number') {
    r = await j('PUT', `/api/projects/${p.id}`, { queue: [], lockOwner: 'tab1', expectedVersion: d.version });
    check('owner follow-up CAS write succeeds', r.status === 200);
  }
  await fetch(B + `/api/projects/${p.id}`, { method: 'DELETE' });
}

// --- Scenario 4: sync-attachments vs. active owner -------------------------
{
  const p = await (await j('POST', '/api/projects', { domain: 'test-attach.example', status: 'content_scraping', queue: ['https://test-attach.example/'], processed: [], results: [{ loc: 'https://test-attach.example/doc.pdf', images: [], videos: [] }], errors: [] })).json();
  // Active owner holds the lease
  await j('PUT', `/api/projects/${p.id}`, { queue: ['https://test-attach.example/'], lockOwner: 'tab1' });
  // Foreign tab tries attachment sync -> rejected before any write
  let r = await fetch(B + `/api/projects/${p.id}/sync-attachments?lockOwner=tab2`);
  check('sync-attachments from foreign tab rejected', r.status === 409, `status=${r.status}`);
  // Owner may run it (SSE stream; just verify it starts)
  r = await fetch(B + `/api/projects/${p.id}/sync-attachments?lockOwner=tab1`);
  check('sync-attachments from owner starts', r.status === 200, `status=${r.status}`);
  try { await r.body?.cancel(); } catch {}
  await fetch(B + `/api/projects/${p.id}`, { method: 'DELETE' });
}

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

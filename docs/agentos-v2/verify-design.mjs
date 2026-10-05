// Design-only validation; creates SQLite :memory: databases, no runtime/data changes.
// Run: node docs/agentos-v2/verify-design.mjs (requires sqlite3 CLI).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const dir = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'openapi.json'), 'utf8'));
assert.equal(spec.openapi, '3.1.0');
assert.equal(spec['x-design-status'], 'proposed');
const operationIds = new Set();
const errors = [];
let refs = 0;
function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) {
    assert.ok(value.$ref.startsWith('#/'), 'Unexpected external schema ref');
    const parts = value.$ref.slice(2).split('/').map(x => x.replaceAll('~1','/').replaceAll('~0','~'));
    assert.ok(parts.reduce((node, key) => node?.[key], spec), 'Unresolved ref '+value.$ref);
    refs++;
  }
  Object.values(value).forEach(walk);
}
walk(spec);
for (const [route, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    assert.ok(!operationIds.has(op.operationId), 'Duplicate operationId');
    operationIds.add(op.operationId);
    const params = op.parameters ?? [];
    for (const match of route.matchAll(/\{([^}]+)\}/g)) {
      assert.ok(params.some(p => p.name===match[1] && p.in==='path' && p.required), 'Missing path parameter');
    }
    assert.ok(Object.keys(op.responses).some(s => Number(s)>=200 && Number(s)<300));
    if (!['health','login'].includes(op.operationId)) {
      assert.ok(op.security.some(x => 'SessionCookie' in x), 'Missing session protection');
      if (method!=='get') assert.ok(op.security.some(x => 'Csrf' in x && 'SessionCookie' in x), 'Missing CSRF');
    }
  }
}
assert.equal(spec.components.schemas.CredentialWrite.properties.secret.writeOnly, true);
assert.ok(!('secret' in spec.components.schemas.CredentialStatus.properties));

let links = 0;
for (const file of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
  const text = fs.readFileSync(path.join(dir,file),'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    if (!fs.existsSync(path.resolve(dir,target))) errors.push(file+': '+target);
    links++;
  }
}
assert.deepEqual(errors, [], 'Broken local document links');

const schema = fs.readFileSync(path.join(dir,'schemas/workspace-core.sql'),'utf8');
const fixture = `
INSERT INTO workspace VALUES ('w1','family',1,1,'2026-10-04'), ('w2','personal',1,1,'2026-10-04');
INSERT INTO blob VALUES ('w1','b1','${'a'.repeat(64)}',10,'handle-1','2026-10-04'), ('w2','b1','${'b'.repeat(64)}',10,'handle-2','2026-10-04');
INSERT INTO source_record VALUES ('w1','s1','import','n','key-1','invoice.pdf','application/pdf','active',1,'2026-10-04'), ('w2','s2','import','n','key-2','private.pdf','application/pdf','active',1,'2026-10-04');
INSERT INTO source_revision VALUES ('w1','r1','s1',1,'v1','b1','2026-10-04'), ('w2','r2','s2',1,'v1','b1','2026-10-04');
INSERT INTO evidence VALUES ('w1','e1','r1','{"page":1}','parser-1','2026-10-04');
INSERT INTO object_type VALUES ('w1','Asset',1,'{}'), ('w2','Asset',1,'{}');
INSERT INTO object VALUES ('w1','o1','Asset',1,'AC','active',1,'human-1','2026-10-04','2026-10-04'), ('w2','o2','Asset',1,'Private AC','active',1,'human-2','2026-10-04','2026-10-04');
INSERT INTO assertion VALUES ('w1','a1','o1','purchase_date','"2025-06"','candidate',0.9,'e1','extractor','v1',NULL,NULL,1,'2026-10-04'), ('w1','a2','o1','purchase_date','"2025-07"','candidate',0.8,'e1','extractor','v1',NULL,NULL,1,'2026-10-04');
INSERT INTO plan VALUES ('w1','p1','family.repair.prepare','1.0','human-1','{}','digest','hash','[]','[]',1,'approved','human-1',NULL,'2026-10-05',1,'2026-10-04');
INSERT INTO action VALUES ('w1','act1','p1','human-1','family.repair.prepare','same-key','digest',1,'local_reversible','pending',NULL,1,'2026-10-04');
INSERT INTO job VALUES ('w1','j1','act1','repair','queued','{}',NULL,0,NULL,1,'2026-10-04','2026-10-04');
`;
let sqlTests = 0;
function sqlCase(name, query, {reject=false, expected}={}) {
  const result = spawnSync('sqlite3', [':memory:'], {
    input: '.bail on\n'+schema+'\n'+fixture+'\n'+query+'\n', encoding:'utf8', maxBuffer:2*1024*1024
  });
  if (result.error) throw result.error;
  if (reject) {
    assert.notEqual(result.status,0,name+' should fail');
    assert.match(result.stderr,/constraint failed/i,name+' unexpected failure');
  } else {
    assert.equal(result.status,0,name+': '+result.stderr);
    if (expected!==undefined) assert.equal(result.stdout.trim(),expected,name);
  }
  sqlTests++;
}
// Positive baseline first: negative tests cannot pass just because the schema is broken.
sqlCase('schema/fixture integrity', 'PRAGMA integrity_check; PRAGMA foreign_key_check;', {expected:'ok'});
sqlCase('conflicting facts coexist', "SELECT count(*) FROM assertion WHERE object_id='o1' AND predicate='purchase_date';", {expected:'2'});
sqlCase('cross-space evidence rejected', "INSERT INTO evidence VALUES ('w1','bad','r2','{}','p1','now');", {reject:true});
sqlCase('cross-space relation rejected', "INSERT INTO relation VALUES ('w1','bad','same_as','o1','o2','e1','candidate',NULL,NULL,1);", {reject:true});
sqlCase('duplicate source version rejected', "INSERT INTO source_revision VALUES ('w1','duplicate','s1',1,'v1','b1','now');", {reject:true});
sqlCase('duplicate action idempotency rejected', "INSERT INTO action SELECT workspace_id,'act2',plan_id,principal_id,command,idempotency_key,input_digest,policy_revision,effect,status,compensates_action_id,revision,created_at FROM action;", {reject:true});
sqlCase('duplicate checkpoint rejected', "INSERT INTO job_step VALUES ('w1','step1','j1','parse','hash','v1','pending','{}',0); INSERT INTO job_step VALUES ('w1','step2','j1','parse','hash','v1','pending','{}',0);", {reject:true});
sqlCase('invalid job status rejected', "UPDATE job SET state='pretend_done' WHERE id='j1';", {reject:true});
sqlCase('invalid JSON rejected', "UPDATE assertion SET value_json='not-json' WHERE id='a1';", {reject:true});
sqlCase('outbox rollback atomicity', "BEGIN; UPDATE object SET revision=2 WHERE id='o1'; INSERT INTO event_outbox(workspace_id,event_id,event_type,aggregate_id,aggregate_revision,payload_json,occurred_at) VALUES ('w1','ev1','object.changed','o1',2,'{}','now'); ROLLBACK; SELECT revision FROM object WHERE id='o1'; SELECT count(*) FROM event_outbox;", {expected:'1\n0'});
sqlCase('consumer dedup rejected', "INSERT INTO consumer_inbox VALUES ('w1','indexer','evt1','now'); INSERT INTO consumer_inbox VALUES ('w1','indexer','evt1','now');", {reject:true});
const sqliteVersion = spawnSync('sqlite3',['--version'],{encoding:'utf8'}).stdout.trim().split(' ')[0];
console.log(JSON.stringify({status:'passed',operations:operationIds.size,schema_refs:refs,local_links:links,sql_cases:sqlTests,sqlite_syntax_test_version:sqliteVersion,limitations:'Structural checks, not a full OpenAPI validator or runtime/ACL/WAL/OS integration test.'},null,2));

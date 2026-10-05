-- V2.0 design skeleton, NOT a production migration or authorization engine.
-- SQLite with JSON functions; production runtime version policy: data-model.md §2.
PRAGMA foreign_keys = ON;

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal','family')),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE membership (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member','guest')),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (workspace_id,principal_id)
);
CREATE TABLE access_grant (
  workspace_id TEXT NOT NULL REFERENCES workspace(id), id TEXT NOT NULL,
  principal_id TEXT NOT NULL, delegation_id TEXT,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
  purpose TEXT NOT NULL, expires_at TEXT NOT NULL,
  policy_revision INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE blob (
  workspace_id TEXT NOT NULL REFERENCES workspace(id), id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size>=0),
  storage_handle TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,sha256)
);
CREATE TABLE source_record (
  workspace_id TEXT NOT NULL REFERENCES workspace(id), id TEXT NOT NULL,
  connector_id TEXT NOT NULL, namespace TEXT NOT NULL, source_key TEXT NOT NULL,
  display_name TEXT NOT NULL, media_type TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','missing','tombstoned')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0), created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,connector_id,namespace,source_key)
);
CREATE TABLE source_revision (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision>0), upstream_version TEXT NOT NULL,
  blob_id TEXT NOT NULL, captured_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,source_id,revision),
  UNIQUE (workspace_id,source_id,upstream_version,blob_id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES source_record(workspace_id,id),
  FOREIGN KEY (workspace_id,blob_id) REFERENCES blob(workspace_id,id)
);
CREATE TABLE evidence (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, source_revision_id TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  producer_version TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,source_revision_id) REFERENCES source_revision(workspace_id,id)
);
CREATE TABLE object_type (
  workspace_id TEXT NOT NULL REFERENCES workspace(id), id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version>0),
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  PRIMARY KEY (workspace_id,id,version)
);
CREATE TABLE object (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, type_id TEXT NOT NULL,
  type_version INTEGER NOT NULL, display_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','merged','tombstoned')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,type_id,type_version) REFERENCES object_type(workspace_id,id,version)
);
CREATE TABLE assertion (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, object_id TEXT NOT NULL,
  predicate TEXT NOT NULL, value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  status TEXT NOT NULL CHECK (status IN ('candidate','confirmed','rejected','superseded','tombstoned')),
  confidence REAL CHECK (confidence>=0 AND confidence<=1),
  evidence_id TEXT NOT NULL, producer TEXT NOT NULL, producer_version TEXT NOT NULL,
  valid_from TEXT, valid_until TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,object_id) REFERENCES object(workspace_id,id),
  FOREIGN KEY (workspace_id,evidence_id) REFERENCES evidence(workspace_id,id)
  -- No UNIQUE(object,predicate): conflicting assertions must coexist.
);
CREATE TABLE relation (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, type_id TEXT NOT NULL,
  from_object_id TEXT NOT NULL, to_object_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate','confirmed','rejected','superseded','tombstoned')),
  valid_from TEXT, valid_until TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,from_object_id) REFERENCES object(workspace_id,id),
  FOREIGN KEY (workspace_id,to_object_id) REFERENCES object(workspace_id,id),
  FOREIGN KEY (workspace_id,evidence_id) REFERENCES evidence(workspace_id,id)
);
CREATE TABLE proposal (
  workspace_id TEXT NOT NULL REFERENCES workspace(id), id TEXT NOT NULL,
  kind TEXT NOT NULL, target_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','expired','superseded')),
  created_by TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at TEXT NOT NULL, PRIMARY KEY (workspace_id,id)
);
CREATE TABLE decision (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, proposal_id TEXT NOT NULL,
  decider_principal_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accept','reject')),
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision>0),
  evidence_snapshot_json TEXT NOT NULL CHECK (json_valid(evidence_snapshot_json)),
  created_at TEXT NOT NULL, PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,proposal_id) REFERENCES proposal(workspace_id,id)
);
CREATE TABLE value_assessment (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('long_term','contextual')),
  purpose TEXT NOT NULL, rationale TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  producer_version TEXT NOT NULL, context_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate','confirmed','stale','tombstoned')),
  valid_until TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,object_id) REFERENCES object(workspace_id,id)
);
CREATE TABLE dependency (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  dependent_kind TEXT NOT NULL, dependent_id TEXT NOT NULL,
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision TEXT NOT NULL,
  PRIMARY KEY (workspace_id,dependent_kind,dependent_id,source_kind,source_id,source_revision)
  -- Polymorphic refs require core validation; SQL alone cannot authorize them.
);
CREATE TABLE plan (
  workspace_id TEXT NOT NULL REFERENCES workspace(id), id TEXT NOT NULL,
  command TEXT NOT NULL, command_version TEXT NOT NULL, principal_id TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  input_digest TEXT NOT NULL, plan_hash TEXT NOT NULL,
  diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
  evidence_snapshot_json TEXT NOT NULL CHECK (json_valid(evidence_snapshot_json)),
  policy_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','expired','superseded','applied')),
  decision_principal_id TEXT, grant_id TEXT, expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0), created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,grant_id) REFERENCES access_grant(workspace_id,id)
);
CREATE TABLE action (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, plan_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, command TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL, policy_revision INTEGER NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('local_reversible','external','destructive')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','unknown','partial','compensation_pending','compensated','compensation_failed')),
  compensates_action_id TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at TEXT NOT NULL, PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,principal_id,command,idempotency_key),
  FOREIGN KEY (workspace_id,plan_id) REFERENCES plan(workspace_id,id),
  FOREIGN KEY (workspace_id,compensates_action_id) REFERENCES action(workspace_id,id)
);
CREATE TABLE job (
  workspace_id TEXT NOT NULL REFERENCES workspace(id), id TEXT NOT NULL,
  action_id TEXT, kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting_decision','waiting_unlock','paused','succeeded','failed','cancelled','blocked_unknown')),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  lease_owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch>=0), lease_until TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,action_id) REFERENCES action(workspace_id,id)
);
CREATE TABLE job_step (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL,
  stage TEXT NOT NULL, input_digest TEXT NOT NULL, pipeline_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','blocked')),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,job_id,stage,input_digest,pipeline_version),
  FOREIGN KEY (workspace_id,job_id) REFERENCES job(workspace_id,id)
);
CREATE TABLE receipt (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, action_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','unknown','partial')),
  external_operation_id TEXT, result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  verified_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,action_id) REFERENCES action(workspace_id,id)
);
CREATE TABLE event_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspace(id), event_id TEXT NOT NULL,
  event_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), occurred_at TEXT NOT NULL,
  UNIQUE (workspace_id,event_id), UNIQUE (workspace_id,sequence)
);
CREATE TABLE consumer_inbox (
  workspace_id TEXT NOT NULL REFERENCES workspace(id), consumer_id TEXT NOT NULL,
  event_id TEXT NOT NULL, processed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,consumer_id,event_id)
);
CREATE TABLE audit_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspace(id), audit_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, request_id TEXT NOT NULL, operation TEXT NOT NULL,
  target_ref TEXT NOT NULL, policy_revision INTEGER NOT NULL,
  outcome TEXT NOT NULL, summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  created_at TEXT NOT NULL, exported_at TEXT,
  UNIQUE (workspace_id,audit_id)
);
CREATE INDEX assertion_object ON assertion(workspace_id,object_id,predicate,status);
CREATE INDEX relation_from ON relation(workspace_id,from_object_id,type_id,status);
CREATE INDEX relation_to ON relation(workspace_id,to_object_id,type_id,status);
CREATE INDEX dependency_source ON dependency(workspace_id,source_kind,source_id);
CREATE INDEX job_queue ON job(workspace_id,state,created_at);
CREATE INDEX audit_pending ON audit_outbox(exported_at,sequence);

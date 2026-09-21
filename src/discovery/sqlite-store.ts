import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { DiscoveryNode, DiscoveryStore, JsonValue } from './models.js';

export class SQLiteDiscoveryStore implements DiscoveryStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS discovery_nodes (
        node_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        parent_id TEXT,
        policy_version TEXT NOT NULL,
        environment_version TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        observation_hash TEXT NOT NULL,
        action_type TEXT NOT NULL,
        action_params_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        score REAL NOT NULL,
        token_cost REAL NOT NULL,
        exec_time_ms REAL NOT NULL,
        critical_path_ms REAL,
        session_id TEXT,
        episode_step INTEGER,
        correlation_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discovery_task ON discovery_nodes(task_id, node_id);
      CREATE INDEX IF NOT EXISTS idx_discovery_parent ON discovery_nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_discovery_policy ON discovery_nodes(policy_version);
      CREATE INDEX IF NOT EXISTS idx_discovery_environment ON discovery_nodes(environment_version);
      CREATE INDEX IF NOT EXISTS idx_discovery_created_at ON discovery_nodes(created_at);
    `);
  }

  append(node: DiscoveryNode): DiscoveryNode {
    const existing = this.database.prepare(
      'SELECT * FROM discovery_nodes WHERE idempotency_key = ?'
    ).get(node.idempotencyKey) as SqliteRow | undefined;
    if (existing !== undefined) return deserializeNode(existing);

    this.database.prepare(`
      INSERT INTO discovery_nodes (
        node_id, task_id, parent_id, policy_version, environment_version,
        state_hash, observation_hash, action_type, action_params_json,
        result_json, score, token_cost, exec_time_ms, critical_path_ms,
        session_id, episode_step, correlation_id, idempotency_key,
        schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.nodeId,
      node.taskId,
      node.parentId,
      node.policyVersion,
      node.environmentVersion,
      node.stateHash,
      node.observationHash,
      node.actionType,
      JSON.stringify(node.actionParams),
      JSON.stringify(node.result),
      node.score,
      node.tokenCost,
      node.execTimeMs,
      node.criticalPathMs ?? null,
      node.sessionId ?? null,
      node.episodeStep ?? null,
      node.correlationId ?? null,
      node.idempotencyKey,
      node.schemaVersion,
      node.createdAt
    );
    return node;
  }

  get(nodeId: string): DiscoveryNode | undefined {
    const row = this.database.prepare(
      'SELECT * FROM discovery_nodes WHERE node_id = ?'
    ).get(nodeId) as SqliteRow | undefined;
    return row === undefined ? undefined : deserializeNode(row);
  }

  listByTask(taskId: string): DiscoveryNode[] {
    const rows = this.database.prepare(
      'SELECT * FROM discovery_nodes WHERE task_id = ? ORDER BY node_id'
    ).all(taskId) as unknown as SqliteRow[];
    return rows.map(deserializeNode);
  }

  close(): void {
    this.database.close();
  }
}

interface SqliteRow {
  node_id: string;
  task_id: string;
  parent_id: string | null;
  policy_version: string;
  environment_version: string;
  state_hash: string;
  observation_hash: string;
  action_type: string;
  action_params_json: string;
  result_json: string;
  score: number;
  token_cost: number;
  exec_time_ms: number;
  critical_path_ms: number | null;
  session_id: string | null;
  episode_step: number | null;
  correlation_id: string | null;
  idempotency_key: string;
  schema_version: number;
  created_at: string;
}

function deserializeNode(row: SqliteRow): DiscoveryNode {
  return {
    nodeId: row.node_id,
    taskId: row.task_id,
    parentId: row.parent_id,
    policyVersion: row.policy_version,
    environmentVersion: row.environment_version,
    stateHash: row.state_hash,
    observationHash: row.observation_hash,
    actionType: row.action_type,
    actionParams: JSON.parse(row.action_params_json) as JsonValue,
    result: JSON.parse(row.result_json) as JsonValue,
    score: row.score,
    tokenCost: row.token_cost,
    execTimeMs: row.exec_time_ms,
    ...(row.critical_path_ms !== null ? { criticalPathMs: row.critical_path_ms } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.episode_step !== null ? { episodeStep: row.episode_step } : {}),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    idempotencyKey: row.idempotency_key,
    schemaVersion: row.schema_version,
    createdAt: row.created_at
  };
}
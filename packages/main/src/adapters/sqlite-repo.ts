import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { localDayOf } from '@agent-drove/core'
import { compareTaskOrder } from '@agent-drove/shared'
import type {
  JournalEntry,
  JournalStore,
  ModelPreset,
  PlanInfo,
  Project,
  StoredEvent,
  TaskRecord,
  TaskRepository,
  TaskUsage,
  UsageLedger,
  WorkspaceRow,
  WorkspaceStore,
} from '@agent-drove/core'

/**
 * SQLite 适配器:5.2 全 schema,WAL + user_version 递增迁移。
 * 同一实例同时实现 TaskRepository/UsageLedger/JournalStore/WorkspaceStore 四个端口。
 * 启动完整性检查失败或迁移失败统一走"备份重命名 + 重建 + 提示恢复"(5.5),
 * 不设只读安全模式——单机自用场景下空库比半死库更可预期。
 */

type SqliteDb = InstanceType<typeof Database>

/**
 * 库内任务的完整形态:core TaskRecord + main 侧维护的手动排序位(P0-2)。
 * orderIndex 仅由本仓库的 moveTask/reorderTask 写入,编排层不感知。
 */
export type StoredTask = TaskRecord & { orderIndex?: number }

/**
 * 分组内展示序比较器单一事实源在 shared(P0-2 复审:渲染层分组渲染同用一份,
 * 全局列表序与组内序职责分离),此处 re-export 兼容既有导入与测试。
 */
export { compareTaskOrder }

/** 同上语义的 SQL 版,供 groupOrderIds 取组内基准序 */
const GROUP_ORDER_SQL = 'ORDER BY order_index IS NULL, order_index, created_at DESC'

/** 迁移步骤表(导出仅供测试构造历史版本库);index+1 = user_version */
export const MIGRATIONS: ((db: SqliteDb) => void)[] = [
  // v1:核心三表(agents/tasks/events)
  (db) => {
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, driver TEXT NOT NULL,
        entry TEXT NOT NULL, version TEXT, logo_path TEXT,
        plan_json TEXT NOT NULL, models_json TEXT NOT NULL,
        default_model TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        supported_versions TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        model_id TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
        state TEXT NOT NULL, session_id TEXT, parent_id TEXT, error TEXT,
        attachments_json TEXT, tool_policy_json TEXT,
        origin TEXT NOT NULL DEFAULT 'panel',
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        retry_of TEXT, attempt INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_tasks_agent ON tasks(agent_id, created_at);
      CREATE INDEX idx_tasks_state ON tasks(state);
      CREATE TABLE events (
        task_id TEXT NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
    `)
  },
  // v2:工作区登记/用量台账/审计日志
  (db) => {
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        path TEXT NOT NULL, kind TEXT NOT NULL, source TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL, cleanup_after INTEGER
      );
      CREATE TABLE usage (
        agent_id TEXT NOT NULL, day TEXT NOT NULL,
        task_count INTEGER NOT NULL DEFAULT 0,
        estimated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, day)
      );
      CREATE TABLE journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        action TEXT NOT NULL, origin TEXT NOT NULL,
        agent_id TEXT, task_id TEXT, detail TEXT
      );
    `)
  },
  // v3:任务档位与 -c 续聊语义落库(--mode 必须显式;无会话 id 的续聊按 resume_latest 透传)
  (db) => {
    db.exec(`ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'build';`)
    db.exec(`ALTER TABLE tasks ADD COLUMN resume_latest INTEGER;`)
  },
  // v4:项目工作区(侧栏可选中);任务记 project_id 供按工作区分组;"日常工作区"由组合根 upsert 内置行
  (db) => {
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT,
        created_at INTEGER NOT NULL
      );
      ALTER TABLE tasks ADD COLUMN project_id TEXT;
      CREATE INDEX idx_tasks_project ON tasks(project_id, created_at);
    `)
  },
  // v5: 对话标题与技能列表支持 (Agent 增强)
  (db) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN title TEXT;
      ALTER TABLE tasks ADD COLUMN skills_json TEXT;
    `)
  },
  // v6: 任务消耗统计与缓存命中率
  (db) => {
    db.exec(`ALTER TABLE tasks ADD COLUMN usage_json TEXT;`)
  },
  // v7: 卡片手动排序位(P0-2)与请求思考档位(P0-4);均可空,旧行零迁移成本
  (db) => {
    db.exec(`ALTER TABLE tasks ADD COLUMN order_index INTEGER;`)
    db.exec(`ALTER TABLE tasks ADD COLUMN reasoning_effort TEXT;`)
  },
]

export class SqliteStore
  implements TaskRepository, UsageLedger, JournalStore, WorkspaceStore
{
  /** 完整性恢复后由 openStore 回填,UI 据此提示用户 */
  recoveredFrom?: string

  private readonly db: SqliteDb

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    try {
      db.pragma('journal_mode = WAL')
      this.migrate(db, dbPath)
    } catch (error) {
      // 关键:失败必须释放句柄,否则 Windows 上外层的备份重命名会因文件占用而失败
      db.close()
      throw error
    }
    this.db = db
  }

  private migrate(db: SqliteDb, dbPath: string): void {
    const check = db.pragma('quick_check', { simple: true }) as string
    if (check !== 'ok') {
      throw new Error(`数据库完整性检查失败:${check}`)
    }
    const current = db.pragma('user_version', { simple: true }) as number
    if (current < MIGRATIONS.length) {
      // 全局数据库规范:结构迁移前先整库备份(拷贝为 <db>.bak-<日期>);
      // 损坏库走 openStore 的"备份重命名+重建"路径,不在此列。
      // 先把 WAL 落回主文件再拷贝,保证备份完整;备份失败向上抛,由 openStore 兜底重建。
      db.pragma('wal_checkpoint(TRUNCATE)')
      copyFileSync(dbPath, `${dbPath}.bak-${localDayOf(Date.now())}`)
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      const run = db.transaction(() => {
        MIGRATIONS[version](db)
        db.pragma(`user_version = ${version + 1}`)
      })
      run()
    }
  }

  close(): void {
    this.db.close()
  }

  // ---- TaskRepository ----

  putTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, agent_id, model_id, title, prompt, cwd, project_id, state, session_id, resume_latest, parent_id, error,
          attachments_json, skills_json, tool_policy_json, mode, origin, created_at, started_at, finished_at,
          retry_of, attempt, usage_json, order_index, reasoning_effort)
         VALUES (@id, @agentId, @modelId, @title, @prompt, @cwd, @projectId, @state, @sessionId, @resumeLatest, @parentId, @error,
          @attachmentsJson, @skillsJson, @toolPolicyJson, @mode, @origin, @createdAt, @startedAt, @finishedAt,
          @retryOf, @attempt, @usageJson, @orderIndex, @reasoningEffort)
         ON CONFLICT(id) DO UPDATE SET
           agent_id = excluded.agent_id, model_id = excluded.model_id, title = excluded.title,
           prompt = excluded.prompt, cwd = excluded.cwd, project_id = excluded.project_id,
           state = excluded.state, session_id = excluded.session_id, resume_latest = excluded.resume_latest,
           parent_id = excluded.parent_id, error = excluded.error, attachments_json = excluded.attachments_json,
           skills_json = excluded.skills_json, tool_policy_json = excluded.tool_policy_json, mode = excluded.mode,
           origin = excluded.origin, created_at = excluded.created_at, started_at = excluded.started_at,
           finished_at = excluded.finished_at, retry_of = excluded.retry_of, attempt = excluded.attempt,
           usage_json = excluded.usage_json,
           order_index = COALESCE(excluded.order_index, tasks.order_index),
           reasoning_effort = COALESCE(excluded.reasoning_effort, tasks.reasoning_effort)`,
      )
      .run(rowFromTask(task))
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined
    return row ? taskFromRow(row) : undefined
  }

  allTasks(): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at')
      .all() as TaskRow[]
    return rows.map(taskFromRow)
  }

  deleteTask(id: string): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM events WHERE task_id = ?').run(id)
    })
    run()
  }

  /**
   * 卡片归属变更(P0-2):换项目工作区;不支持"移出项目"语义。
   * 受影响分组的连续 orderIndex 由本方法在事务内重算,客户端不传全量数组。
   * 任务不存在返回 null。
   */
  moveTask(taskId: string, projectId: string): StoredTask | null {
    const run = this.db.transaction((): StoredTask | null => {
      const current = this.getTask(taskId)
      if (!current) return null
      const fromProject = current.projectId ?? null
      if (fromProject !== projectId) {
        this.db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(projectId, taskId)
        // 移出组剔除该任务后重赋连续值;移入组把任务追加到组尾(纯分组归属变更,不带插入锚点)
        if (fromProject !== null) this.normalizeGroupOrder(fromProject)
        this.normalizeGroupOrder(projectId, taskId)
      }
      return this.getTask(taskId) ?? null
    })
    return run()
  }

  /**
   * 组内相邻插入排序(P0-2):beforeTaskId 须与本任务同分组,否则抛错;
   * null/缺省 = 移到组尾;落位后本组 orderIndex 重赋连续值(0..n-1)。
   */
  reorderTask(taskId: string, beforeTaskId: string | null): StoredTask | null {
    const run = this.db.transaction((): StoredTask | null => {
      const current = this.getTask(taskId)
      if (!current) return null
      if (beforeTaskId === taskId) return this.getTask(taskId) ?? null
      if (beforeTaskId) {
        const anchor = this.getTask(beforeTaskId)
        if (!anchor || (anchor.projectId ?? null) !== (current.projectId ?? null)) {
          throw new Error('排序锚点不在同一分组')
        }
      }
      const ids = this.groupOrderIds(current.projectId ?? null).filter((id) => id !== taskId)
      const at = beforeTaskId ? Math.max(0, ids.indexOf(beforeTaskId)) : ids.length
      ids.splice(at, 0, taskId)
      this.writeGroupOrder(ids)
      return this.getTask(taskId) ?? null
    })
    return run()
  }

  /**
   * 读出某分组的任务 id 序列,基准与任务列表展示序一致(P0-2):
   * orderIndex 有值者按值升序在前(手动区),空缺者按 createdAt 倒序随后(兼容旧数据)。
   */
  private groupOrderIds(projectId: string | null): string[] {
    const rows = (
      projectId === null
        ? this.db
            .prepare(`SELECT id FROM tasks WHERE project_id IS NULL ${GROUP_ORDER_SQL}`)
            .all()
        : this.db
            .prepare(`SELECT id FROM tasks WHERE project_id = ? ${GROUP_ORDER_SQL}`)
            .all(projectId)
    ) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  /** 重赋某分组连续 orderIndex(0..n-1):appendTaskId 存在时先追加到组尾再整体编号 */
  private normalizeGroupOrder(projectId: string | null, appendTaskId?: string): void {
    const ids = this.groupOrderIds(projectId).filter((id) => id !== appendTaskId)
    if (appendTaskId !== undefined) ids.push(appendTaskId)
    this.writeGroupOrder(ids)
  }

  /** 事务内批量写回组内顺序;调用方保证 ids 与库内分组一致 */
  private writeGroupOrder(ids: string[]): void {
    const update = this.db.prepare('UPDATE tasks SET order_index = ? WHERE id = ?')
    ids.forEach((id, index) => update.run(index, id))
  }

  appendEvents(events: StoredEvent[]): void {
    if (events.length === 0) return
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO events (task_id, seq, kind, payload, at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const run = this.db.transaction((batch: StoredEvent[]) => {
      for (const { taskId, seq, at, event } of batch) {
        statement.run(taskId, seq, event.kind, JSON.stringify(event), at)
      }
    })
    run(events)
  }

  eventsOf(taskId: string): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq')
      .all(taskId) as EventRow[]
    return rows.map(eventFromRow)
  }

  /**
   * 事件分页(供 IPC 翻页):只取 beforeSeq 之前的最后 limit 条,按 seq 升序返回。
   * 避免为一个任务的上万条事件做全量读取 + JSON.parse。
   */
  eventsPageOf(taskId: string, beforeSeq: number | undefined, limit: number): StoredEvent[] {
    const rows = (beforeSeq === undefined
      ? this.db
          .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?')
          .all(taskId, limit)
      : this.db
          .prepare('SELECT * FROM events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
          .all(taskId, beforeSeq, limit)) as EventRow[]
    return rows.reverse().map(eventFromRow)
  }

  maxSeqOf(taskId: string): number {
    const result = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM events WHERE task_id = ?')
      .get(taskId) as { maxSeq: number | null }
    return result.maxSeq ?? 0
  }

  // ---- UsageLedger ----

  countOf(agentId: string, day: string): number {
    const row = this.db
      .prepare('SELECT task_count FROM usage WHERE agent_id = ? AND day = ?')
      .get(agentId, day) as { task_count: number } | undefined
    return row?.task_count ?? 0
  }

  charge(agentId: string, day: string): void {
    this.db
      .prepare(
        `INSERT INTO usage (agent_id, day, task_count) VALUES (?, ?, 1)
         ON CONFLICT(agent_id, day) DO UPDATE SET task_count = task_count + 1`,
      )
      .run(agentId, day)
  }

  refund(agentId: string, day: string): void {
    this.db
      .prepare(
        `INSERT INTO usage (agent_id, day, task_count) VALUES (?, ?, 0)
         ON CONFLICT(agent_id, day) DO UPDATE SET task_count = MAX(task_count - 1, 0)`,
      )
      .run(agentId, day)
  }

  usageOf(agentId: string, day: string): { taskCount: number; estimated: number } {
    const row = this.db
      .prepare('SELECT task_count, estimated FROM usage WHERE agent_id = ? AND day = ?')
      .get(agentId, day) as { task_count: number; estimated: number } | undefined
    return { taskCount: row?.task_count ?? 0, estimated: row?.estimated ?? 0 }
  }

  /** 周报/导出用:全量用量行 */
  allUsageRows(): Array<{ agentId: string; day: string; taskCount: number; estimated: number }> {
    const rows = this.db
      .prepare('SELECT agent_id, day, task_count, estimated FROM usage ORDER BY day DESC')
      .all() as Array<{ agent_id: string; day: string; task_count: number; estimated: number }>
    return rows.map((row) => ({
      agentId: row.agent_id,
      day: row.day,
      taskCount: row.task_count,
      estimated: row.estimated,
    }))
  }

  /**
   * 聚合客户端指定时间以来的消耗与缓存命中率
   */
  agentUsageStats(agentId: string, sinceMs: number): {
    usedTokens: number
    usedCredits: number
    cachedTokens: number
    cacheHitRate: number
  } {
    const rows = this.db
      .prepare(
        `SELECT usage_json FROM tasks WHERE agent_id = ? AND created_at >= ? AND usage_json IS NOT NULL`,
      )
      .all(agentId, sinceMs) as Array<{ usage_json: string }>

    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens = 0
    let credits = 0
    for (const r of rows) {
      try {
        const u = JSON.parse(r.usage_json) as TaskUsage
        inputTokens += u.inputTokens || 0
        outputTokens += u.outputTokens || 0
        cachedTokens += u.cachedTokens || 0
        credits += u.credits || 0
      } catch {
        // 忽略损坏的单条用量
      }
    }
    const totalTokens = inputTokens + outputTokens + cachedTokens
    const totalInput = inputTokens + cachedTokens
    const cacheHitRate = totalInput > 0 ? Number(((cachedTokens / totalInput) * 100).toFixed(1)) : 0
    return {
      usedTokens: totalTokens,
      usedCredits: Number(credits.toFixed(2)),
      cachedTokens,
      cacheHitRate,
    }
  }

  // ---- JournalStore ----

  append(entry: JournalEntry): void {
    this.db
      .prepare(
        `INSERT INTO journal (at, action, origin, agent_id, task_id, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.at,
        entry.action,
        entry.origin,
        entry.agentId ?? null,
        entry.taskId ?? null,
        entry.detail ?? null,
      )
  }

  journalTail(limit: number): JournalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM journal ORDER BY id DESC LIMIT ?')
      .all(limit) as JournalRow[]
    return rows.map((row) => ({
      at: row.at,
      action: row.action,
      origin: row.origin,
      agentId: row.agent_id ?? undefined,
      taskId: row.task_id ?? undefined,
      detail: row.detail ?? undefined,
    }))
  }

  // ---- WorkspaceStore ----

  put(row: WorkspaceRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workspaces
         (id, task_id, path, kind, source, status, created_at, cleanup_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.taskId,
        row.path,
        row.kind,
        row.source ?? null,
        row.status,
        row.createdAt,
        row.cleanupAfter ?? null,
      )
  }

  get(id: string): WorkspaceRow | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | WorkspaceSqlRow
      | undefined
    return row ? workspaceFromRow(row) : undefined
  }

  all(): WorkspaceRow[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY created_at')
      .all() as WorkspaceSqlRow[]
    return rows.map(workspaceFromRow)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  }

  // ---- projects(项目工作区)----

  upsertProject(project: Project): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, name, path, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(project.id, project.name, project.path, project.createdAt)
  }

  allProjects(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY created_at')
      .all() as ProjectSqlRow[]
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      createdAt: row.created_at,
    }))
  }

  renameProject(id: string, name: string): void {
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
  }

  /** 仅解除登记,不触碰磁盘;任务上的 project_id 保留(历史任务仍可追溯) */
  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  // ---- agents 持久化(重启恢复启用状态与最近探测信息)----

  upsertAgent(profile: {
    id: string
    label: string
    driver: string
    entry: string
    version?: string
    logoPath?: string
    plan: PlanInfo
    models: ModelPreset[]
    defaultModel: string
    enabled: boolean
    supportedVersions?: string
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agents
         (id, label, driver, entry, version, logo_path, plan_json, models_json,
          default_model, enabled, supported_versions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.label,
        profile.driver,
        profile.entry,
        profile.version ?? null,
        profile.logoPath ?? null,
        JSON.stringify(profile.plan),
        JSON.stringify(profile.models),
        profile.defaultModel,
        profile.enabled ? 1 : 0,
        profile.supportedVersions ?? null,
      )
  }

  allAgents(): Array<{
    id: string
    label: string
    driver: string
    entry: string
    version?: string
    logoPath?: string
    plan: PlanInfo
    models: ModelPreset[]
    defaultModel: string
    enabled: boolean
    supportedVersions?: string
  }> {
    const rows = this.db.prepare('SELECT * FROM agents').all() as AgentRow[]
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      driver: row.driver,
      entry: row.entry,
      version: row.version ?? undefined,
      logoPath: row.logo_path ?? undefined,
      plan: JSON.parse(row.plan_json) as PlanInfo,
      models: JSON.parse(row.models_json) as ModelPreset[],
      defaultModel: row.default_model,
      enabled: row.enabled === 1,
      supportedVersions: row.supported_versions ?? undefined,
    }))
  }

  // ---- 保留期清理(5.4)----

  /** 返回清理的任务数;running/interrupted 任务跳过,事件随任务一起清理 */
  purgeTasksBefore(cutoff: number): number {
    const run = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `DELETE FROM tasks
           WHERE finished_at IS NOT NULL AND finished_at < ?
             AND state NOT IN ('running', 'interrupted')`,
        )
        .run(cutoff)
      this.db
        .prepare('DELETE FROM events WHERE task_id NOT IN (SELECT id FROM tasks)')
        .run()
      return info.changes
    })
    return run() as number
  }

  purgeJournalBefore(cutoff: number): number {
    return this.db.prepare('DELETE FROM journal WHERE at < ?').run(cutoff)
      .changes as number
  }

  /** 设置页"导出数据(JSON)"直接复用此全量读取 */
  exportAll(): { tasks: TaskRecord[]; events: unknown[]; journal: JournalEntry[] } {
    return {
      tasks: this.allTasks(),
      events: this.db.prepare('SELECT * FROM events ORDER BY task_id, seq').all(),
      journal: this.journalTail(Number.MAX_SAFE_INTEGER),
    }
  }
}

/**
 * 打开存储;完整性/迁移失败 → 备份重命名后重建,
 * 返回的 recoveredFrom 供 UI 提示"数据已重建,备份在 <path>"。
 */
export function openStore(dbPath: string): {
  store: SqliteStore
  recoveredFrom?: string
} {
  try {
    return { store: new SqliteStore(dbPath) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const backup = `${dbPath}.bak-${Date.now()}`
    mkdirSync(dirname(dbPath), { recursive: true })
    try {
      renameSync(dbPath, backup)
    } catch {
      // 主库文件不存在(纯 wal 残留等)也照常重建
    }
    for (const suffix of ['-wal', '-shm']) {
      rmSync(dbPath + suffix, { force: true })
    }
    const store = new SqliteStore(dbPath)
    store.recoveredFrom = `${backup}(${reason})`
    return { store, recoveredFrom: store.recoveredFrom }
  }
}

interface TaskRow {
  id: string
  agent_id: string
  model_id: string
  title: string | null
  prompt: string
  cwd: string
  project_id: string | null
  state: TaskRecord['state']
  session_id: string | null
  resume_latest: number | null
  parent_id: string | null
  error: string | null
  attachments_json: string | null
  skills_json: string | null
  tool_policy_json: string | null
  mode: TaskRecord['mode']
  origin: TaskRecord['origin']
  created_at: number
  started_at: number | null
  finished_at: number | null
  retry_of: string | null
  attempt: number
  usage_json: string | null
  order_index: number | null
  reasoning_effort: string | null
}

interface EventRow {
  task_id: string
  seq: number
  kind: string
  payload: string
  at: number
}

interface JournalRow {
  id: number
  at: number
  action: string
  origin: string
  agent_id: string | null
  task_id: string | null
  detail: string | null
}

interface AgentRow {
  id: string
  label: string
  driver: string
  entry: string
  version: string | null
  logo_path: string | null
  plan_json: string
  models_json: string
  default_model: string
  enabled: number
  supported_versions: string | null
}

interface WorkspaceSqlRow {
  id: string
  task_id: string
  path: string
  kind: WorkspaceRow['kind']
  source: string | null
  status: WorkspaceRow['status']
  created_at: number
  cleanup_after: number | null
}

interface ProjectSqlRow {
  id: string
  name: string
  path: string | null
  created_at: number
}

function rowFromTask(task: TaskRecord) {
  return {
    id: task.id,
    agentId: task.agentId,
    modelId: task.modelId,
    title: task.title ?? null,
    prompt: task.prompt,
    cwd: task.cwd,
    projectId: task.projectId ?? null,
    state: task.state,
    sessionId: task.sessionId ?? null,
    resumeLatest: task.resumeLatest ? 1 : null,
    parentId: task.parentId ?? null,
    error: task.error ?? null,
    attachmentsJson: JSON.stringify(task.attachments ?? []),
    skillsJson: task.skills ? JSON.stringify(task.skills) : null,
    toolPolicyJson: task.toolPolicy ? JSON.stringify(task.toolPolicy) : null,
    mode: task.mode,
    origin: task.origin,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    retryOf: task.retryOf ?? null,
    attempt: task.attempt,
    usageJson: task.usage ? JSON.stringify(task.usage) : null,
    orderIndex: (task as StoredTask).orderIndex ?? null,
    reasoningEffort: task.reasoningEffort ?? null,
  }
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function taskFromRow(row: TaskRow): StoredTask {
  return {
    id: row.id,
    agentId: row.agent_id,
    modelId: row.model_id,
    title: row.title ?? undefined,
    prompt: row.prompt,
    cwd: row.cwd,
    projectId: row.project_id ?? undefined,
    state: row.state,
    sessionId: row.session_id ?? undefined,
    resumeLatest: row.resume_latest === 1 ? true : undefined,
    parentId: row.parent_id ?? undefined,
    error: row.error ?? undefined,
    attachments: safeJsonParse<TaskRecord['attachments']>(row.attachments_json, []),
    skills: safeJsonParse<string[] | undefined>(row.skills_json, undefined),
    toolPolicy: safeJsonParse<TaskRecord['toolPolicy'] | undefined>(row.tool_policy_json, undefined),
    mode: row.mode,
    origin: row.origin,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    retryOf: row.retry_of ?? undefined,
    attempt: row.attempt,
    usage: safeJsonParse<TaskUsage | undefined>(row.usage_json, undefined),
    orderIndex: row.order_index ?? undefined,
    reasoningEffort: (row.reasoning_effort ?? undefined) as TaskRecord['reasoningEffort'],
  }
}

function eventFromRow(row: EventRow): StoredEvent {
  return {
    taskId: row.task_id,
    seq: row.seq,
    at: row.at,
    event: safeJsonParse(row.payload, { kind: 'warning', text: '事件数据损坏' }),
  }
}

function workspaceFromRow(row: WorkspaceSqlRow): WorkspaceRow {
  return {
    id: row.id,
    taskId: row.task_id,
    path: row.path,
    kind: row.kind,
    source: row.source ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    cleanupAfter: row.cleanup_after ?? undefined,
  }
}

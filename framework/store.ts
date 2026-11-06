/**
 * s10 SQLite 持久化 + 嵌套事务：状态成为唯一真相，进程崩了、重启了，状态都在。
 * 真实版 src/app/store.ts：node:sqlite + SAVEPOINT 嵌套事务 + 生成列/部分索引（只扫活跃行）。
 */
import { DatabaseSync } from 'node:sqlite'
import type { Decision, Repositories, Thread, Ticket, Trigger, TriggerDisposition } from './engine.ts'

function read<T>(row: { value: string } | undefined): T | undefined {
  return row === undefined ? undefined : JSON.parse(row.value) as T
}

export class Store implements Repositories {
  db: DatabaseSync
  private depth = 0

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  close(): void { this.db.close() }

  /** SAVEPOINT 嵌套事务：可嵌套，出错只回滚到本层（对应真实 src/app/store.ts 的 atomic）。 */
  atomic<T>(work: () => T): T {
    const name = `sp_${this.depth++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try {
      const value = work()
      this.db.exec(`RELEASE ${name}`)
      this.depth--
      return value
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
      this.depth--
      throw error
    }
  }

  readonly triggers = {
    has: (id: string): boolean => !!this.db.prepare('SELECT 1 FROM trigger WHERE id=?').get(id),
    get: (id: string): Trigger | undefined => read<Trigger>(this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id) as { value: string } | undefined),
    set: (id: string, value: Trigger): void => {
      this.db.prepare('INSERT INTO trigger(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value))
    },
  }
  readonly dispositions = {
    get: (id: string): TriggerDisposition | undefined => read<TriggerDisposition>(this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id) as { value: string } | undefined),
    set: (id: string, value: TriggerDisposition): void => {
      this.db.prepare('INSERT INTO disposition(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value))
    },
  }
  readonly threads = {
    get: (key: string): Thread | undefined => read<Thread>(this.db.prepare('SELECT value FROM thread WHERE key=?').get(key) as { value: string } | undefined),
    set: (key: string, value: Thread): void => {
      this.db.prepare('INSERT INTO thread(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
    },
    list: (): Thread[] => (this.db.prepare('SELECT value FROM thread ORDER BY key').all() as { value: string }[]).map(row => JSON.parse(row.value) as Thread),
  }
  readonly decisions = {
    set: (id: string, value: Decision): void => {
      this.db.prepare('INSERT INTO decision(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value))
    },
  }
  readonly tickets = {
    get: (id: string): Ticket | undefined => read<Ticket>(this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id) as { value: string } | undefined),
    set: (id: string, value: Ticket): void => {
      this.db.prepare('INSERT INTO ticket(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value))
    },
  }
  /** 键值存储：来源读位等各部件自己的小状态（真实版 src/kv.ts + kv 表）。 */
  readonly kv = {
    get: (key: string): string | undefined => {
      const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined
      return row?.value
    },
    set: (key: string, value: string): void => {
      this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
    },
  }
}

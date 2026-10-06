/**
 * D1 兼容层：用 Node 内置的 `node:sqlite` 冒充 Cloudflare D1。
 *
 * 这一层存在的意义只有一个：**把"换平台"压缩成换一个文件**。
 *
 * 现状是：22 个处理器里到处直接写 `env.DB.prepare(sql).bind(...).first()/all()/run()`，
 * 也就是每个处理器都依赖 D1 的**接口形状**。要在自有服务器上跑，
 * 要么改遍所有处理器（风险大、还得重测），要么在下面垫一层一模一样的壳。
 * 这里选后者：只要这个壳的行为与 D1 一致，处理器一行都不用动。
 *
 * 实测过的 D1 语义（写这个壳时的唯一依据，也是测试断言的内容）：
 *   · `prepare(sql).bind(a, b)` 可链式，占位符是 `?`
 *   · `first()`  → **一行对象**；没有匹配行时返回 **null**（不是 undefined）
 *   · `all()`    → `{ results: [...] }`（处理器一律写 `const { results } = await …all()`）
 *   · `run()`    → `{ success: true, meta: { changes, last_row_id } }`
 *   · 表不存在时抛的错，message 里必须含 `no such table`
 *     —— `_lib/db.js` 的 `isMissingTable()` 就是按这句话判断的，
 *     换了驱动如果错误文案不同，"迁移没跑"就会被当成 500 甩给用户。
 *
 * ⚠️ 不要把它当成"另一个数据库"。它就是 SQLite，与 D1 同源（D1 本身也是 SQLite），
 *    所以迁移 SQL 可以原样执行；换成 Postgres/MySQL 才需要另写一个壳。
 *
 * 用法（本机或自有服务器）：
 *   import { createSqliteD1 } from './_lib/sqlite-driver.js';
 *   const env = { DB: createSqliteD1('./data/yczx.db') };
 *   // 之后把 env 交给任何 handlers 都能跑
 */
import { DatabaseSync } from 'node:sqlite';

/** 把 node:sqlite 抛出的错误改写成 D1 那种文案。 */
function normalizeError(err) {
  const msg = String((err && err.message) || err);
  // node:sqlite 说的是 "no such table: x"，与 D1 一致；
  // 但 UNIQUE 冲突的文案两边不同，这里统一成 D1 常见的写法，避免上层判断失配。
  if (/UNIQUE constraint failed/i.test(msg)) {
    const e = new Error(`UNIQUE constraint failed: ${msg.split(':').slice(1).join(':').trim()}`);
    e.cause = err;
    return e;
  }
  return err;
}

/**
 * 造一个 D1 形状的数据库对象。
 *
 * @param {string} file 数据库文件路径；默认 `:memory:`（进程结束即消失，适合测试）
 */
export function createSqliteD1(file = ':memory:') {
  const db = new DatabaseSync(file);

  // node:sqlite 默认不允许一条语句里带多条 SQL（exec 可以），
  // 所以 D1 的 prepare 语义在这里是一一对应的，不需要额外切分。

  const makeStmt = (sql, bound) => {
    /**
     * 执行并返回 node:sqlite 的原生结果。
     * 每次都重新 prepare：node:sqlite 的 StatementSync 可以复用，
     * 但 prepare 很便宜，而"复用 + 参数残留"是这类壳最容易出的隐蔽 bug。
     */
    const exec = (method, params) => {
      const stmt = db.prepare(String(sql));
      const args = params && params.length ? params : (bound || []);
      try {
        return stmt[method](...args);
      } catch (err) {
        throw normalizeError(err);
      }
    };

    return {
      bind(...params) {
        return makeStmt(sql, params);
      },
      /** 一行；没有则 null（D1 是 null，不是 undefined —— 这个差别会影响 `if (!row)` 之外的写法）。 */
      async first(column) {
        const row = exec('get', undefined);
        if (row === undefined) return null;
        if (column !== undefined) return row[column] === undefined ? null : row[column];
        return row;
      },
      /** `{ results: [...] }` —— 处理器一律解构 results。 */
      async all() {
        const results = exec('all', undefined) || [];
        return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
      },
      /** 写操作：受影响行数与自增主键都放进 meta（`_lib/db.js` 从这里读）。 */
      async run() {
        const info = exec('run', undefined) || {};
        const changes = Number(info.changes) || 0;
        const lastRowId = Number(info.lastInsertRowid) || 0;
        return {
          success: true,
          meta: { changes, last_row_id: lastRowId, duration: 0, rows_read: 0, rows_written: changes },
        };
      },
      /** 少数地方要用原始行数组（D1 的 raw()）；这里按数组返回。 */
      async raw() {
        const rows = exec('all', undefined) || [];
        return rows.map((r) => Object.values(r));
      },
    };
  };

  return {
    prepare(sql) {
      return makeStmt(sql);
    },

    /**
     * 顺序执行多条语句并返回各自的结果（D1 的 batch 是事务性的）。
     * 本项目的主力代码**刻意不用 batch**（见 auth.js 的注释：占位与计数必须分开判断），
     * 这里实现它只是为了接口完整 —— 万一将来有人用，行为要一致。
     */
    async batch(statements) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const stmt of statements) {
          out.push(await stmt.run());
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw normalizeError(err);
      }
      return out;
    },

    /** 执行一段可含多条语句的 SQL（迁移用），D1 的 exec 同样是多语句。 */
    async exec(sql) {
      db.exec(String(sql));
      return { count: 0, duration: 0 };
    },

    /** 暴露原生句柄，方便测试与运维脚本（D1 没有这一项，属于本层的额外能力）。 */
    _raw: db,
  };
}

export default createSqliteD1;

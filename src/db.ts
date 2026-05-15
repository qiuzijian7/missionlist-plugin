import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database, SqlJsStatic } from 'sql.js';

/** sql.js 单例，避免重复加载 WASM */
let sqlJsInstance: SqlJsStatic | null = null;
let sqlJsInitPromise: Promise<SqlJsStatic> | null = null;

/**
 * 获取 sql-wasm.js 的本地路径（从 out/sql-js/ 目录加载）
 */
function getSqlJsModulePath(): string {
    return path.join(__dirname, 'sql-js', 'sql-wasm.js');
}

/**
 * 获取 sql-wasm.wasm 的本地路径
 */
function getSqlWasmPath(): string {
    return path.join(__dirname, 'sql-js', 'sql-wasm.wasm');
}

async function getSqlJs(): Promise<SqlJsStatic> {
    if (sqlJsInstance) {
        return sqlJsInstance;
    }
    if (!sqlJsInitPromise) {
        const sqlJsModulePath = getSqlJsModulePath();
        const wasmPath = getSqlWasmPath();

        // 动态 require sql-wasm.js
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const initSqlJs: typeof import('sql.js').default = require(sqlJsModulePath);

        sqlJsInitPromise = initSqlJs({
            locateFile: (file: string) => {
                if (file.endsWith('.wasm')) {
                    return wasmPath;
                }
                return file;
            }
        }).then(SQL => {
            sqlJsInstance = SQL;
            return SQL;
        });
    }
    return sqlJsInitPromise;
}

export interface QueryResult {
    columns: string[];
    values: unknown[][];
}

/**
 * 使用 sql.js 查询 SQLite 数据库（无需 sqlite3 CLI）
 * @param dbPath 数据库文件路径
 * @param query SQL 查询语句
 * @returns 查询结果数组
 */
export async function querySqlite(dbPath: string, query: string): Promise<QueryResult[]> {
    if (!fs.existsSync(dbPath)) {
        return [];
    }

    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db: Database = new SQL.Database(fileBuffer);

    try {
        const result = db.exec(query);
        return result.map((r: { columns: string[]; values: unknown[][] }) => ({
            columns: r.columns,
            values: r.values
        }));
    } finally {
        db.close();
    }
}

/**
 * 使用 sql.js 执行 SQLite 写操作（UPDATE/INSERT/DELETE）
 * 执行后将修改写回磁盘
 * @param dbPath 数据库文件路径
 * @param query SQL 语句
 * @returns 是否成功
 */
export async function execSqlite(dbPath: string, query: string): Promise<boolean> {
    if (!fs.existsSync(dbPath)) {
        return false;
    }

    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db: Database = new SQL.Database(fileBuffer);

    try {
        db.run(query);
        // 将修改写回磁盘
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
        return true;
    } catch (e) {
        console.error('[DB] execSqlite failed:', e);
        return false;
    } finally {
        db.close();
    }
}

/** WorkBuddy 数据库默认路径 */
export function getWorkBuddyDbPath(): string {
    return path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
}

import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url || !url.startsWith("postgres")) {
  throw new Error("请设置 PostgreSQL DATABASE_URL。不会使用 SQLite。");
}
const client = new Client({ connectionString: url });
await client.connect();
await client.query("DROP SCHEMA public CASCADE");
await client.query("CREATE SCHEMA public");
await client.end();
console.log("已清空本地 PostgreSQL 示例库。下次启动会重新写入示例数据。");

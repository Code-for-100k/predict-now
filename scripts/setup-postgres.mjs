import pg from 'pg';
import fs from 'fs';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
console.log('Connected to Postgres');

const schema = fs.readFileSync('src/db/schema.sql', 'utf-8');
await client.query(schema);
console.log('Schema created');

const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
console.log('Tables:', tables.rows.map(r => r.tablename).join(', '));

const cb = await client.query("SELECT * FROM circuit_breaker");
console.log('Circuit breaker seeded:', cb.rows.length, 'rows');

await client.end();
console.log('Done');

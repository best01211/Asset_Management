import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { pgDump } from '@electric-sql/pglite-tools/pg_dump'

const owner = '12345678-0000-4000-8000-000000000001'
const other = '12345678-0000-4000-8000-000000000002'
const roles = 'create role anon nologin; create role authenticated nologin;'
const fixtureServices = `
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth to anon,authenticated;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select,insert on storage.objects to authenticated;
`

async function runSqlFiles(db, directory) {
  const folder = new URL('../' + directory + '/', import.meta.url)
  const names = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort()
  for (const name of names) {
    try {
      await db.exec(await readFile(new URL(name, folder), 'utf8'))
    } catch (error) {
      throw new Error(directory + '/' + name + ' failed: ' + error.message, { cause: error })
    }
  }
  return names.length
}

async function asUser(db, id) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
}

const source = await PGlite.create()
let restored
try {
  await source.exec(roles + fixtureServices)
  const migrationCount = await runSqlFiles(source, 'supabase/migrations')
  const testCount = await runSqlFiles(source, 'supabase/tests')
  await asUser(source, owner)
  const { rows: [seed] } = await source.query(`
    select public.create_krw_payment_account('Backup test bank','asset') as bank,
           public.create_krw_expense_category('Backup test meals') as category
  `)
  await source.query("select public.record_account_opening_balance($1,'25000','2024-01-01T00:00:00+09:00')", [seed.bank])
  const { rows: [{ draft }] } = await source.query(
    "select public.create_pending_expense('Backup purchase',4500,'2024-01-02T09:00:00+09:00','cash',$1,$2) as draft",
    [seed.bank, seed.category],
  )
  await source.query('select public.approve_pending_expense($1,1,gen_random_uuid())', [draft])
  await source.query("select public.save_monthly_financial_closing('2024-01-01',0)")
  const proofQuery = `select public.get_monthly_financial_closing('2024-01-01',1)->'saved'->'snapshot' as snapshot,
    (select count(*) from public.ledger_entries)::integer as ledger_entries,
    (select balance_minor from public.list_account_balances() where id=$1) as balance`
  const before = (await source.query(proofQuery, [seed.bank])).rows
  assert.equal(before[0].balance, '20500')
  await source.exec('reset role')
  const archive = await pgDump({ pg: source, args: ['--no-owner'] })
  const sql = (await archive.text()).replace(/^\\(?:un)?restrict [A-Za-z0-9]+\s*$/gm, '')
  restored = await PGlite.create()
  await restored.exec(roles)
  await restored.exec(sql)
  await restored.exec('set search_path to public; set row_security=on')
  await asUser(restored, owner)
  assert.deepEqual((await restored.query(proofQuery, [seed.bank])).rows, before)
  await asUser(restored, other)
  const { rows: [visibility] } = await restored.query(`
    select (select count(*) from public.transactions)::integer as transactions,
           (select count(*) from public.monthly_financial_closings)::integer as closings
  `)
  assert.deepEqual(visibility, { transactions: 0, closings: 0 })
  await restored.exec('reset role')
  console.log('Verified ' + migrationCount + ' migrations, ' + testCount + ' SQL tests, logical backup restore, and restored user isolation.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await restored?.close()
  await source.close()
}

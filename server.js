// server.js  — Postgres 版
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config(); // ローカル実行用（RenderではEnvironmentが使われる）

const app = express();
app.set('trust proxy', true); // 逆プロキシ（X-Forwarded-For）越しのIPを正しく取る

app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ----- Postgres 接続（Pool：接続プール） -----
const useExternal = process.env.DATABASE_SSL === 'true';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(useExternal ? { ssl: { rejectUnauthorized: false } } : {})
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      ip TEXT UNIQUE,                               -- 同一IPは1回のみ
      choice TEXT NOT NULL CHECK (choice IN ('agree','oppose')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('DB ready');
}
init().catch(err => {
  console.error('DB init error', err);
  process.exit(1);
});

function getClientIp(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (typeof xfwd === 'string' && xfwd.length > 0) return xfwd.split(',')[0].trim();
  return req.ip;
}

// トップ
app.get('/', (req, res) => res.render('index'));

// 投票
app.post('/vote', async (req, res) => {
  const choice = req.body.choice === 'agree' ? 'agree' : 'oppose';
  const ip = getClientIp(req);
  try {
    // 同じIPは最初の1回だけ記録（2回目以降は無視）
    await pool.query(
      `INSERT INTO votes (ip, choice) VALUES ($1, $2)
       ON CONFLICT (ip) DO NOTHING`,
      [ip, choice]
    );
  } catch (e) {
    console.error('vote error', e);
  }
  res.redirect('/thanks');
});

app.get('/thanks', (req, res) => res.render('thanks'));

// 管理画面
app.get('/admin', async (req, res) => {
  const key = req.query.key || '';
  if (key !== process.env.ADMIN_KEY) return res.status(401).send('Unauthorized');

  const stats = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE choice='agree')::int AS agree,
      COUNT(*) FILTER (WHERE choice='oppose')::int AS oppose
    FROM votes
  `);
  const { total, agree, oppose } = stats.rows[0];
  const p = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  const recent = await pool.query(
    `SELECT ip, choice, created_at
     FROM votes
     ORDER BY created_at DESC
     LIMIT 100`
  );

  res.render('admin', {
    total,
    agree,
    oppose,
    pAgree: p(agree, total),
    pOppose: p(oppose, total),
    rows: recent.rows
  });
});

// 便利：CSVエクスポート（バックアップ用）
app.get('/admin/export', async (req, res) => {
  const key = req.query.key || '';
  if (key !== process.env.ADMIN_KEY) return res.status(401).send('Unauthorized');

  const { rows } = await pool.query(
    `SELECT ip, choice, created_at
     FROM votes
     ORDER BY created_at DESC`
  );

  const header = 'ip,choice,created_at\n';
  const body = rows.map(r => `${r.ip},${r.choice},${r.created_at.toISOString()}`).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="votes.csv"');
  res.send(header + body);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on', port));


const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme123';

// trust proxy so req.ip works behind nginx/railway/vercel etc.
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const dbFile = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL UNIQUE,
    choice TEXT NOT NULL CHECK(choice IN ('agree','oppose')),
    ua TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Helper: count stats
function getStats(cb){
  db.all("SELECT choice, COUNT(*) as c FROM votes GROUP BY choice", (err, rows) => {
    if (err) return cb(err);
    const counts = { agree:0, oppose:0 };
    rows.forEach(r => counts[r.choice]=r.c);
    const total = counts.agree + counts.oppose;
    const pct = total ? {
      agree: Math.round((counts.agree/total)*1000)/10,
      oppose: Math.round((counts.oppose/total)*1000)/10
    } : {agree:0, oppose:0};
    cb(null, {counts, total, pct});
  });
}

app.get('/', (req,res) => {
  res.render('index');
});

app.post('/vote', (req,res) => {
  const choice = req.body.choice;
  if (!['agree','oppose'].includes(choice)) {
    return res.status(400).send('Invalid choice');
  }
  const ip = (req.ip || '').toString();
  const ua = req.get('user-agent') || '';

  // Try insert; if exists, redirect with already flag
  const stmt = db.prepare("INSERT INTO votes (ip, choice, ua) VALUES (?, ?, ?)");
  stmt.run(ip, choice, ua, function(err){
    if (err) {
      // likely unique constraint
      return res.redirect('/thanks?already=1');
    }
    return res.redirect('/thanks');
  });
});

app.get('/thanks', (req,res) => {
  res.render('thanks', { already: Boolean(req.query.already) });
});

// Admin dashboard (token in query or header). e.g., /admin?key=changeme123
app.get('/admin', (req,res) => {
  const key = req.query.key || req.get('x-admin-key');
  if (key !== ADMIN_KEY) {
    return res.status(401).send('Unauthorized. Provide ?key=YOUR_ADMIN_KEY');
  }
  getStats((err, stats) => {
    if (err) return res.status(500).send('DB error');
    // fetch last 20 for quick audit
    db.all("SELECT ip, choice, created_at FROM votes ORDER BY created_at DESC LIMIT 20", (e, rows) => {
      if (e) rows = [];
      res.render('admin', { stats, rows });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

'use strict';
const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { MongoClient } = require('mongodb');

const sections = {
  lgtc_rides: ['LGTC rides', ['reference', 'service_date', 'source_row']],
  drivers: ['Drivers', ['name', 'Driver Status']],
  vehicles: ['Vehicles', ['Vehicle Name', 'Make', 'Model', 'Vehicle Status']]
};

const digest = value => createHash('sha256').update(value).digest();
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
})[character]);

function ownerHandler(db, username, password) {
  const expected = digest('Basic ' + Buffer.from(username + ':' + password).toString('base64'));
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200); return res.end('OK');
    }
    if (!timingSafeEqual(digest(req.headers.authorization || ''), expected)) {
      res.writeHead(401, {'WWW-Authenticate':'Basic realm="EASYRIDE Owner", charset="UTF-8"'});
      return res.end('Owner sign-in required.');
    }
    if (req.method !== 'GET' || !['/', '/owner/', '/owner/records'].includes(url.pathname)) {
      res.writeHead(404); return res.end('Page not found.');
    }
    return renderOwnerRecords(db, url, res);
  };
}

async function renderOwnerRecords(db, url, res) {
    const selected = url.searchParams.get('show') || 'lgtc_rides';
    if (!Object.hasOwn(sections, selected)) {
      res.writeHead(404); return res.end('Record type not found.');
    }
    try {
      const [title, fields] = sections[selected];
      const projection = Object.fromEntries([['_id',0], ...fields.map(field=>[field,1])]);
      const [counts, records] = await Promise.all([
        Promise.all(Object.keys(sections).map(name=>db.collection(name).countDocuments())),
        db.collection(selected).find({}, {projection}).sort({[fields[0]]:1}).toArray()
      ]);
      const navigation = Object.entries(sections).map(([key,[label]], index)=>
        '<a href="?show='+key+'"'+(key===selected?' aria-current="page"':'')+'>'+label+' ('+counts[index]+')</a>').join('');
      const headers = fields.map(field=>'<th scope="col">'+escapeHtml(field.replaceAll('_',' '))+'</th>').join('');
      const rows = records.map(record=>'<tr>'+fields.map(field=>'<td>'+escapeHtml(record[field] ?? '—')+'</td>').join('')+'</tr>').join('');
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EASYRIDE Owner</title><style>
body{background:#0c1628;color:#edf4ff;font:16px system-ui;margin:0}main{max-width:1100px;margin:auto;padding:20px}
nav{display:flex;flex-wrap:wrap;gap:8px}a{color:#b0d6ff;border:1px solid #4c6a90;padding:10px 14px;border-radius:9px}
a[aria-current]{background:#1c5199;color:#fff}section{overflow:auto}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px;border-bottom:1px solid #31445e}th{text-transform:capitalize}
</style><main><h1>EASYRIDE Owner</h1><nav aria-label="MongoDB records">${navigation}</nav>
<h2>${title}</h2><section><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></section></main></html>`);
    } catch {
      res.writeHead(503); return res.end('MongoDB records are temporarily unavailable.');
    }
}

function start() {
  const { ROYALCAB_MONGO_URI:uri, ROYALCAB_OWNER_USERNAME:username, ROYALCAB_OWNER_PASSWORD:password } = process.env;
  if (!uri || !username || username.includes(':') || !password || password.length < 16) {
    throw Error('Set the MongoDB URI, Owner username, and an Owner password of at least 16 characters.');
  }
  const client = new MongoClient(uri,{serverSelectionTimeoutMS:5000});
  const handler = ownerHandler(client.db('royalcab_dispatch_test'),username,password);
  const server = http.createServer((req,res)=>handler(req,res).catch(()=>{
    res.writeHead(400); res.end('Invalid request.');
  }));
  server.listen(Number(process.env.PORT || 10000),'0.0.0.0',()=>console.log('EASYRIDE Owner listening'));
  process.once('SIGTERM',()=>server.close(()=>client.close()));
}

if (require.main === module) start();
module.exports = { ownerHandler, renderOwnerRecords };

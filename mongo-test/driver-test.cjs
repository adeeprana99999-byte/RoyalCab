'use strict';
const http = require('node:http');
const { MongoClient } = require('mongodb');
const { createApp } = require('../server.cjs');
const domain = require('../domain.cjs');
const LGTC = require('../lgtc.cjs');
const { plannerDemo } = require('./planner-demo.cjs');
const { startDispatch } = require('./planned-dispatch.cjs');
const { workbook } = require('../excel.cjs');

const roles = {owner:{role:'owner'}, driver:{role:'driver',driverId:'d1'}, james:{role:'driver',driverId:'d2'}};
const page = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RoyalCab MongoDB acceptance test</title><style>
body{font:16px system-ui;background:#081323;color:#eef5ff;margin:16px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}iframe{box-sizing:border-box;width:100%;height:78vh;border:1px solid #385477;border-radius:12px}button{padding:10px 16px;cursor:pointer}@media(max-width:760px){main{grid-template-columns:1fr}}
</style><h1>RoyalCab MongoDB acceptance test</h1><form action="/reset" method="post"><button>Reset both offers</button></form>
<p><a style="color:#9bd0ff" href="/owner/records">Owner fleet and LGTC records</a></p><p>Open Ride actions on both Driver panels, then click Accept trip on both.</p>
<main><iframe title="Owner" src="/owner/?acceptance=1"></iframe><iframe title="Maya Driver" src="/driver/"></iframe><iframe title="James Driver" src="/james/"></iframe></main></html>`;

async function main() {
  const uri = process.env.ROYALCAB_MONGO_URI;
  if (!uri) throw Error('Set ROYALCAB_MONGO_URI in this PowerShell window.');
  const port = Number(process.env.ROYALCAB_MONGO_TEST_PORT || 4783);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4781) throw Error('Choose a separate test port.');
  const client = new MongoClient(uri,{serverSelectionTimeoutMS:5000});
  let backend, server, dispatchRun, replayRevision = 0;
  try {
    await client.connect();
    const db = client.db('royalcab_dispatch_test');
    const rides = db.collection('full_screen_acceptance_tests');
    const now = Date.now();
    backend = createApp({dbPath:':memory:',automaticDispatch:false,clock:()=>now,async claimTestOffer(rideId,driverId){
      const result = await rides.updateOne({_id:rideId,status:'offered',driverId:null,eligibleDrivers:driverId},
        {$set:{status:'accepted',driverId,acceptedAt:new Date()}});
      if (!result.modifiedCount) throw Object.assign(Error('This ride was already taken.'),{status:409});
    }});
    await listen(backend.server,0);
    const base = 'http://127.0.0.1:'+backend.server.address().port;
    const sessions = {};
    for (const [key,role] of Object.entries(roles)) {
      const response = await fetch(base+'/api/demo-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(role)});
      if (!response.ok) throw Error('Could not sign in to the test workspace.');
      sessions[key] = response.headers.get('set-cookie').split(';')[0];
    }

    async function reset() {
      const state = domain.seed(now);
      const ride = state.trips[0];
      Object.assign(ride,{reference:'MONGO-ACCEPT-TEST',customerName:'Acceptance Test Rider',pickupAt:now+60000});
      const pickup = domain.places.find(place=>place.name===ride.pickup);
      state.trips = [ride];
      state.drivers = state.drivers.slice(0,2);
      for (const driver of state.drivers) Object.assign(driver,{lat:pickup.lat,lng:pickup.lng});
      domain.offer(state,ride,'Owner test',now,{mode:'urgent_group',limit:2});
      if (state.offers.length !== 2) throw Error('Both test offers are required.');
      await rides.insertOne({_id:ride.id,status:'offered',driverId:null,eligibleDrivers:state.drivers.map(driver=>driver.id)});
      backend.mutate(current=>Object.assign(current,{trips:state.trips,drivers:state.drivers,offers:state.offers,events:state.events,notifications:state.notifications}));
      backend.publish();
    }

    await reset();
    server = http.createServer(async (req,res)=>{
      try {
        const url = new URL(req.url,'http://127.0.0.1');
        if (req.method==='GET' && url.pathname==='/') {
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
          return res.end(page);
        }
        const recordDetails = req.method === 'GET' && url.pathname === '/owner/api/fleet-record';
        const recordStatus = req.method === 'POST' && url.pathname === '/owner/api/fleet-record/status';
        if (recordDetails || recordStatus) {
          const reply = (status, data) => {
            res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
            return res.end(JSON.stringify(data));
          };
          let input;
          if (recordStatus) {
            if (req.headers.origin !== 'http://' + req.headers.host ||
                req.headers['content-type']?.split(';')[0] !== 'application/json') {
              return reply(403,{error:'Open Owner to change fleet status.'});
            }
            let body = '';
            for await (const chunk of req) {
              body += chunk.toString();
              if (body.length > 4096) return reply(413,{error:'Request too large.'});
            }
            try { input = JSON.parse(body); } catch { return reply(400,{error:'Invalid fleet status request.'}); }
          } else {
            input = Object.fromEntries(url.searchParams);
          }
          const {kind,key,disabled} = input || {};
          if (!['vehicle','driver'].includes(kind) || typeof key !== 'string' || !key ||
              (recordStatus && typeof disabled !== 'boolean')) {
            return reply(400,{error:'Choose a fleet record and status.'});
          }
          const collection = db.collection(kind === 'vehicle' ? 'vehicles' : 'drivers');
          if (recordDetails) {
            const record = await collection.findOne({_id:key},{projection:{_id:1}});
            return record ? reply(200,{files:{}}) : reply(404,{error:'Fleet record not found.'});
          }
          const status = disabled ? 'Disabled' : 'Enabled';
          const statusField = kind === 'vehicle' ? 'Vehicle Status' : 'Driver Status';
          const disabledField = kind === 'vehicle' ? 'vehicleDisabled' : 'driverDisabled';
          const result = await collection.updateOne({_id:key},{$set:{[statusField]:status,[disabledField]:disabled}});
          return result.matchedCount ? reply(200,{status}) : reply(404,{error:'Fleet record not found.'});
        }
        if (url.pathname === '/owner/api/fleet-import') {
          res.setHeader('Content-Type','application/json; charset=utf-8');
          res.setHeader('Cache-Control','no-store');
          if (req.method !== 'GET') {
            res.writeHead(405);
            return res.end(JSON.stringify({error:'MongoDB fleet records are read-only in this view.'}));
          }
          const groups = [['vehicle','vehicles'], ['driver','drivers']];
          const list = url.searchParams.get('list') === '1';
          const data = await Promise.all(groups.map(async ([kind,name]) => {
            const collection = db.collection(name);
            if (!list) return {kind,total:await collection.countDocuments()};
            const fields = kind === 'vehicle'
              ? ['Vehicle Name','Year','Make','Model','Vehicle Status','Last Known Driver','Vehicle Identification Number (VIN)']
              : ['name','Driver Status'];
            const projection = Object.fromEntries([['_id',1], ...fields.map(field=>[field,1])]);
            const records = (await collection.find({}, {projection}).sort({[fields[0]]:1}).toArray())
              .map(({_id,...row})=>({...row,kind,recordKey:_id}));
            return {kind,total:records.length,records};
          }));
          return res.end(JSON.stringify({
            counts:data.map(({kind,total})=>({kind,total})),
            records:list ? data.flatMap(group=>group.records) : undefined,
            setupReadOnly:true
          }));
        }
        if (req.method === 'POST' && url.pathname === '/owner/enable-fleet') {
          if (req.headers.origin !== 'http://' + req.headers.host) {
            res.writeHead(403); return res.end('Open the Owner day plan to enable the test fleet.');
          }
          await Promise.all([
            db.collection('drivers').updateMany({}, {$set:{'Driver Status':'Enabled',driverDisabled:false}}),
            db.collection('vehicles').updateMany({}, {$set:{'Vehicle Status':'Enabled',vehicleDisabled:false}})
          ]);
                    if (url.searchParams.get('plan') === 'test') {
            await db.collection('planner_settings').updateOne({_id:'owner-day-plan'},{
              $set:{mode:'full-fleet-test',updatedAt:new Date()}
            },{upsert:true});
          }
          res.writeHead(303,{Location:url.searchParams.get('plan') === 'test'
            ? '/owner/day-plan?view=workbench' : '/owner/day-plan?fleet=enabled'});
          return res.end();
        }
        if (req.method === 'GET' && url.pathname === '/owner/planner-demo') {
          const scenario = url.searchParams.get('scenario') || 'baseline';
          const plan = plannerDemo(scenario);
          const assignments = plan.runs.map(run =>
            '<h3>' + escapeHtml(run.label) + '</h3><ul>' + run.trips.map(ride =>
              '<li>' + escapeHtml(ride.reference + (ride.assignment ? ' · ' + ride.assignment : '')) + '</li>').join('') + '</ul>').join('');
          const review = plan.unplanned.map(ride =>
            '<li>' + escapeHtml(ride.reference + ' · ' + ride.reasons.join(', ')) + '</li>').join('');
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
          return res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owner · Three-ride planner test</title><style>
body{background:#081323;color:#eef5ff;font:17px system-ui;max-width:850px;margin:24px auto;padding:0 16px}
a{color:#9bd0ff}nav{display:flex;gap:14px;flex-wrap:wrap}nav a{padding:10px;border:1px solid #385477;border-radius:8px}nav a[aria-current]{background:#174a87}
</style><a href="/owner/day-plan">MongoDB day plan</a><h1>Three-ride planner test</h1>
<p>Dummy ride and fleet records. Each choice reruns the local day planner.</p>
<nav aria-label="Test scenario">${[['baseline','Start test'],['disabled','Disable James’s accessible van'],['confirmed','Enable van and confirm 10:00 AM pickup']].map(([key,label])=>'<a href="?scenario='+key+'"'+(key===scenario?' aria-current="page"':'')+'>'+label+'</a>').join('')}</nav>
<p>${plan.allocated} assigned · ${plan.unplanned.length} need review · ${plan.count} total rides</p>
<h2>Assignments by driver</h2>${assignments}
<h2>Owner review</h2>${review ? '<ul>'+review+'</ul>' : '<p>No rides need review.</p>'}</html>`);
        }
        if (req.method === 'GET' && url.pathname === '/owner/api/state' && url.searchParams.get('dashboard') === '1') {
          const upstream = await fetch(base+'/api/state',{headers:{Cookie:sessions.owner}});
          const snapshot = await upstream.json();
          if (upstream.ok && dispatchRun) {
            const replay = dispatchRun.state;
            const runId = 'mongo-lgtc-replay';
            const [pickup,dropoff] = domain.places;
            snapshot.state.drivers.push(...replay.drivers.map((driver,index)=>{
              const trip = replay.trips.find(ride=>ride.driverId===driver.id && ride.status==='onboard');
              const fraction = trip ? Math.min(1,Math.max(0,
                (dispatchRun.at-trip.pickupAt)/Math.max(1,trip.plannedEndAt-trip.pickupAt))) : 0;
              const angle = index * 2.399963;
              return {...driver,demoRunId:runId,
                lat:pickup.lat + (dropoff.lat-pickup.lat)*fraction + Math.cos(angle)*0.0015,
                lng:pickup.lng + (dropoff.lng-pickup.lng)*fraction + Math.sin(angle)*0.0015};
            }));
            snapshot.state.trips.push(...replay.trips.map(ride=>({...ride,demoRunId:runId})));
            snapshot.state.offers.push(...replay.offers);
            snapshot.state.events.push(...replay.events);
            snapshot.state.lgtcReplay = {runId,at:dispatchRun.at,held:dispatchRun.held,
              running:!!dispatchRun.remaining && !dispatchRun.error,error:dispatchRun.error};
            snapshot.state.revision += replayRevision + replay.trips.length * 6 - dispatchRun.remaining;
          }
          res.writeHead(upstream.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
          return res.end(JSON.stringify(snapshot));
        }
        if (req.method === 'GET' && url.pathname === '/owner/dispatch-progress') {
          if (!dispatchRun) {
            res.writeHead(303,{Location:'/owner/day-plan?view=workbench'}); return res.end();
          }
          const {state,remaining,error} = dispatchRun;
          const offers = new Map(state.offers.map(offer=>[offer.tripId,offer]));
          const names = new Map(state.drivers.map(driver=>[driver.id,driver.name]));
          const counts = state.trips.reduce((totals,ride)=>{
            totals[ride.status]=(totals[ride.status]||0)+1;
            return totals;
          },{});
          const rows = state.trips.slice().sort((a,b)=>a.pickupAt-b.pickupAt).map(ride=>{
            const offer = offers.get(ride.id);
            const status = ride.status === 'awaiting_driver' ? 'Scheduled' : ride.status.replaceAll('_',' ');
            return '<tr><td>'+escapeHtml(ride.reference)+'</td><td>'+
              escapeHtml(names.get(offer?.driverId || ride.plannedDriverId))+'</td><td>'+escapeHtml(status)+'</td></tr>';
          }).join('');
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
          return res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owner · LGTC dispatch progress</title>${remaining && !error ? '<meta http-equiv="refresh" content="2">' : ''}
<style>body{font:16px system-ui;background:#081323;color:#eef5ff;margin:20px}a{color:#9bd0ff}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #385477;padding:8px}</style>
<a href="/owner/day-plan?view=workbench">Back to day plan</a><h1>LGTC dispatch progress</h1>
<p>Local test with simulated driver responses and stops.</p>
<p>${state.trips.length} planned · ${counts.offered||0} offers pending · ${counts.completed||0} completed · ${dispatchRun.held} remain in Owner review</p>
<p role="status">${error ? escapeHtml(error) : remaining ? 'Dispatch running' : 'Dispatch complete'}</p>
<table><thead><tr><th>Ride</th><th>Driver</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></html>`);
        }
        const startPlannedDispatch = req.method === 'POST' && url.pathname === '/owner/dispatch-plan';
        if (startPlannedDispatch && req.headers.origin !== 'http://' + req.headers.host) {
          res.writeHead(403); return res.end('Open Owner Route Workbench to run dispatch.');
        }
        if (startPlannedDispatch || (req.method === 'GET' && url.pathname === '/owner/day-plan')) {
          const serviceDate = '2026-11-03';
          const [source, drivers, vehicles] = await Promise.all([
            db.collection('lgtc_rides').find({service_date: serviceDate}).sort({source_row: 1}).toArray(),
            db.collection('drivers').find({}).toArray(),
            db.collection('vehicles').find({}).toArray()
          ]);
          const vehicleById = new Map(vehicles.map(vehicle => [vehicle._id, vehicle]));
          const candidates = drivers.flatMap(driver => {
            const vehicle = vehicleById.get(driver.vehicleId);
            if (driver.rosterVerified !== true || driver.driverDisabled || driver['Driver Status'] === 'Disabled' || !vehicle ||
                vehicle['Vehicle Status'] !== 'Enabled' || vehicle.vehicleDisabled ||
                ![4, 7].includes(vehicle.seats) || typeof vehicle.wheelchairAccessible !== 'boolean') return [];
            const entry = { ...driver, id:driver._id, vehicle:vehicle['Vehicle Name'], seats:vehicle.seats,
              capabilities:vehicle.wheelchairAccessible ? ['wheelchair'] : [], rosterManaged:true };
            const shift = LGTC.driverShift(entry,serviceDate);
            return shift && !shift.unavailable ? [entry] : [];
          });
          const embedded = startPlannedDispatch || url.searchParams.get('view') === 'workbench';
                    const savedPlan = embedded ? await db.collection('planner_settings').findOne({_id:'owner-day-plan'}) : null;
          const fullFleet = savedPlan?.mode === 'full-fleet-test' ||
            (!embedded && url.searchParams.get('mode') === 'full-fleet-test');
          const enabledVehicles = vehicles.filter(vehicle => vehicle['Vehicle Status'] === 'Enabled' && !vehicle.vehicleDisabled);
          const verifiedRoster = candidates.filter(driver => candidates.filter(other => other.vehicleId === driver.vehicleId).length === 1);
          const roster = fullFleet ? drivers.filter(driver => driver['Driver Status'] === 'Enabled' && !driver.driverDisabled)
            .sort((a,b)=>a.name.localeCompare(b.name)).slice(0,enabledVehicles.length).map((driver,index)=>{
              const vehicle = enabledVehicles[index];
              return {id:driver._id,name:driver.name,vehicleId:vehicle._id,vehicle:vehicle['Vehicle Name'],
                seats:vehicle.seats ?? 4,capabilities:vehicle.wheelchairAccessible === true ? ['wheelchair'] : [],
                recurringShift:{days:[2],start:0,end:1439},rosterManaged:true};
            }) : verifiedRoster;
          const file = workbook(source.map(row => row.details.sourceFields));
          const batch = LGTC.detect('LGTC_MongoDB.xlsx',file.toString('base64'));
          if (!batch || batch.rows.length !== source.length) throw Error('LGTC source rows could not be reconstructed.');
          const profiles = fullFleet ? {A:{mode:'standard',base:1,extras:[]},W:{mode:'accessible',base:1,extras:[]}} : undefined;
          const plan = LGTC.plan(batch,{serviceDate,buffer:30,profiles,driverIds:roster.map(driver => driver.id)},
            {roster,allowEmptyRoster:true});
          if (startPlannedDispatch) {
            if (!fullFleet || !plan.allocated) {
              res.writeHead(409); return res.end('Run a full-fleet test plan with assigned rides first.');
            }
            if (!dispatchRun || dispatchRun.error || !dispatchRun.remaining) {
              replayRevision += 10000;
              dispatchRun=startDispatch(plan);
              dispatchRun.held=plan.unplanned.length;
            }
            if (url.searchParams.get('view') === 'dashboard') {
              res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
              return res.end(JSON.stringify({ok:true}));
            }
            res.writeHead(303,{Location:'/owner/dispatch-progress'});
            return res.end();
          }
          const runRows = plan.runs.map(run => '<li>' + escapeHtml(run.label) + ' · ' +
            escapeHtml(run.vehicle || 'Vehicle') + '<ul>' + run.trips.map(ride =>
              '<li>' + escapeHtml(ride.reference) + '</li>').join('') + '</ul></li>').join('');
          const reviewRows = plan.unplanned.map(ride => '<tr><td>' + escapeHtml(ride.reference) + '</td><td>' +
            escapeHtml(ride.reasons.join(', ')) + '</td></tr>').join('');
          res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
          return res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owner · LGTC day plan</title><style>
body{font:16px system-ui;background:#081323;color:#eef5ff;margin:20px}a{color:#9bd0ff}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #385477}
</style><a href="/owner/records">MongoDB records</a><h1>LGTC day plan</h1>${embedded ? '' : '<p><a href="/owner/day-plan?mode=full-fleet-test">Run full-fleet test</a> · <a href="/owner/day-plan">Verified roster</a></p>'}${fullFleet ? '<p role="status">Test only. Enabled drivers are paired with distinct enabled vehicles for the full day. Unconfirmed seats default to four, and only explicitly accessible vehicles can take wheelchair rides. Codes A and W assume one occupied seat. Missing times and unresolved instructions remain in review.</p>' : ''}${embedded ? '' : '<p><a href="/owner/planner-demo">Run three-ride planner test</a></p>'}
<p>${serviceDate} · ${plan.count} rides · ${roster.length} eligible drivers · ${plan.allocated} assigned · ${plan.unplanned.length} need owner review</p>
${embedded ? '' : '<form method="post" action="/owner/enable-fleet"><button type="submit">Enable all MongoDB test drivers and vehicles</button></form>'}
<p>${drivers.filter(driver => driver['Driver Status'] === 'Enabled' && !driver.driverDisabled).length} of ${drivers.length} drivers enabled · ${vehicles.filter(vehicle => vehicle['Vehicle Status'] === 'Enabled' && !vehicle.vehicleDisabled).length} of ${vehicles.length} vehicles enabled</p>
${embedded ? '<form method="post" action="/owner/enable-fleet?plan=test"><button type="submit">Enable fleet and run with test assumptions</button></form>' : ''}
${embedded && fullFleet && plan.allocated ? '<form method="post" action="/owner/dispatch-plan"><button type="submit">Start local dispatch for '+plan.allocated+' assigned rides</button></form>' : ''}
<h2>Assignments by driver</h2>${runRows ? '<ul>'+runRows+'</ul>' : '<p>No verified driver–vehicle pairs with a shift for this date.</p>'}
<h2>Owner review</h2><table><thead><tr><th>Ride</th><th>Reason</th></tr></thead><tbody>${reviewRows}</tbody></table></html>`);
        }
        if (req.method === 'GET' && url.pathname === '/owner/records') {
          const sections = {
            vehicles: ['Vehicles', ['Vehicle Name', 'Make', 'Model', 'Vehicle Status']],
            drivers: ['Drivers', ['name']],
            lgtc_rides: ['LGTC rides', ['reference', 'service_date', 'source_row']]
          };
          const selected = url.searchParams.get('show') || 'vehicles';
          if (!Object.hasOwn(sections, selected)) { res.writeHead(404); return res.end(); }
          const [title, fields] = sections[selected];
          const counts = await Promise.all(Object.keys(sections).map(name => db.collection(name).countDocuments()));
          const records = await db.collection(selected).find({}, {
            projection: Object.fromEntries([['_id', 0], ...fields.map(field => [field, 1])])
          }).sort({[fields[0]]: 1}).toArray();
          const links = Object.keys(sections).map((name, index) =>
            '<a href="?show=' + name + '"' + (name === selected ? ' aria-current="page"' : '') + '>' +
            sections[name][0] + ' (' + counts[index] + ')</a>').join('');
          const headings = fields.map(field => '<th scope="col">' + escapeHtml(field.replaceAll('_', ' ')) + '</th>').join('');
          const rows = records.map(record => '<tr>' + fields.map(field =>
            '<td>' + escapeHtml(record[field] ?? '—') + '</td>').join('') + '</tr>').join('');
          res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
          return res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owner · MongoDB records</title><style>
body{font:16px system-ui;background:#081323;color:#eef5ff;margin:20px}a{color:#9bd0ff}nav{display:flex;flex-wrap:wrap;gap:12px}
nav a{padding:10px 14px;border:1px solid #385477;border-radius:8px}nav a[aria-current]{background:#174a87}
section{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #385477}th{text-transform:capitalize}
</style><a href="/">Back to acceptance test</a><h1>Owner · MongoDB records</h1><p><a href="/owner/day-plan">Run LGTC day planner</a></p>
<nav aria-label="Record type">${links}</nav><h2>${title}</h2><section><table><thead><tr>${headings}</tr></thead>
<tbody>${rows || '<tr><td colspan="' + fields.length + '">No records found.</td></tr>'}</tbody></table></section></html>`);
        }
        if (req.method==='POST' && url.pathname==='/reset') {
          if (req.headers.origin && req.headers.origin!=='http://'+req.headers.host) {
            res.writeHead(403); return res.end();
          }
          await reset();
          res.writeHead(303,{Location:'/'}); return res.end();
        }
        const ref = req.headers.referer && new URL(req.headers.referer).pathname.split('/')[1];
        const prefixed = /^\/(owner|driver|james)(\/.*)$/.exec(url.pathname);
        const role = prefixed?.[1] || ref;
        if (!Object.hasOwn(roles,role)) {res.writeHead(404);return res.end();}
        const route = (prefixed?.[2] || url.pathname)+url.search;
        const headers = {...req.headers,host:new URL(base).host,cookie:sessions[role]};
        if (headers.origin==='http://'+req.headers.host) headers.origin=base;
        const upstream = http.request(base+route,{method:req.method,headers},response=>{
          delete response.headers['set-cookie'];
          if (route==='/') {
            delete response.headers['x-frame-options'];
            if (response.headers['content-security-policy']) response.headers['content-security-policy']=response.headers['content-security-policy'].replace("frame-ancestors 'none'","frame-ancestors 'self'");
          }
          res.writeHead(response.statusCode,response.headers);
          response.pipe(res);
        });
        upstream.on('error',()=>{if (!res.headersSent) res.writeHead(502);res.end();});
        res.on('close',()=>upstream.destroy());
        req.pipe(upstream);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end('Could not complete the MongoDB test request.');
      }
    });
    await listen(server,port);
    console.log('Full RoyalCab MongoDB acceptance test ready at http://127.0.0.1:'+port+'/');
  } catch (error) {
    backend?.close();
    server?.close();
    await client.close();
    throw error;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[char]);
}

function listen(server,port) {
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,'127.0.0.1',resolve);
  });
}
main().catch(error=>{
  console.error('Could not start the RoyalCab MongoDB test: '+(error.code || error.name==='MongoServerSelectionError' ? error.code || error.name : error.message));
  process.exitCode=1;
});

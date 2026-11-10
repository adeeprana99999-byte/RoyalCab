const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createApp } = require('./server.cjs');
const D = require('./domain.cjs');
test('confirmed pickup monitoring uses fresh road ETAs and stops at arrival', async () => {
  const now=Date.now(), stop={name:'Verified Stop',lat:35.21,lng:-80.81};
  const driver={id:'gps',status:'busy',locationSource:'device',trackingEnabled:true,locationAccuracy:8,
    lastLocationAt:now,lat:35.22,lng:-80.82};
  const trip={id:'ride',driverId:driver.id,pickup:stop.name,pickupAt:now+120000,status:'heading_to_pickup'};
  const routing=require('./road-routing.cjs').createRoadRouting(async()=>[{condition:'ROUTE_EXISTS',duration:'300s'}]);
  await routing.monitorPickups({drivers:[driver],trips:[trip]},[stop],()=>now);
  const fresh=routing.pickupForecast(trip,driver,stop,now+1000);
  assert.equal(fresh.arrivalAt,now+300000);
  assert.equal(fresh.lateMinutes,3);
  assert.equal(routing.pickupForecast(trip,driver,stop,now+30000).status,'eta_unavailable');
  assert.equal(routing.pickupForecast(trip,{...driver,trackingEnabled:false},stop,now).status,'gps_unavailable');
  assert.equal(routing.pickupForecast({...trip,status:'arrived'},driver,stop,now),null);
  assert.match(require('./public/board.js').attentionReason({...trip,pickupForecast:fresh},now),/3 min late/);
  assert.equal(require('./public/board.js').attentionReason({...trip,pickupForecast:fresh},now+30000),'');
});

test('owner can withdraw a confirmed driver before pickup, but cannot withdraw an onboard ride or stale assignment', () => {
  const now=Date.now(),s=testState(now),trip=s.trips[0],owner={role:'owner',name:'Fleet owner'};
  const offer=D.offer(s,trip,owner.name,now);
  const driver=s.drivers.find(d=>d.id===offer.driverId);
  D.action(s,trip,'accept',{role:'driver',driverId:driver.id,name:driver.name},{offerId:offer.id},now);
  const body={driverId:driver.id,reason:'Driver unreachable'};
  assert.throws(()=>D.action(s,trip,'release',owner,{...body,driverId:'changed'},now),/assignment has changed/);
  assert.throws(()=>D.action(s,{...trip,status:'onboard'},'release',owner,body,now),/onboard/);
  assert.throws(()=>D.action(s,{...trip,isSharedRun:true,collectedStops:1},'release',owner,body,now),/onboard/);
  D.action(s,trip,'release',owner,body,now);
  assert.equal(trip.status,'needs_reassignment');
  assert.equal(trip.driverId,null);
  assert.equal(trip.redFlag,true);
  assert.equal(driver.status,'offline');
  assert.equal(driver.trackingEnabled,false);
  assert.ok(trip.droppedDrivers.includes(driver.id));
  assert.equal(s.assignmentHistory[0].outcome,'released');
});
test('road pilot restart preserves an active assignment and requires fresh GPS from every driver', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prolift-restart-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.now(), profile={name:'Test driver',phone:'+12025550109',vehicle:'Test car',seats:4,capabilities:[]};
  const stop={address:'1 Test Street',city:'Charlotte',state:'NC',zip:'28202',lat:35.22,lng:-80.82};
  const pilotConfig={ownerCode:'owner-restart-test-only',drivers:[
    {...profile,id:'assigned',plate:'TEST A',code:'assigned-restart-test-only'},
    {...profile,id:'available',plate:'TEST B',code:'available-restart-test-only'}
  ],verifiedStops:[{...stop,name:'Restart pickup'},{...stop,name:'Restart dropoff',address:'2 Test Street',lat:35.23}]};
  const options={dbPath:path.join(dir,'pilot.sqlite'),automaticDispatch:false,clock:()=>now,pilotConfig,roadMatrix:async()=>[]};
  let app=createApp(options);
  try {
    app.mutate(state=>{
      state.trips=[{...D.seed(now).trips[0],status:'accepted',driverId:'assigned'}];
      for(const driver of state.drivers) Object.assign(driver,{status:driver.id==='assigned'?'busy':'online',trackingEnabled:true,lastLocationAt:now,locationAccuracy:8,lat:35.22,lng:-80.82});
    });
  } finally {app.close();}
  app=createApp(options);
  try {
    const state=app.load();
    assert.equal(state.trips[0].driverId,'assigned');
    assert.deepEqual(state.drivers.map(d=>[d.status,d.trackingEnabled]),[['busy',false],['offline',false]]);
    assert.ok(state.drivers.every(d=>!require('./road-routing.cjs').deviceReady(d,now)));
  } finally {app.close();}
});
test('road ETA cache fails closed on outages and invalidates moved or stopped devices', async () => {
  const Road = require('./road-routing.cjs');
  let now = Date.now(), providerDown = true;
  const stop = {name:'Pickup',lat:35.2,lng:-80.8};
  const device = {id:'gps',locationSource:'device',trackingEnabled:true,locationAccuracy:8,
    lastLocationAt:now,status:'online',lat:35.21,lng:-80.81};
  const s={drivers:[device]}, trips=[{pickup:stop.name}];
  const routing=Road.createRoadRouting(async()=>{
    if(providerDown) throw Error('Service unavailable');
    return [{condition:'ROUTE_EXISTS',duration:'61.5s'}];
  });
  await routing.prepare(s,trips,[stop],()=>now);
  assert.equal(routing.health().status,'blocked');
  assert.equal(routing.get(device,stop,now),null);
  providerDown=false;now+=10001;
  await routing.prepare(s,trips,[stop],()=>now);
  assert.equal(routing.get(device,stop,now).minutes,2);
  assert.equal(routing.get({...device,lat:35.22},stop,now),null);
  assert.equal(routing.get({...device,trackingEnabled:false},stop,now),null);
  assert.equal(routing.get(device,stop,now+30000),null);
});
function testState(now){return D.seed(now,{dispatchLeadMinutes:90});}
const { workbook, parseFile } = require('./excel.cjs');
const Board = require('./public/board.js');
test('50-per-queue test is isolated, plans only its own fleet, and can start fresh', async t => {
  const now = Date.parse('2026-11-08T15:00:00Z');
  const h = await harness(t,{clock:()=>now}), o = h.client(), d = h.client();
  await owner(o); await driver(d,'d1');
  assert.equal((await d('/api/demo/queue-review',{})).status,403);
  const ordinary = h.load().trips;
  const start = await o('/api/demo/queue-review',{});
  assert.equal(start.status,200);
  const {runId} = start.data;
  let state = h.load();
  const queues = Board.dispatchQueue(state.trips,runId,now);
  assert.deepEqual(Object.values(queues).map(q=>q.length),[50,50,50]);
  assert.equal(queues.now.filter(t=>t.driverId).length,10);
  assert.equal(new Set(queues.attention.map(t=>Board.attentionReason(t,now))).size,3);
  assert.deepEqual(state.trips.filter(t=>!t.demoRunId),ordinary);
  assert.equal((await o('/api/demo/queue-review',{})).data.runId,runId);
  const plan = await o('/api/vehicle-plan',{action:'preview',runId});
  assert.equal(plan.status,200);
  assert.ok(plan.data.cars.length);
  assert.ok(plan.data.cars.every(car=>state.drivers.some(d=>d.id===car.driverId&&d.demoRunId===runId)));
  const fresh = await o('/api/demo/queue-review',{restart:true});
  assert.notEqual(fresh.data.runId,runId);
  state = h.load();
  assert.deepEqual(Object.values(Board.dispatchQueue(state.trips,fresh.data.runId,now)).map(q=>q.length),[50,50,50]);
  assert.equal(state.trips.filter(t=>t.demoRunId===runId&&t.status==='cancelled').length,150);
  assert.deepEqual(state.trips.filter(t=>!t.demoRunId),ordinary);
});
test('Dispatch separates ordinary and test bookings and uses the queue selection for map pins', () => {
  const now = Date.now();
  const ride = (id, minutes, extra = {}) => ({
    id, reference: id, status: 'awaiting_driver', pickupAt: now + minutes * 60000, pickup: 'Station', ...extra
  });
  const trips = [
    ride('next', 15), ride('later', 90), ride('flagged', 20, { redFlag: true }),
    ride('past', -15), ride('test', 15, { demoRunId: 'demo' }),
    ride('member', 15, { poolParentId: 'shared' }), ride('closed', 15, { status: 'cancelled' }),
    ride('late-confirmed', -8, { driverId:'driver-1', status:'heading_to_pickup', customerName:'Demo Rider' }),
    ride('arrived', -9, { driverId:'driver-2', status:'arrived' })
  ];
  const queue = Board.dispatchQueue(trips, null, now);
  const ids = rows => rows.map(row => row.id);
  assert.deepEqual(ids(queue.now), ['arrived','next']);
  assert.deepEqual(ids(queue.later), ['later']);
  assert.deepEqual(ids(queue.attention), ['late-confirmed','past','flagged']);
  assert.deepEqual(ids(Board.searchTrips(queue.attention,' demo driver ',[{id:'driver-1',name:'Demo Driver'}])),['late-confirmed']);
  assert.deepEqual(ids(Board.dispatchQueue(trips, 'demo', now).now), ['test']);
  assert.deepEqual(Board.dispatchQueue(trips, undefined, now), { now: [], later: [], attention: [] });
  const pins = Board.mapPriorities({ trips }, [{ name: 'Station', lat: 35, lng: -80 }], [], now, 'attention', queue.attention);
  assert.deepEqual(pins.groups[0].rides.map(ride => [ride.id, ride.kind]), [['late-confirmed','overdue'], ['past', 'overdue'], ['flagged', 'overdue']]);
});
test('Bookings puts the nearest upcoming pickup first before pagination and can show past trips', () => {
  const now = Date.now();
  const trip = (reference, minutes, status = 'awaiting_driver') => ({
    reference, pickupAt: now + minutes * 60000, status,
    driverId: status === 'accepted' ? 'd1' : null
  });
  const trips = [
    trip('FAR', 90, 'accepted'), trip('OLD', -120), trip('NEXT', 5),
    trip('LATE', -10), trip('CLOSED', 2, 'cancelled'), trip('DONE', -20, 'completed')
  ];
  const refs = options => Board.select(trips, { now, ...options }).rows.map(t => t.reference);
  assert.deepEqual(refs({ order: 'next', pageSize: 2 }), ['NEXT', 'FAR']);
  assert.deepEqual(refs({ order: 'next', pageSize: 2, page: 2 }), ['LATE', 'OLD']);
  assert.deepEqual(refs({ order: 'latest' }), ['FAR', 'NEXT', 'CLOSED', 'LATE', 'DONE', 'OLD']);
  assert.deepEqual(refs({ order: 'past' }), ['LATE', 'DONE', 'OLD']);
  assert.deepEqual(refs({ order: 'past', filter: 'completed' }), ['DONE']);
});
const {nextRideScenario}=require('./demo.cjs');
const Camera=require('./public/map-camera.js');
const Operations=require('./operations.cjs');
const LGTC=require('./lgtc.cjs');
function lgtcFixture() {
  const rows = [
    ['100-200-A','A','08:00','08:30',0,''],
    ['100-201-A','W','08:05','08:35',0,''],
    ['100-202-A','A','08:12','08:28',4,''],
    ['100-200-B','A','09:00','09:35',0,''],
    ['100-203-A','A','08:45','09:05',0,''],
    ['100-204-A','W','00:00','00:00',0,'Will call'],
    ['100-205-A','A','11:00','11:30',0,'Private note']
  ].map(([ref,code,start,end,extras,note]) => {
    const r=Array(38).fill('');
    Object.assign(r,{0:'MCD1',1:ref,2:'11/03/2026',3:code,4:'Private, "Sample"',7:'100 Hidden Lane',10:'Charlotte',11:'NC',14:start,16:'200 Hidden Lane',19:'Pineville',20:'NC',23:end,24:'10:15',25:'01/01/1960',28:'+15550101001',29:String(extras),33:'8.75',34:note});
    return r.map(v=>'"'+v.replaceAll('"','""')+'"').join(',');
  });
  return {filename:'LGTC_sample.csv',base64:Buffer.from('\uFEFF'+rows.join('\r\n')+'\r\n').toString('base64'),rows};
}
test('LGTC schedule keeps each source leg and date, holds zero times, and drops rider details',()=>{
  const f=lgtcFixture(), b=LGTC.detect(f.filename,f.base64);
  assert.equal(b.rows.length,7);assert.equal(b.summaries[0].missingTime,1);
  assert.equal(b.summaries[0].peak,3);assert.equal(b.summaries[0].peakAt,492);
  assert.deepEqual(b.dates,['2026-11-03']);assert.equal(b.rows[0].group,b.rows[3].group);
  assert.match(b.rows[5].issues.join(' '),/Will-call/);
  assert.doesNotMatch(JSON.stringify(b),/Hidden Lane|Private|15550101001|01\/01\/1960/);
  const encode=rows=>Buffer.from(rows.join('\n')).toString('base64');
  assert.throws(()=>LGTC.detect(f.filename,encode([f.rows[0],f.rows[0]])),/Duplicate/);
  assert.throws(()=>LGTC.detect(f.filename,encode([f.rows[0].slice(0,-3)])),/expected 38|quotation/i);
  assert.throws(()=>LGTC.detect(f.filename,encode([f.rows[0].replace('11/03/2026','02/30/2026')])),/invalid/);
  assert.equal(LGTC.detect('ordinary.csv',encode(['trip_id,pickup_at','A,2026-01-01'])),null);
});
test('LGTC plan respects capacity, accessibility and buffer and holds rows with missing instructions',()=>{
  const f=lgtcFixture(), b=LGTC.detect(f.filename,f.base64);
  const opts={serviceDate:'2026-11-03',buffer:30,fleet:{standard4:1,standard7:1,accessible4:1},profiles:{A:{mode:'standard',base:1,extras:[0]},W:{mode:'accessible',base:1,extras:[]}}};
  const p=LGTC.plan(b,opts);
  assert.equal(p.allocated,4);assert.deepEqual(p.runs.map(r=>r.trips.map(t=>t.reference)),[['100-200-A','100-200-B'],['100-202-A'],['100-201-A']]);
  assert.equal(p.runs[1].trips[0].seats,5);
  assert.deepEqual(p.unplanned.map(r=>r.reference),['100-203-A','100-205-A','100-204-A']);
  assert.match(p.unplanned[0].reasons.join(' '),/No suitable vehicle free/);
  assert.match(p.unplanned[1].reasons.join(' '),/Review source instructions/);
  assert.equal(LGTC.plan(b,{...opts,notesReviewed:true}).allocated,5);
  assert.equal(LGTC.plan(b,{...opts,profiles:{}}).allocated,0);
  assert.throws(()=>LGTC.plan(b,{...opts,profiles:{A:{mode:'standard',base:1,extras:[0,0]}}}),/extra-seat/);
});
test('LGTC historical save is owner-only and repeatable without creating dispatch work',async t=>{
  const h=await harness(t),o=h.client(),d=h.client();await owner(o);await driver(d,'d1');
  const before=h.load(), {filename,base64}=lgtcFixture();
  const preview=await o('/api/import/preview',{filename,base64});assert.equal(preview.status,200);
  const id=preview.data.batch.id;
  assert.equal((await o('/api/lgtc/schedules')).data.schedules.length,0);
  assert.equal((await d('/api/lgtc/schedules?id='+id)).status,403);
  assert.equal((await d('/api/lgtc/schedules',{filename,base64,id})).status,403);
  assert.equal((await d('/api/lgtc/plan',{id})).status,403);
  assert.equal((await o('/api/lgtc/schedules',{filename,base64,id:'wrong'})).status,400);
  for(let i=0;i<2;i++)assert.equal((await o('/api/lgtc/schedules',{filename,base64,id})).status,200);
  assert.equal((await o('/api/lgtc/schedules')).data.schedules.length,1);
  assert.equal((await o('/api/lgtc/schedules?id='+id)).data.batch.rows.length,7);
  const result=await o('/api/lgtc/plan',{id,serviceDate:'2026-11-03',buffer:30,fleet:{standard4:1},profiles:{}});
  assert.equal(result.status,200);assert.equal(result.data.plan.unplanned.length,7);
  const after=h.load();
  for(const k of ['trips','imports','offers','customerMessages'])assert.deepEqual(after[k],before[k]);
});
test('LGTC approval verifies the source, holds unresolved stops, and releases each reviewed leg only once', async t => {
  const now = Date.parse('2026-11-08T12:55:00Z');
  const h = await harness(t,{clock:()=>now}), o = h.client(), d = h.client();
  await owner(o); await driver(d,'d1');
  const filename = 'LGTC_dispatch_test.csv';
  const rows = lgtcFixture().rows.slice(0,2).map((line,i)=>line.replace('11/03/2026','11/08/2026')
    .replace('+15550101001','202-555-0109').replace('200 Hidden Lane','City Hospital')
    .replace('100 Hidden Lane',i===0?'Central Station':'Unverified Street'));
  const base64 = Buffer.from(rows.join('\n')).toString('base64');
  const {data:{batch}} = await o('/api/import/preview',{filename,base64});
  const {id} = batch, serviceDate = '2026-11-08';
  assert.equal((await o('/api/lgtc/schedules',{filename,base64,id})).status,200);
  const plan = await o('/api/lgtc/plan',{id,serviceDate,revision:0,save:true,buffer:15,driverIds:['d1','d2'],
    profiles:{A:{mode:'standard',base:1,extras:[]},W:{mode:'accessible',base:1,extras:[]}}});
  assert.equal(plan.status,200);
  const input={id,serviceDate,revision:1,filename,base64,action:'preview'};
  assert.equal((await d('/api/lgtc/dispatch',input)).status,403);
  const changed=Buffer.from(rows.join('\n').replace('Unverified Street','Central Station')).toString('base64');
  assert.equal((await o('/api/lgtc/dispatch',{...input,base64:changed})).status,400);
  const preview=await o('/api/lgtc/dispatch',input);
  assert.equal(preview.status,200);
  assert.equal(preview.data.ready.length,1);
  assert.equal(preview.data.held.length,1);
  assert.equal(h.load().trips.filter(r=>r.lgtc).length,0);
  assert.equal((await o('/api/lgtc/dispatch',{...input,action:'approve',references:['wrong']})).status,409);
  const approve={...input,action:'approve',references:preview.data.ready.map(r=>r.dispatchRef)};
  const result=await o('/api/lgtc/dispatch',approve);
  assert.equal(result.data.approved.length,1);
  const trip=h.load().trips.find(r=>r.lgtc);
  assert.equal(trip.plannedDriverId,'d1');
  assert.equal(trip.pickupAt,Date.parse('2026-11-08T13:00:00Z'));
  const retry=await o('/api/lgtc/dispatch',approve);
  assert.equal(retry.data.approved.length,0);
  assert.equal(retry.data.existing[0].tripId,trip.id);
  assert.equal(h.load().trips.filter(r=>r.lgtc).length,1);
  assert.equal((await o('/api/lgtc/customer',{action:'save',name:'Sample Private',phone:'202-555-0109',driverId:'d3'})).status,200);
  assert.equal(D.regularDriver(h.load(),trip),'d3');
  assert.equal((await o('/api/customer-preference',{tripId:trip.id,driverId:'d2'})).status,200);
  assert.equal(D.regularDriver(h.load(),trip),'d2');
  assert.equal((await o('/api/customer-preference',{tripId:trip.id,driverId:'d3'})).status,200);
  const offered=await action(o,trip.id,'offer');
  assert.equal(offered.status,200);
  assert.equal(h.load().offers.find(o=>o.tripId===trip.id).driverId,'d3');
  assert.equal(h.load().offers.find(o=>o.tripId===trip.id).selectionReason,'regular_customer_driver');
});
test('tomorrow’s LGTC import plans the regular driver and the live worker offers that driver first', async t => {
  let now=Date.parse('2026-11-09T23:00:00Z');
  const h=await harness(t,{clock:()=>now,automaticDispatch:true,initialSettings:{dispatchLeadMinutes:15,urgentGroupEnabled:false}});
  const o=h.client(),regular=h.client(),nearest=h.client();
  await owner(o);await driver(regular,'d1');await driver(nearest,'d2');
  const [pickup,dropoff]=D.places.filter(place=>place.name.startsWith('CLT '));
  h.mutate(state=>{
    state.trips=[];state.offers=[];
    Object.assign(state.drivers[0],{lat:pickup.lat+.017,lng:pickup.lng,lastLocationAt:now});
    Object.assign(state.drivers[1],{lat:pickup.lat+.002,lng:pickup.lng,lastLocationAt:now});
    state.drivers[2].status='offline';
  });
  assert.equal((await o('/api/lgtc/customer',{action:'save',name:'Repeat Test Rider',phone:'202-555-0109',driverId:'d1'})).status,200);
  assert.equal((await o('/api/lgtc/settings',{enabled:true,driverIds:['d1','d2'],buffer:10,profiles:{A:{mode:'standard',base:1,extras:[]}}})).status,200);
  const filename='LGTC_tomorrow.csv',serviceDate='2026-11-10';
  const base64=Buffer.from(['08','09'].map((hour,i)=>{
    const row=Array(38).fill('');
    Object.assign(row,{0:'MCD1',1:'551-10'+i+'-A',2:'11/10/2026',3:'A',4:'Repeat Test Rider',7:pickup.name,
      10:'Charlotte',11:'NC',12:'28202',14:hour+':00',16:dropoff.name,19:'Charlotte',20:'NC',21:'28202',
      23:hour+':30',28:'202-555-0109'});
    return row.join(',');
  }).join('\n')).toString('base64');
  const upload=await o('/api/import/preview',{filename,base64});
  assert.equal(upload.status,200);
  const id=upload.data.batch.id;
  const saved=await o('/api/lgtc/schedules',{id,filename,base64});
  assert.equal(saved.status,200);
  const batch=saved.data.batch;
  assert.equal(batch.drafts[serviceDate].automatic,true);
  const plan=await o('/api/lgtc/plan',{id,serviceDate,reopen:true});
  const run=plan.data.plan.runs.find(run=>run.driverId==='d1');
  assert.deepEqual(run.trips.map(leg=>leg.assignment),['Regular driver','Regular driver']);
  const request={id,serviceDate,revision:batch.revision,filename,base64,action:'preview'};
  const preview=await o('/api/lgtc/dispatch',request);
  assert.equal(preview.status,200);
  assert.equal(preview.data.ready.length,2);
  const approval=await o('/api/lgtc/dispatch',{...request,action:'approve',references:preview.data.ready.map(ride=>ride.dispatchRef)});
  assert.equal(approval.status,200);
  const [first,second]=approval.data.approved.map(ride=>ride.tripId);
  assert.deepEqual(h.load().trips.map(ride=>ride.plannedDriverId),['d1','d1']);
  assert.equal(h.load().offers.length,0);
  assert.ok(D.estimate(h.load().drivers[1],pickup)<D.estimate(h.load().drivers[0],pickup));
  const waitForOffer=async id=>{
    const deadline=Date.now()+6500;
    let offer;
    while(!(offer=h.load().offers.find(o=>o.tripId===id&&o.status==='pending'))&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(offer,'dispatch worker should send the offer within its pickup window');
    return offer;
  };
  now=Date.parse('2026-11-10T12:45:00Z');
  await owner(o);await driver(regular,'d1');await driver(nearest,'d2');
  const offer=await waitForOffer(first);
  assert.equal(offer.driverId,'d1');
  assert.equal(offer.selectionReason,'regular_customer_driver');
  assert.equal(h.load().trips[0].driverId,null);
  assert.equal((await action(regular,first,'accept',{offerId:offer.id})).status,200);
  assert.equal((await o('/api/state')).data.state.trips[0].driverId,'d1');
  for(const command of ['depart','arrive','pickup','complete']) assert.equal((await action(regular,first,command)).status,200);
  assert.equal((await regular('/api/driver/status',{status:'offline'})).status,200);
  now=Date.parse('2026-11-10T13:45:00Z');
  const fallback=await waitForOffer(second);
  assert.equal(fallback.driverId,'d2');
  assert.equal(fallback.selectionReason,'nearest_eligible');
  assert.equal((await action(nearest,second,'accept',{offerId:fallback.id})).status,200);
});
test('LGTC links an existing regular customer across sheets and plans named drivers with fallback and review', async t => {
  const h = await harness(t), o = h.client(), d = h.client();
  await owner(o); await driver(d,'d1');
  const phone = '+12025550109';
  h.mutate(s => {
    s.customerPreferences['ordinary:'+phone] = {customerName:'Sample Private',driverId:'d3'};
  });
  const filename = 'LGTC_repeat.csv';
  const source = lgtcFixture().rows.map((line,i) => {
    const updated = line.replace('+15550101001',i === 1 ? phone : '(202) 555-0109');
    return i === 1 ? updated.replace('Private, ""Sample""','Other Rider') : updated;
  }).join('\n');
  const upload = async text => {
    const base64 = Buffer.from(text).toString('base64');
    const preview = await o('/api/import/preview',{filename,base64});
    assert.equal(preview.status,200);
    const {batch} = preview.data;
    assert.doesNotMatch(JSON.stringify(batch),/2025550109|Hidden Lane|Sample Private|customerKey/);
    return (await o('/api/lgtc/schedules',{filename,base64,id:batch.id})).data.batch;
  };
  const batch = await upload(source);
  assert.equal(batch.rows[0].regularDriver.id,'d3');
  assert.equal(batch.rows[1].regularDriver,null);
  const input = { id:batch.id, revision:0, serviceDate:'2026-11-03', buffer:30, driverIds:['d1','d2','d3'],
    profiles:{A:{mode:'standard',base:1,extras:[0]},W:{mode:'accessible',base:1,extras:[]}},save:true };
  const result = await o('/api/lgtc/plan',input);
  assert.equal(result.status,200);
  assert.equal(result.data.plan.runs.length,3);
  assert.deepEqual(result.data.plan.runs.find(r=>r.driverId==='d3').trips.map(r=>r.assignment),['Regular driver','Regular driver']);
  assert.equal(result.data.plan.runs.find(r=>r.driverId==='d1').trips[0].assignment,'Alternate driver');
  assert.ok(result.data.plan.unplanned.some(r=>r.issues.includes('Missing or zero scheduled time')));
  assert.equal(result.data.plan.allocated+result.data.plan.unplanned.length,7);
  assert.equal((await d('/api/lgtc/preference',{id:batch.id,row:1,driverId:'d1'})).status,403);
  const changed = await o('/api/lgtc/preference',{id:batch.id,row:1,revision:1,driverId:'d1'});
  assert.equal(changed.data.batch.drafts['2026-11-03'].stale,true);
  assert.equal((await o('/api/lgtc/plan',{id:batch.id,serviceDate:'2026-11-03',reopen:true})).data.plan,null);
  const next = await upload(source.replaceAll('11/03/2026','11/04/2026'));
  assert.equal(next.rows[0].regularDriver.id,'d1');
  assert.equal(next.rows[1].regularDriver,null);
  assert.equal((await d('/api/lgtc/settings')).status,403);
  const predefine = await o('/api/lgtc/customer',{action:'save',name:'Sample Private',phone,driverId:'d3'});
  assert.equal(predefine.data.regularDriver.id,'d3');
  const defaults = {enabled:true,driverIds:input.driverIds,buffer:30,profiles:input.profiles};
  assert.equal((await o('/api/lgtc/settings',{...defaults,profiles:{}})).status,400);
  assert.equal((await o('/api/lgtc/settings',defaults)).status,200);
  const auto = await upload(source.replaceAll('11/03/2026','11/05/2026'));
  assert.equal(auto.drafts['2026-11-05'].automatic,true);
  assert.equal(auto.rows[0].regularDriver.id,'d3');
  const reopened = await o('/api/lgtc/plan',{id:auto.id,serviceDate:'2026-11-05',reopen:true});
  assert.ok(reopened.data.plan.unplanned.length);
  assert.ok(reopened.data.plan.runs.find(r=>r.driverId==='d3').trips.some(t=>t.assignment==='Regular driver'));
  const repeated = await upload(source.replaceAll('11/03/2026','11/05/2026'));
  assert.equal(repeated.revision,auto.revision);
});
test('LGTC corrections preserve the source and invalidate a saved plan until it is rebuilt', async t => {
  const h = await harness(t), o = h.client(), d = h.client();
  await owner(o); await driver(d, 'd1');
  const { filename, base64 } = lgtcFixture();
  const { data: { batch } } = await o('/api/import/preview', { filename, base64 });
  const { id } = batch;
  const serviceDate = batch.dates[0];
  await o('/api/lgtc/schedules', { filename, base64, id });
  const review = { id, revision: 0, row: 6, start: '00:00', end: '00:40',
    mode: 'accessible', seats: 2, notesReviewed: true };
  assert.equal((await d('/api/lgtc/review', review)).status, 403);
  assert.equal((await o('/api/lgtc/review', { ...review, end: '00:00' })).status, 400);
  const saved = await o('/api/lgtc/review', review);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.batch.summaries[0].missingTime, 0);
  const inputs = { id, serviceDate, buffer: 20, fleet: { accessible4: 1 }, profiles: {}, save: true };
  assert.equal((await o('/api/lgtc/plan', { ...inputs, revision: 0 })).status, 409);
  const draft = await o('/api/lgtc/plan', { ...inputs, revision: 1 });
  assert.equal(draft.status, 200);
  assert.equal(draft.data.plan.allocated, 1);
  assert.equal(draft.data.plan.runs[0].trips[0].reference, '100-204-A');
  assert.equal((await o('/api/lgtc/plan', { id, serviceDate, reopen: true })).data.plan.allocated, 1);
  assert.equal((await o('/api/lgtc/review', { id, revision: 2, row: 6, reset: true })).status, 200);
  const restored = (await o('/api/lgtc/schedules?id=' + id)).data.batch;
  assert.equal(restored.rows[5].end, 0);
  assert.equal(restored.summaries[0].missingTime, 1);
  assert.equal(restored.drafts[serviceDate].stale, true);
  assert.equal(restored.drafts[serviceDate].settings.buffer, 20);
  assert.equal((await o('/api/lgtc/plan', { id, serviceDate, reopen: true })).data.plan, null);
});
test('older accepted offers are counted without inventing their vehicle, outcome or duration',()=>{
  const now=Date.now(),s=testState(now);s.trips=s.trips.slice(0,2);s.trips[0].driverId='d1';s.trips[0].status='completed';
  s.offers=[{id:'old-1',tripId:s.trips[0].id,driverId:'d1',status:'accepted'},{id:'old-2',tripId:s.trips[1].id,driverId:'d1',status:'accepted'}];
  const driver=Operations.reports(s,{from:0,to:now+86400000,group:'driver'}).rows[0];
  assert.equal(driver.assignments,2);assert.equal(driver.completed,1);assert.equal(driver.unrecorded,1);assert.equal(driver.onboardMinutes,null);
  const car=Operations.reports(s,{from:0,to:now+86400000,group:'vehicle'}).rows[0];assert.equal(car.name,'Vehicle not recorded');assert.equal(car.assignments,2);
});
test('configured 10/15 minute dispatch window is enforced by automatic assignment',()=>{
  const now=Date.now(),s=D.seed(now),t=s.trips[0];s.trips=[t];t.pickupAt=now+12*60000;t.autoDispatch=true;
  s.settings.dispatchLeadMinutes=10;D.tick(s,now);assert.equal(s.offers.length,0);
  s.settings.dispatchLeadMinutes=15;D.tick(s,now);assert.equal(s.offers.length,1);
  assert.equal(Operations.settings(s).customerReminderMinutes,10);
});
test('acceptance creates one complete customer confirmation; reminder is queued once at configured time',()=>{
  const now=Date.now(),s=testState(now),t=s.trips[0];s.trips=[t];t.pickupAt=now+20*60000;s.settings.customerReminderMinutes=10;
  const o=D.offer(s,t,'Owner',now),d=s.drivers.find(d=>d.id===o.driverId),u={role:'driver',driverId:d.id,name:d.name};
  D.action(s,t,'accept',u,{offerId:o.id},now);
  assert.equal(s.customerMessages.length,1);const m=s.customerMessages[0];assert.equal(m.status,'demo_logged');assert.equal(m.recipient,t.customerPhone);
  for(const value of [d.name,d.phone,d.vehicle,d.plate,t.pickup,t.destination])assert.ok(m.text.includes(value));
  assert.throws(()=>D.action(s,t,'accept',u,{offerId:o.id},now));assert.equal(s.customerMessages.length,1);
  D.tick(s,now+9*60000);assert.equal(s.customerMessages.length,1);
  D.tick(s,now+10*60000);assert.equal(s.customerMessages.filter(m=>m.type==='pickup_reminder').length,1);
  D.tick(s,now+11*60000);assert.equal(s.customerMessages.length,2);
});
test('confirmation inside reminder window prevents duplicate reminders and release invalidates old car details',()=>{
  const now=Date.now(),s=testState(now),t=s.trips[0];s.trips=[t];t.pickupAt=now+8*60000;
  const o=D.offer(s,t,'Owner',now),d=s.drivers.find(d=>d.id===o.driverId),u={role:'driver',driverId:d.id,name:d.name};D.action(s,t,'accept',u,{offerId:o.id},now);
  D.tick(s,now+60000);assert.equal(s.customerMessages.length,1);
  D.action(s,t,'release',u,{reason:'Vehicle issue'},now+60000);
  assert.equal(s.customerMessages.find(m=>m.type==='confirmed').superseded,true);assert.equal(s.customerMessages.filter(m=>m.type==='released').length,1);assert.equal(t.confirmedDriver,null);
  assert.equal(s.assignmentHistory[0].outcome,'released');
});
test('driver/car reports retain accepted vehicle history, count completion and filter by pickup dates',()=>{
  const now=Date.now(),s=testState(now),t=s.trips[0];s.trips=[t];t.pickupAt=now+5*60000;
  const o=D.offer(s,t,'Owner',now),d=s.drivers.find(d=>d.id===o.driverId),oldPlate=d.plate,u={role:'driver',driverId:d.id,name:d.name};D.action(s,t,'accept',u,{offerId:o.id},now);
  D.action(s,t,'depart',u,{},now+1000);D.action(s,t,'arrive',u,{},now+2000);D.action(s,t,'pickup',u,{},now+3000);
  d.plate='CHANGED';d.vehicle='Another car';D.action(s,t,'complete',u,{},now+123000);
  const cars=Operations.reports(s,{from:now,to:now+86400000,group:'vehicle'});assert.equal(cars.rows[0].name,oldPlate);assert.equal(cars.rows[0].completed,1);assert.equal(cars.rows[0].onboardMinutes,2);
  const drivers=Operations.reports(s,{from:now,to:now+86400000,group:'driver'});assert.equal(drivers.rows[0].completed,1);assert.equal(drivers.rows[0].assignments,1);
  assert.equal(Operations.reports(s,{from:now,to:now+1000,group:'driver'}).rows.length,0);
  assert.equal(t.confirmedDriver.plate,oldPlate);
});
test('settings and exports are owner-only; invalid timing is rejected and CSV export is available',async t=>{
  const h=await harness(t),o=h.client(),c=h.client();await owner(o);await customer(c);
  const valid={...Operations.defaults,dispatchLeadMinutes:10,customerReminderMinutes:15};
  assert.equal((await c('/api/settings',valid)).status,403);assert.equal((await o('/api/settings',{...valid,dispatchLeadMinutes:0})).status,400);
  assert.equal((await o('/api/settings',valid)).status,200);assert.equal(h.load().settings.dispatchLeadMinutes,10);
  assert.equal((await c('/api/reports?group=driver')).status,403);assert.equal((await c('/api/reports.csv?group=vehicle')).status,403);
  assert.equal((await o('/api/reports?group=driver')).status,200);assert.equal((await o('/api/reports.csv?group=vehicle')).status,200);
  assert.equal((await o('/api/reports?from=not-a-date')).status,400);
});
test('customer message scope excludes other passengers and driver sessions',async t=>{
  const h=await harness(t),own=h.client(),other=h.client(),d=h.client();await customer(own);await customer(other,'+15550102002');await driver(d,'d1');
  h.mutate(s=>{const trip=s.trips[0],o=D.offer(s,trip,'Owner');D.action(s,trip,'accept',{role:'driver',driverId:o.driverId,name:'Driver'},{offerId:o.id});});
  assert.equal((await own('/api/state')).data.state.customerMessages.length,1);
  assert.equal((await other('/api/state')).data.state.customerMessages.length,0);assert.equal((await d('/api/state')).data.state.customerMessages.length,0);
});
test('CSV guards spreadsheet formulas and confirmation/reminder data persists across restart',t=>{
  assert.ok(Operations.csv({group:'driver',rows:[{name:'=HYPERLINK("x")'}]}).includes("'=HYPERLINK"));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prolift-ops-')),file=path.join(dir,'state.sqlite');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.now();let a=createApp({dbPath:file,automaticDispatch:false,clock:()=>now,initialSettings:{dispatchLeadMinutes:30,customerReminderMinutes:10}});
  a.mutate(s=>{const t=s.trips[0];s.trips=[t];t.pickupAt=now+20*60000;const o=D.offer(s,t,'Owner',now);D.action(s,t,'accept',{role:'driver',driverId:o.driverId,name:'Driver'},{offerId:o.id},now);D.tick(s,now+10*60000);});assert.equal(a.load().customerMessages.length,2);a.close();
  a=createApp({dbPath:file,automaticDispatch:false,clock:()=>now+10*60000});a.mutate(s=>D.tick(s,now+10*60000));assert.equal(a.load().customerMessages.length,2);assert.equal(a.load().settings.dispatchLeadMinutes,30);a.close();
});
test('map zoom preserves the cursor anchor, clamps scale and supports pan, center and reset',()=>{
  const initial=Camera.create(),zoomed=Camera.zoom(initial,.5,.25,.75);
  assert.equal(zoomed.x+zoomed.width*.25,initial.x+initial.width*.25);
  assert.equal(zoomed.y+zoomed.height*.75,initial.y+initial.height*.75);
  assert.equal(Camera.zoom(initial,.0001).width,80);assert.equal(Camera.zoom(initial,100).width,1600);
  const moved=Camera.pan(zoomed,25,-10);assert.equal(moved.x,zoomed.x+25);
  const centered=Camera.center(moved,300,200);assert.equal(centered.x+centered.width/2,300);
  assert.deepEqual(Camera.create(),initial);
});
test('upcoming schedule supports today, tomorrow, full future list, search and pagination',()=>{
  const now=new Date(2026,9,29,12).getTime(),today=new Date(2026,9,29,14).getTime(),tomorrow=new Date(2026,9,30,14).getTime(),later=new Date(2026,10,10,14).getTime();
  const row=(reference,pickupAt,status='awaiting_driver')=>({reference,pickupAt,status,customerName:'Alex',pickup:'Central Station',destination:'City Hospital'});
  const trips=[row('TODAY',today),row('TOMORROW',tomorrow),row('LATER',later),row('DONE',today,'completed'),row('PAST',now-1000)];
  assert.deepEqual(Board.schedule(trips,{now,period:'today'}).rows.map(t=>t.reference),['TODAY']);
  assert.deepEqual(Board.schedule(trips,{now,period:'tomorrow'}).rows.map(t=>t.reference),['TOMORROW']);
  assert.equal(Board.schedule(trips,{now,period:'all'}).total,3);
  assert.equal(Board.schedule(trips,{now,period:'all',search:'LATER'}).rows[0].reference,'LATER');
  assert.equal(Board.schedule(Array.from({length:500},(_,i)=>row('R'+i,today+i)),{now,period:'all',page:20}).rows.length,25);
});
test('owner can create a future planned ride; drivers cannot book and customer identity remains scoped',async t=>{
  const h=await harness(t),o=h.client(),d=h.client();await owner(o);await driver(d,'d1');
  const booking={customerName:'Planned passenger',customerPhone:'+15550102888',pickup:'Central Station',destination:'City Hospital',pickupAt:new Date(Date.now()+3*86400000).toISOString(),passengers:2};
  const r=await o('/api/book',booking,crypto.randomUUID());assert.equal(r.status,201);
  const trip=h.load().trips.find(t=>t.id===r.data.tripId);assert.equal(trip.customerPhone,booking.customerPhone);assert.equal(trip.autoDispatch,true);assert.equal(trip.status,'awaiting_driver');
  assert.equal((await d('/api/book',booking,crypto.randomUUID())).status,403);
  assert.equal((await o('/map-camera.js')).status,200);
});
function sequentialFixture(now,count=5) {
  const s=testState(now),trip=s.trips[0];s.trips=[trip];
  s.drivers=Array.from({length:count},(_,index)=>({id:'rank-'+(index+1),name:'Driver '+(index+1),status:'online',seats:4,capabilities:[],lat:40.7527+(index+1)*0.004,lng:-73.9772,lastLocationAt:now}));
  trip.autoDispatch=true;return {s,trip};
}
test('all five eligible drivers receive sequential offers in nearest order, then owner is alerted once',()=>{
  const now=Date.now(),{s,trip}=sequentialFixture(now);
  D.tick(s,now);
  for(let rank=1;rank<=5;rank++) {
    const pending=s.offers.filter(o=>o.status==='pending');assert.equal(pending.length,1);
    const o=pending[0];assert.equal(o.driverId,'rank-'+rank);assert.equal(o.attemptNumber,rank);
    D.action(s,trip,'decline',{role:'driver',driverId:o.driverId,name:'Driver '+rank},{offerId:o.id,reason:'Unable to take this trip'},now+rank*1000);
  }
  assert.equal(s.offers.length,5);assert.equal(s.offers.filter(o=>o.status==='pending').length,0);
  assert.equal(trip.driverId,null);assert.equal(trip.dispatchExhausted,true);assert.equal(Board.group(trip,now),'attention');
  D.tick(s,now+70000);assert.equal(s.events.filter(e=>e.type==='dispatch.exhausted').length,1);
});
test('sequential offers stop as soon as the third nearest driver accepts',()=>{
  const now=Date.now(),{s,trip}=sequentialFixture(now);D.tick(s,now);
  for(let rank=1;rank<=2;rank++){const o=s.offers.at(-1);D.action(s,trip,'decline',{role:'driver',driverId:o.driverId,name:'Driver '+rank},{offerId:o.id,reason:'Pickup too far'},now+rank*1000);}
  const o=s.offers.at(-1);assert.equal(o.driverId,'rank-3');
  D.action(s,trip,'accept',{role:'driver',driverId:o.driverId,name:'Driver 3'},{offerId:o.id},now+3000);
  D.tick(s,now+120000);assert.equal(s.offers.length,3);assert.equal(trip.driverId,'rank-3');assert.equal(trip.dispatchExhausted,false);
});
test('timeout tries the next currently available driver and skips offline/busy candidates',()=>{
  const now=Date.now(),{s,trip}=sequentialFixture(now);D.tick(s,now);
  s.drivers[1].status='offline';s.drivers[2].status='busy';
  D.tick(s,now+46000);
  assert.equal(s.offers[0].status,'expired');assert.equal(s.offers.at(-1).driverId,'rank-4');
  assert.equal(s.offers.at(-1).attemptNumber,2);assert.equal(s.offers.filter(o=>o.status==='pending').length,1);
});
test('finishing a ride frees the driver, wakes dispatch, selects the due nearby pickup and skips later booking',()=>{
  const now=Date.now(),s=testState(now),scenario=nextRideScenario(s,now);
  const driver=s.drivers.find(d=>d.id===scenario.driverId),current=s.trips.find(t=>t.id===scenario.currentTripId),next=s.trips.find(t=>t.id===scenario.nextTripId),later=s.trips.find(t=>t.id===scenario.laterTripId);
  assert.equal(driver.status,'busy');assert.equal(current.status,'onboard');assert.equal(next.status,'awaiting_driver');
  assert.ok(next.retryAt>now); // no feasible driver while Alex remains busy
  const actor={role:'driver',driverId:driver.id,name:driver.name};D.action(s,current,'complete',actor,{},now+1000);
  assert.equal(driver.status,'online');assert.equal(next.retryAt,now+1000);
  assert.ok(s.events.some(e=>e.type==='driver.available'&&e.actor===driver.name));
  D.tick(s,now+2000);const offer=s.offers.find(o=>o.tripId===next.id&&o.status==='pending');
  assert.equal(offer.driverId,driver.id);assert.equal(offer.eta,1);assert.equal(later.status,'awaiting_driver');
  D.action(s,next,'accept',actor,{offerId:offer.id},now+3000);
  assert.equal(driver.status,'busy');assert.equal(next.driverId,driver.id);assert.equal(next.status,'accepted');
  assert.equal(s.offers.filter(o=>o.tripId===later.id).length,0);
});
test('fleet distinguishes off-ride available, on-ride, awaiting reply, offline and stale locations', () => {
  const now=Date.now(),s=testState(now);
  assert.equal(Board.fleet(s,now).filter(x=>x.status==='available').length,3);
  const offer=D.offer(s,s.trips[0],'System',now);
  assert.equal(Board.fleet(s,now).find(x=>x.driver.id===offer.driverId).status,'offered');
  D.action(s,s.trips[0],'accept',{role:'driver',driverId:offer.driverId,name:'Driver'},{offerId:offer.id},now);
  assert.equal(Board.fleet(s,now).find(x=>x.driver.id===offer.driverId).status,'onride');
  s.drivers[1].status='offline';assert.equal(Board.fleet(s,now)[1].status,'offline');
  s.drivers[2].lastLocationAt=now-180000;assert.equal(Board.fleet(s,now)[2].status,'stale');
});
test('normal startup automatically dispatches queued trips without an owner button', async t => {
  const h=await harness(t,{automaticDispatch:true});
  const s=h.load();assert.ok(s.offers.some(o=>o.status==='pending'));
  assert.ok(s.trips.every(t=>t.autoDispatch));
});
test('500-trip board paginates 25 at a time and searches across the full queue', () => {
  const now = Date.now(), trips = Array.from({length:500}, (_, i) => ({ id:'t'+i, reference:'R'+String(i).padStart(3,'0'), pickupAt:now+3600000+i*1000, customerName:'Customer '+i, pickup:'Central Station', destination:'City Hospital', status:'awaiting_driver', driverId:null, autoDispatch:true }));
  let view = Board.select(trips, {now}); assert.equal(view.counts.waiting,500); assert.equal(view.rows.length,25); assert.equal(view.pages,20);
  view=Board.select(trips,{now,page:20}); assert.equal(view.start,476); assert.equal(view.end,500);
  view=Board.select(trips,{now,search:'Customer 499',page:20}); assert.equal(view.total,1); assert.equal(view.page,1); assert.equal(view.rows[0].id,'t499');
  trips[0].dispatchError='No available driver'; assert.equal(Board.group(trips[0],now),'waiting');
  trips[1].status='offered'; assert.equal(Board.group(trips[1],now),'offered');
  trips[2].driverId='d1'; trips[2].status='accepted'; assert.equal(Board.group(trips[2],now),'assigned');
  trips[3].redFlag=true; assert.equal(Board.group(trips[3],now),'attention');
});
test('bulk assignment handles 500 rides with 3 drivers without double offers', async t => {
  const h=await harness(t), o=h.client(); await owner(o);
  h.mutate(s => { const source=s.trips[0]; s.trips=Array.from({length:500},(_,i)=>({...structuredClone(source),id:'bulk-'+i,reference:'BULK-'+i,pickupAt:Date.now()+3600000+i*1000})); });
  const response=await o('/api/dispatch/start',{}); assert.equal(response.status,200); assert.equal(response.data.offered,3);
  const snapshot=h.load(), pending=snapshot.offers.filter(o=>o.status==='pending');
  assert.equal(new Set(pending.map(o=>o.driverId)).size,3); assert.equal(snapshot.trips.length,500);
  const board=Board.select(snapshot.trips); assert.equal(board.counts.offered,3); assert.equal(board.counts.waiting,497); assert.equal(board.counts.attention,0);
});
async function harness(t, options = {}) {
  const app = createApp({ dbPath: ':memory:', automaticDispatch: false, initialSettings:{dispatchLeadMinutes:90}, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => { app.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  function client() {
    let cookie = '';
    return async function request(route, body, key, extraHeaders = {}) {
      const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      const type = res.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data };
    };
  }
  return { ...app, base, client };
}
async function owner(c) { assert.equal((await c('/api/demo-login', { role: 'owner' })).status, 200); }
async function driver(c, driverId) { assert.equal((await c('/api/demo-login', { role: 'driver', driverId })).status, 200); }
async function customer(c, phone = '+15550102001') {
  const code = (await c('/api/auth/request-code', { phone })).data.demoCode;
  const result = await c('/api/auth/verify', { phone, name: 'Test customer', code }); assert.equal(result.status, 200); return code;
}
const action = (c, id, command, extra = {}, key = crypto.randomUUID()) => c(`/api/trips/${id}/action`, { action: command, ...extra }, key);
test('protected road pilot approves verified LGTC addresses and requires GPS and a road ETA before offering', async t=>{
  let now=Date.parse('2026-11-08T12:58:00Z'), routeDown=false;
  const pilotConfig={ownerCode:'owner-code-for-test-only',drivers:[
    {id:'pilot-driver',name:'Pilot test driver',phone:'+12025550101',vehicle:'Test car',plate:'TEST',seats:4,capabilities:[],code:'driver-code-for-test-only'},
    {id:'backup-driver',name:'Backup test driver',phone:'+12025550102',vehicle:'Test van',plate:'BACKUP',seats:7,capabilities:[],code:'backup-code-for-test-only'}
  ],verifiedStops:[
    {name:'Verified Pilot Pickup',address:'100 Hidden Lane',city:'Charlotte',state:'NC',zip:'28202',lat:35.22,lng:-80.83},
    {name:'Verified Pilot Destination',address:'200 Hidden Lane',city:'Pineville',state:'NC',zip:'28134',lat:35.08,lng:-80.89}
  ]};
  const matrixCalls=[];
  const h=await harness(t,{clock:()=>now,pilotConfig,roadMatrix:async (origins,destinations)=>{
    matrixCalls.push({origins,destinations});
    if (routeDown) throw Error('Test provider unavailable');
    return origins.map((_,originIndex)=>({originIndex,condition:'ROUTE_EXISTS',duration:'60s'}));
  }});
  const o=h.client(),d=h.client(),backup=h.client(),guest=h.client();
  assert.equal((await guest('/api/config')).data.places.length,0);
  assert.equal((await guest('/api/demo-login',{role:'owner'})).status,403);
  assert.equal((await o('/api/pilot-login',{role:'owner',code:'wrong'})).status,401);
  assert.equal((await o('/api/pilot-login',{role:'owner',code:pilotConfig.ownerCode})).status,200);
  assert.equal((await d('/api/pilot-login',{role:'driver',driverId:'pilot-driver',code:pilotConfig.drivers[0].code})).status,200);
  assert.equal((await backup('/api/pilot-login',{role:'driver',driverId:'backup-driver',code:pilotConfig.drivers[1].code})).status,200);
  assert.equal((await o('/api/config')).data.places.length,2);
  assert.equal((await o('/api/demo/queue-review',{})).status,403);
  assert.equal(h.load().trips.length,0);
  const row=Array(38).fill('');
  Object.assign(row,{0:'MCD1',1:'123-456-A',2:'11/08/2026',3:'A',4:'Test Rider',7:'100 Hidden Lane',
    10:'Charlotte',11:'NC',12:'28202',14:'08:00',16:'200 Hidden Lane',19:'Pineville',20:'NC',21:'28134',23:'08:30',28:'202-555-0109'});
  const unresolved = [...row];
  Object.assign(unresolved,{1:'123-457-A',12:'28203',14:'09:00',23:'09:30'});
  const file={filename:'LGTC_pilot.csv',base64:Buffer.from([row,unresolved].map(fields=>fields.join(',')).join('\n')).toString('base64')};
  const {data:{batch}}=await o('/api/import/preview',file),id=batch.id,serviceDate='2026-11-08';
  assert.equal((await o('/api/lgtc/schedules',{...file,id})).status,200);
  assert.equal((await o('/api/lgtc/plan',{id,serviceDate,revision:0,buffer:15,save:true,driverIds:['pilot-driver'],
    profiles:{A:{mode:'standard',base:1,extras:[]}}})).status,200);
  const release={...file,id,serviceDate,revision:1,action:'preview'};
  const preview=await o('/api/lgtc/dispatch',release);
  assert.equal(preview.data.ready.length,1);
  assert.match(preview.data.held[0].reasons.join(' '),/verified street, city, state and ZIP/);
  const result=await o('/api/lgtc/dispatch',{...release,action:'approve',references:preview.data.ready.map(r=>r.dispatchRef)});
  const tripId=result.data.approved[0].tripId;
  assert.equal(h.load().trips[0].lgtc.test,false);
  assert.equal((await action(o,tripId,'offer')).status,400);
  assert.equal(matrixCalls.length,0);
  assert.equal((await d('/api/driver/status',{status:'online'})).status,200);
  assert.equal((await d('/api/driver/tracking',{enabled:true})).status,200);
  assert.equal((await d('/api/driver/location',{points:[{id:'pilot-gps-point',latitude:35.221,longitude:-80.831,accuracy:8,capturedAt:now}]})).data.accepted.length,1);
  assert.equal((await backup('/api/driver/status',{status:'online'})).status,200);
  assert.equal((await backup('/api/driver/tracking',{enabled:true})).status,200);
  const reading=latitude=>backup('/api/driver/location',{points:[{id:'backup-gps-'+now,latitude,longitude:-80.832,accuracy:8,capturedAt:now}]});
  assert.equal((await reading(35.222)).data.accepted.length,1);
  assert.equal((await action(o,tripId,'offer')).status,400);
  const inspect=await o('/api/trips/'+tripId+'/dispatch-review');
  assert.equal(inspect.data.candidates[0].eta,1);
  assert.equal(matrixCalls[0].origins[0].lat,35.221);
  assert.equal((await action(o,tripId,'offer')).status,200);
  const pending=h.load().offers.find(o=>o.tripId===tripId&&o.status==='pending');
  assert.equal(pending.etaSource,'road');
  assert.equal(pending.driverId,'pilot-driver');
  assert.equal((await action(d,tripId,'decline',{offerId:pending.id,reason:'On a break'})).status,200);
  const replacement=h.load().offers.find(o=>o.tripId===tripId&&o.status==='pending');
  assert.equal(replacement.driverId,'backup-driver');
  now+=1000;
  assert.equal((await reading(35.224)).data.accepted.length,1);
  routeDown=true;
  assert.equal((await action(backup,tripId,'accept',{offerId:replacement.id})).status,409);
  assert.equal(h.load().offers.find(o=>o.id===replacement.id).status,'pending');
  now+=10001;routeDown=false;
  const acceptKey=crypto.randomUUID();
  const replies=await Promise.all([
    action(backup,tripId,'accept',{offerId:replacement.id},acceptKey),
    action(backup,tripId,'accept',{offerId:replacement.id},acceptKey)
  ]);
  assert.deepEqual(replies.map(r=>r.status),[200,200]);
  assert.equal(matrixCalls.at(-1).origins[0].lat,35.224);
  assert.equal(h.load().assignmentHistory.filter(row=>row.tripId===tripId).length,1);
  for(const command of ['depart','arrive','pickup','complete'])assert.equal((await action(backup,tripId,command)).status,200);
  assert.equal((await o('/api/state')).data.state.trips[0].status,'completed');
  assert.equal((await backup('/api/driver/status',{status:'offline'})).status,200);
  assert.equal((await backup('/api/driver/status',{status:'online'})).status,200);
  assert.equal((await backup('/api/driver/tracking',{enabled:true})).status,200);
  assert.equal(h.load().drivers.find(driver=>driver.id==='backup-driver').lastLocationAt,0);
});
test('interactive dummy trip selects 1-minute driver, declines to 6-minute driver, then confirms acceptance', async t => {
  const h = await harness(t), c = h.client(); await owner(c);
  const start = await c('/api/demo/start-trip', {}); assert.equal(start.status, 201);
  assert.deepEqual(start.data.candidates.map(x => x.eta), [1, 6, 11]);
  let s = h.load(), offer = s.offers.find(o => o.tripId === start.data.tripId && o.status === 'pending');
  assert.equal(offer.driverId, 'demo-driver-1');
  assert.equal((await c('/api/demo/respond', { tripId: start.data.tripId, offerId: offer.id, action: 'decline', reason: 'On a break' })).status, 200);
  s = h.load(); offer = s.offers.find(o => o.tripId === start.data.tripId && o.status === 'pending');
  assert.equal(offer.driverId, 'demo-driver-2');
  assert.equal((await c('/api/demo/respond', { tripId: start.data.tripId, offerId: offer.id, action: 'accept' })).status, 200);
  assert.equal(h.load().trips.find(t => t.id === start.data.tripId).driverId, 'demo-driver-2');
  assert.equal(h.load().trips.find(t => t.id === start.data.tripId).status, 'accepted');
  assert.equal((await c('/api/demo/respond', { tripId: start.data.tripId, offerId: offer.id, action: 'accept' })).status, 400);
});
test('dummy walkthrough cannot respond to normal trips or be controlled by customers; demo fleet remains isolated', async t => {
  const h = await harness(t), o = h.client(), c = h.client(); await owner(o); await customer(c);
  assert.equal((await c('/api/demo/start-trip', {})).status, 403);
  await o('/api/demo/start-trip', {});
  const s = h.load(), ordinary = s.trips.find(t => !t.demoRunId);
  assert.ok(D.eligible(s, ordinary, Date.now()).every(x => !x.driver.demoRunId));
  assert.equal((await o('/api/demo/respond', { tripId: ordinary.id, offerId: 'anything', action: 'accept' })).status, 400);
  assert.equal((await o('/api/demo/start-trip', {})).status, 201);
  assert.equal(h.load().drivers.filter(d => d.demoRunId).length, 3);
  assert.equal(h.load().trips.filter(t => t.demoRunId && t.status !== 'cancelled').length, 1);
});
test('owner automatic dispatch exposes the selected driver and does not duplicate pending offers', async t => {
  const h = await harness(t), o = h.client(), c = h.client(); await owner(o); await customer(c);
  assert.equal((await c('/api/dispatch/start', {})).status, 403);
  const first = await o('/api/dispatch/start', {}); assert.equal(first.status, 200); assert.ok(first.data.offered > 0);
  const snapshot = (await o('/api/state')).data.state;
  assert.ok(snapshot.offers.some(offer => offer.status === 'pending' && snapshot.drivers.some(d => d.id === offer.driverId)));
  const count = snapshot.offers.length;
  await o('/api/dispatch/start', {}); assert.equal(h.load().offers.length, count);
});
test('authentication and static allowlist keep database/source inaccessible', async t => {
  const h = await harness(t), c = h.client();
  assert.equal((await c('/api/state')).status, 401);
  for (const route of ['/server.cjs', '/data/prolift.sqlite', '/package.json', '/%2e%2e/server.cjs']) assert.equal((await c(route)).status, 404);
  assert.equal((await c('/')).status, 200);
  assert.equal((await c('/api/demo-login', { role: 'owner' }, null, { Origin: 'https://attacker.example' })).status, 403);
});
test('customer OTP is single use; customers see only their trips and cannot dispatch', async t => {
  const h = await harness(t), c = h.client(), phone = '+15550102001';
  const code = await customer(c, phone), r = (await c('/api/state')).data.state;
  assert.equal(r.trips.length, 1); assert.ok(r.trips.every(x => x.customerPhone === phone));
  assert.equal(r.imports.length, 0); assert.equal(r.customers.length, 0);
  assert.equal((await action(c, r.trips[0].id, 'offer')).status, 400);
  assert.equal((await c('/api/auth/verify', { phone, code })).status, 400);
});
test('OTP wrong-code attempts lock out even the correct code', async t => {
  const h = await harness(t), c = h.client(), phone = '+15550102999';
  const code = (await c('/api/auth/request-code', { phone })).data.demoCode;
  for (let i = 0; i < 5; i++) assert.equal((await c('/api/auth/verify', { phone, code: 'not-correct', name: 'Test' })).status, 400);
  assert.equal((await c('/api/auth/verify', { phone, code, name: 'Test' })).status, 400);
});
test('Excel template roundtrip, preview, atomic confirmation, duplicate protection', async t => {
  const h = await harness(t), c = h.client(); await owner(c);
  const file = (await c('/api/template')).data;
  const rows = parseFile('trips.xlsx', file); assert.equal(rows.length, 1); assert.equal(rows[0].pickup, 'Central Station');
  const preview = (await c('/api/import/preview', { filename: 'trips.xlsx', base64: file.toString('base64') })).data.batch;
  assert.deepEqual(preview.rows[0].errors, []); assert.equal(h.load().trips.length, 4);
  assert.equal((await c('/api/import/confirm', { batchId: preview.id })).data.count, 1);
  assert.equal((await c('/api/import/confirm', { batchId: preview.id })).data.alreadyConfirmed, true);
  assert.equal(h.load().trips.length, 5);
  const duplicate = (await c('/api/import/preview', { filename: 'trips.xlsx', base64: file.toString('base64') })).data.batch;
  assert.ok(duplicate.rows[0].errors.includes('Duplicate trip ID'));
  assert.equal((await c('/api/import/confirm', { batchId: duplicate.id })).status, 400);
});
test('invalid import row prevents entire batch and unknown addresses are not invented', async t => {
  const h = await harness(t), c = h.client(); await owner(c);
  const bytes = workbook([['trip_id', 'pickup_at', 'customer_name', 'customer_phone', 'pickup', 'destination', 'passengers'], ['A', new Date(Date.now() + 3600000).toISOString(), 'Test', '+15550102001', 'Unknown address', 'City Hospital', 1]]);
  const r = await c('/api/import/preview', { filename: 'bad.xlsx', base64: bytes.toString('base64') });
  assert.ok(r.data.batch.rows[0].errors.some(e => e.includes('Unknown pickup')));
  assert.equal((await c('/api/import/confirm', { batchId: r.data.batch.id })).status, 400);
  assert.equal(h.load().trips.length, 4);
});
test('full assignment, dropped ride, replacement, completion and rating lifecycle', async t => {
  const h = await harness(t), o = h.client(), a = h.client(), b = h.client(), c = h.client(); await owner(o); await driver(a, 'd1'); await driver(b, 'd2'); await customer(c);
  const trip = h.load().trips[0];
  assert.equal((await action(o, trip.id, 'offer')).status, 200);
  let offer = h.load().offers.at(-1); assert.equal(offer.driverId, 'd1');
  assert.equal((await action(b, trip.id, 'accept', { offerId: offer.id })).status, 400);
  assert.equal((await action(a, trip.id, 'accept', { offerId: offer.id })).status, 200);
  assert.equal((await action(a, trip.id, 'release', { reason: 'Vehicle issue' })).status, 200);
  let current = h.load().trips.find(x => x.id === trip.id); assert.equal(current.status, 'needs_reassignment'); assert.equal(current.driverId, null); assert.equal(current.redFlag, true);
  await action(o, trip.id, 'offer'); offer = h.load().offers.at(-1);
  assert.notEqual(offer.driverId, 'd1'); assert.equal(h.load().trips[0].redFlag, true);
  const replacement = h.client(); await driver(replacement, offer.driverId);
  assert.equal((await action(replacement, trip.id, 'accept', { offerId: offer.id })).status, 200);
  assert.equal(h.load().trips[0].redFlag, false);
  for (const command of ['depart', 'arrive', 'pickup', 'complete']) assert.equal((await action(replacement, trip.id, command)).status, 200);
  assert.equal((await action(replacement, trip.id, 'complete')).status, 400);
  assert.equal((await action(c, trip.id, 'rate', { stars: 5 })).status, 200);
  assert.equal((await action(c, trip.id, 'rate', { stars: 1 })).status, 400);
  assert.ok(h.load().events.some(e => e.detail === 'Vehicle issue'));
});
test('duplicate and competing acceptance requests cannot assign twice', async t => {
  const h = await harness(t), o = h.client(), d = h.client(); await owner(o); await driver(d, 'd1'); const trip = h.load().trips[0];
  const key = crypto.randomUUID();
  assert.equal((await action(o, trip.id, 'offer', {}, key)).status, 200);
  assert.equal((await action(o, trip.id, 'offer', {}, key)).status, 200);
  assert.equal(h.load().offers.length, 1);
  const offer = h.load().offers[0];
  const responses = await Promise.all([action(d, trip.id, 'accept', { offerId: offer.id }), action(d, trip.id, 'accept', { offerId: offer.id })]);
  assert.deepEqual(responses.map(x => x.status).sort(), [200, 400]);
  assert.equal(h.load().events.filter(e => e.type === 'assignment.accepted').length, 1);
});
test('expired offer and scheduled dispatch rules', () => {
  const now = Date.now(), s = testState(now), t = s.trips[0];
  const o = D.offer(s, t, 'Test', now);
  D.tick(s, now + 46000); assert.equal(o.status, 'expired'); assert.notEqual(t.status, 'offered');
  assert.throws(() => D.action(s, t, 'accept', { role: 'driver', driverId: o.driverId }, { offerId: o.id }, now + 46000), /no longer available/);
  t.pickupAt = now + 3 * 3600000; assert.throws(() => D.offer(s, t, 'Test', now), /scheduled/);
});
test('vehicle suitability, stale GPS, busy drivers and reservation by pending offer', () => {
  const now = Date.now(), s = testState(now), t = s.trips[3];
  assert.equal(D.eligible(s, t, now)[0].driver.id, 'd2');
  s.drivers[1].lastLocationAt = now - 121000; assert.equal(D.eligible(s, t, now).length, 0);
  s.drivers[1].lastLocationAt = now;
  D.offer(s, t, 'Test', now); assert.equal(D.eligible(s, s.trips[0], now).some(x => x.driver.id === 'd2'), false);
});
test('SQLite persistence survives reopen', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolift-test-')), file = path.join(dir, 'state.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let a = createApp({ dbPath: file }); a.mutate(s => { s.trips[0].reference = 'PERSISTED'; }); a.close();
  a = createApp({ dbPath: file }); assert.equal(a.load().trips[0].reference, 'PERSISTED'); a.close();
});
test('automatic imported-trip dispatch waits for lead window and retries declined offers', () => {
  const now = Date.now(), s = testState(now);
  const rows = D.validateRows(s, [{ trip_id: 'AUTO-1', pickup_at: new Date(now + 3 * 3600000).toISOString(), customer_name: 'Test', customer_phone: '+15550102001', pickup: 'Central Station', destination: 'City Hospital', passengers: '1' }], now);
  assert.deepEqual(rows[0].errors, []); const trip = rows[0].trip; s.trips.push(trip);
  D.tick(s, now); assert.equal(s.offers.length, 0);
  const later = now + 2 * 3600000;
  D.tick(s, later); const first = s.offers.at(-1); assert.equal(first.tripId, trip.id);
  D.action(s, trip, 'decline', { role: 'driver', driverId: first.driverId, name: 'Test driver' }, { offerId: first.id, reason: 'On a break' }, later);
  D.tick(s, later + 1000); assert.notEqual(s.offers.at(-1).driverId, first.driverId);
});
test('customer booking and cancellation enforce ownership', async t => {
  const h = await harness(t), c = h.client(); await customer(c);
  const booking = { pickup: 'Central Station', destination: 'City Hospital', pickupAt: new Date(Date.now() + 3600000).toISOString(), passengers: 2 }, key = crypto.randomUUID();
  const r = await c('/api/book', booking, key);
  assert.equal(r.status, 201);
  const repeat = await c('/api/book', booking, key); assert.equal(repeat.data.tripId, r.data.tripId); assert.equal(h.load().trips.length, 5);
  assert.equal((await action(c, r.data.tripId, 'cancel')).status, 200);
  assert.equal((await action(c, h.load().trips[1].id, 'cancel')).status, 400);
});
test('owner can restart exhausted search without reconsidering a released driver', () => {
  const now = Date.now(), s = testState(now), trip = s.trips[0];
  trip.excluded = ['d1', 'd2', 'd3']; trip.droppedDrivers = ['d1']; trip.redFlag = true; trip.status = 'needs_reassignment';
  D.action(s, trip, 'retry', { role: 'owner', name: 'Owner' }, {}, now);
  assert.deepEqual(trip.excluded, ['d1']);
  D.tick(s, now); assert.equal(trip.status, 'offered'); assert.equal(trip.redFlag, true); assert.notEqual(s.offers.at(-1).driverId, 'd1');
});
test('decline requires a preset reason, records it, and offers the next eligible driver', () => {
  const now = Date.now(), s = testState(now), trip = s.trips[0], o = D.offer(s, trip, 'Owner', now);
  const user = { role: 'driver', driverId: o.driverId, name: 'Maya Chen' };
  assert.throws(() => D.action(s, trip, 'decline', user, { offerId: o.id }, now), /listed decline reason/);
  assert.equal(o.status, 'pending');
  D.action(s, trip, 'decline', user, { offerId: o.id, reason: 'Vehicle issue' }, now);
  assert.equal(o.declineReason, 'Vehicle issue');
  assert.ok(s.events.some(e => e.actor === 'Maya Chen' && e.detail === 'Vehicle issue'));
  D.tick(s, now + 1000); assert.equal(trip.status, 'offered'); assert.notEqual(s.offers.at(-1).driverId, user.driverId);
});
const Reservations=require('./reservations.cjs'),RideService=require('./ride-service.cjs');
test('scheduled reservations protect driver/car time and dispatch reserved driver before a nearer candidate',()=>{
 const now=Date.now(),s=D.seed(now),t=s.trips[0];t.pickupAt=now+60*60000;s.trips=[t];
 Reservations.reserve(s,t,'d2',D.places,now);assert.equal(t.reservedDriverId,'d2');assert.equal(s.customerMessages.length,0);
 const other={...t,id:'overlap',reservedDriverId:null};s.trips.push(other);assert.throws(()=>Reservations.reserve(s,other,'d2',D.places,now),/overlap/);
 const at=t.pickupAt-15*60000;s.drivers.forEach(d=>d.lastLocationAt=at);const o=D.offer(s,t,'System',at);assert.equal(o.driverId,'d2');
 D.action(s,t,'accept',{role:'driver',driverId:'d2',name:'James'},{offerId:o.id},at);assert.equal(s.reservations[0].status,'fulfilled');assert.equal(s.customerMessages.length,1);
});
test('offline reserved driver falls back to a reachable driver and preserves an owner attention flag',()=>{
 const now=Date.now(),s=D.seed(now),t=s.trips[0];s.trips=[t];t.pickupAt=now+60*60000;Reservations.reserve(s,t,'d2',D.places,now);s.drivers[1].status='offline';
 const at=t.pickupAt-15*60000;s.drivers.forEach(d=>d.lastLocationAt=at);const o=D.offer(s,t,'System',at);assert.equal(o.driverId,'d1');assert.equal(t.reservationIssue,true);assert.equal(s.reservations[0].status,'unavailable');
});
test('last ride finishes offline, stage messages are unique, and completed summary preserves car identity',()=>{
 const now=Date.now(),s=testState(now),t=s.trips[0];s.trips=[t];const o=D.offer(s,t,'Owner',now),u={role:'driver',driverId:o.driverId,name:'Driver'};
 D.action(s,t,'accept',u,{offerId:o.id},now);const d=s.drivers.find(d=>d.id===o.driverId);d.finishThenOffline=true;
 for(const c of ['depart','arrive','pickup','complete'])D.action(s,t,c,u,{},now+1000);
 assert.equal(d.status,'offline');assert.equal(d.finishThenOffline,false);assert.equal(s.customerMessages.filter(m=>m.type.startsWith('stage_')).length,4);
 Operations.stage(s,t,'complete',now+2000);assert.equal(s.customerMessages.filter(m=>m.type==='stage_complete').length,1);
 const customer={role:'customer',phone:t.customerPhone};assert.equal(RideService.summary(s,t,customer).plate,d.plate);assert.throws(()=>RideService.summary(s,t,{role:'customer',phone:'+15559999999'}));
});
test('trip help is deduplicated and scoped; drivers send a preset without typing',()=>{
 const now=Date.now(),s=Operations.normalize(testState(now)),t=s.trips[0],u={role:'customer',phone:t.customerPhone,name:'Alex'};
 const r=RideService.request(s,t,u,{category:'booking_question',details:'Please confirm my pickup'},now);assert.equal(RideService.request(s,t,u,{category:'booking_question',details:'Please confirm my pickup'},now).id,r.id);
 assert.equal(D.scoped(s,{role:'customer',phone:'+15559999999'}).supportRequests.length,0);assert.throws(()=>RideService.request(s,t,u,{category:'lost_item',details:'Missing bag'},now));
 t.driverId='d1';const driver={role:'driver',driverId:'d1',name:'Maya'};const dr=RideService.request(s,t,driver,{category:'vehicle_issue'},now);assert.ok(dr.details.includes('dispatch assistance'));assert.equal(D.scoped(s,driver).supportRequests.length,1);
});
test('shared vehicle pending offers cannot be assigned to two drivers',()=>{const now=Date.now(),s=testState(now);s.drivers[1].plate=s.drivers[0].plate;const o=D.offer(s,s.trips[0],'Owner',now);assert.equal(o.driverId,'d1');assert.equal(D.eligible(s,s.trips[1],now).some(x=>x.driver.id==='d2'),false);});
test('scheduled API prevents competing reservation and passenger contact exposure; help and summaries enforce ownership',async t=>{
 const h=await harness(t),a=h.client(),b=h.client(),o=h.client(),c=h.client(),stranger=h.client();await driver(a,'d1');await driver(b,'d2');await owner(o);await customer(c);await customer(stranger,'+15550102999');
 const id=h.load().trips[0].id;h.mutate(s=>{s.trips[0].pickupAt=Date.now()+3*3600000;});
 const list=await a('/api/driver/scheduled');assert.equal(list.status,200);assert.equal(JSON.stringify(list.data).includes('+15550102001'),false);assert.equal(list.data.trips[0].customerName,undefined);
 const results=await Promise.all([a('/api/trips/'+id+'/reserve',{}),b('/api/trips/'+id+'/reserve',{})]);assert.equal(results.filter(r=>r.status===200).length,1);
 assert.equal((await c('/api/trips/'+id+'/reserve',{})).status,403);
 assert.equal((await c('/api/support',{tripId:id,category:'booking_question',details:'Please confirm the pickup'})).status,200);
 assert.equal((await stranger('/api/support',{tripId:id,category:'booking_question',details:'Please confirm the pickup'})).status,400);
 const r=h.load().supportRequests[0];assert.equal((await c('/api/support/'+r.id,{status:'resolved',reply:'Done'})).status,403);
 assert.equal((await o('/api/support/'+r.id,{status:'resolved',reply:'Pickup confirmed'})).status,200);assert.equal((await c('/api/state')).data.state.supportRequests[0].ownerReply,'Pickup confirmed');
 h.mutate(s=>{s.trips[0].status='completed';s.trips[0].completedAt=Date.now();});assert.equal((await c('/api/trips/'+id+'/summary.txt')).status,200);assert.equal((await stranger('/api/trips/'+id+'/summary')).status,400);
});
const Location=require('./location.cjs');
test('device location rejects poor readings, preserves order and cannot spoof another driver',()=>{
 const now=Date.now(),s=testState(now),u={role:'driver',driverId:'d1'};
 const point=(id,capturedAt=now,extra={})=>({id,latitude:40.75,longitude:-73.97,accuracy:10,capturedAt,...extra});
 assert.throws(()=>Location.ingest(s,{role:'owner'},{points:[point('point001')]},now));assert.throws(()=>Location.ingest(s,u,{driverId:'d2',points:[point('point001')]},now));
 const r=Location.ingest(s,u,{points:[point('point002',now),point('point001',now-1000),point('point003',now,{accuracy:400}),point('point004',now-180000),point('point005',now,{latitude:999})]},now);
 assert.deepEqual(r.accepted,['point001','point002']);assert.equal(r.rejected.length,3);assert.equal(s.drivers[0].locationSource,'device');
 assert.equal(Location.ingest(s,u,{points:[point('point002')]},now).accepted.length,0);
 const timestamp=s.drivers[0].lastLocationAt;D.tick(s,now+200000);assert.equal(s.drivers[0].lastLocationAt,timestamp);assert.equal(D.eligible(s,s.trips[0],now).some(x=>x.driver.id==='d1'),false);
});
test('location endpoint is driver-only, binds session identity, and does not refresh device GPS when toggling online',async t=>{
 const h=await harness(t),d=h.client(),o=h.client();await driver(d,'d1');await owner(o);const point={id:'real-point001',latitude:40.75,longitude:-73.97,accuracy:8,capturedAt:Date.now()-1000};
 assert.equal((await o('/api/driver/location',{points:[point]})).status,403);
 assert.equal((await d('/api/driver/location',{points:[point]})).data.accepted.length,1);assert.equal(h.load().drivers[1].locationSource,undefined);
 await d('/api/driver/status',{status:'offline'});assert.equal((await d('/api/driver/location',{points:[point]})).status,400);await d('/api/driver/status',{status:'online'});assert.equal(h.load().drivers[0].lastLocationAt,point.capturedAt);
});
const Review=require('./dispatch-review.cjs');
test('driver selection explanation exactly matches dispatch ranking and identifies skip reasons',()=>{
 const now=Date.now(),s=testState(now),t=s.trips[0];s.drivers[1].status='offline';s.drivers[2].lastLocationAt=now-180000;
 const report=Review.inspect(s,t,now),eligible=D.eligible(s,t,now);
 assert.deepEqual(report.candidates.filter(c=>c.eligible).map(c=>c.driverId),eligible.map(c=>c.driver.id));
 assert.ok(report.candidates.find(c=>c.driverId==='d2').reasons.includes('Offline'));assert.ok(report.candidates.find(c=>c.driverId==='d3').reasons.includes('Fresh location required'));
 const o=D.offer(s,t,'Owner',now);assert.equal(Review.inspect(s,t,now).pending.driverName,s.drivers.find(d=>d.id===o.driverId).name);
});
test('pickup readiness retains overdue trips and distinguishes onboard from late pickup',()=>{
 const now=Date.now(),s=testState(now);s.trips[0].pickupAt=now-1000;s.trips[1].pickupAt=now-1000;s.trips[1].status='onboard';s.trips[1].driverId='d2';
 const report=Review.readiness(s,now);assert.equal(report.rows.find(r=>r.id===s.trips[0].id).level,'attention');assert.equal(report.rows.find(r=>r.id===s.trips[1].id).level,'on_trip');assert.equal(report.counts.attention,1);
});
test('dispatch readiness and candidate diagnostics are restricted to owner',async t=>{
 const h=await harness(t),o=h.client(),d=h.client(),c=h.client();await owner(o);await driver(d,'d1');await customer(c);const id=h.load().trips[0].id;
 assert.equal((await o('/api/operations/readiness')).status,200);assert.equal((await o('/api/trips/'+id+'/dispatch-review')).status,200);
 for(const user of [d,c]){assert.equal((await user('/api/operations/readiness')).status,403);assert.equal((await user('/api/trips/'+id+'/dispatch-review')).status,403);}
});
const Rider=require('./public/rider-view.js');
test('customer live updates withhold a stopped phone GPS fix and end when the session signs out',async t=>{
 const h=await harness(t),phone='+15550102001',driverId='d1';
 h.mutate(s=>{
   Object.assign(s.trips[0],{driverId,status:'accepted'});
   Object.assign(s.drivers[0],{status:'busy',locationSource:'device',trackingEnabled:true,lastLocationAt:Date.now()});
   s.fleetScenario={trails:{anotherDriver:[{lat:1,lng:2}]}};
 });
 const c=h.client(),d=h.client();await driver(d,driverId);
 const {data:{demoCode}}=await c('/api/auth/request-code',{phone});
 const verified=await fetch(h.base+'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,code:demoCode})});
 assert.equal(verified.status,200);
 const headers={Cookie:verified.headers.get('set-cookie').split(';')[0]};
 const events=await fetch(h.base+'/api/events',{headers,signal:AbortSignal.timeout(5000)});
 const stream=events.body.getReader();
 const decoder=new TextDecoder();
 let pending='';
 const nextState=async()=>{
   while(!pending.includes('\n\n')){
     const chunk=await stream.read();
     assert.equal(chunk.done,false);
     pending+=decoder.decode(chunk.value,{stream:true});
   }
   const end=pending.indexOf('\n\n');
   const message=pending.slice(0,end);
   pending=pending.slice(end+2);
   return JSON.parse(message.split('\ndata: ')[1]).state;
 };
 const initial=await nextState();
 assert.ok(Number.isFinite(initial.drivers[0].lat));
 assert.equal(initial.fleetScenario,undefined);
 assert.equal((await d('/api/driver/tracking',{enabled:false})).status,200);
 const stopped=await nextState();
 assert.equal(stopped.drivers[0].lat,undefined);
 assert.equal(Rider.journey(stopped.trips[0],stopped.drivers[0]).location,'unavailable');
 assert.equal((await fetch(h.base+'/api/logout',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,200);
 assert.equal((await stream.read()).done,true);
});
test('customer journey never labels accepted driver as en route or fabricates live tracking from stale GPS',()=>{const now=Date.now(),s=testState(now),t=s.trips[0],d=s.drivers[0];t.driverId=d.id;t.status='accepted';t.pickupAt=now-60000;const a=Rider.journey(t,d,now);assert.equal(a.title,'Driver confirmed');assert.equal(a.source,'simulated');assert.equal(a.late,true);assert.equal(Rider.journey(t,{...d,lastLocationAt:now-180000},now).location,'unavailable');t.status='onboard';assert.equal(Rider.journey(t,d,now).late,false);t.driverId=null;assert.equal(Rider.journey(t,d,now).location,'unavailable');});
test('phone tracking consent clears sample coordinates, preserves device readings and stops accepting after stop',async t=>{
 const h=await harness(t),c=h.client(),o=h.client();await driver(c,'d1');await owner(o);
 assert.equal((await o('/api/driver/tracking',{enabled:true})).status,403);
 assert.equal((await c('/api/driver/tracking',{enabled:true})).status,200);let d=h.load().drivers[0];assert.equal(d.lat,null);assert.equal(d.lastLocationAt,0);assert.equal(d.locationSource,'device');
 const now=Date.now(),point={id:'phone-reading-001',latitude:40.758,longitude:-73.985,accuracy:9,capturedAt:now};assert.equal((await c('/api/driver/location',{points:[point]})).data.accepted.length,1);
 h.mutate(s=>D.tick(s,now+60000));d=h.load().drivers[0];assert.equal(d.lat,point.latitude);assert.equal(d.lastLocationAt,now);
 assert.equal((await c('/api/driver/tracking',{enabled:false})).status,200);assert.equal((await c('/api/driver/location',{points:[{...point,id:'phone-reading-002',capturedAt:now+1}]})).status,400);assert.equal(Board.fleet(h.load(),now).find(i=>i.driver.id==='d1').status,'stale');
 assert.equal((await o('/leaflet.js')).status,200);assert.equal((await o('/leaflet.css')).status,200);
});
const TrackingReplay=require('./tracking-replay.cjs');
test('coordinate replay moves through location ingestion, pauses, resumes and cannot enter normal dispatch',()=>{
 const now=Date.now(),s=testState(now);TrackingReplay.start(s,now);const first=s.drivers.find(d=>d.id===TrackingReplay.DRIVER);assert.equal(first.locationSource,'replay');const firstLat=first.lat;
 D.tick(s,now+3000);assert.equal(first.lat,firstLat);assert.equal(first.lastLocationAt,now);TrackingReplay.tick(s,now+3000);assert.notEqual(first.lat,firstLat);assert.equal(first.lastLocationAt,now+3000);assert.equal(s.trackingReplay.trail.length,2);
 assert.equal(D.eligible(s,s.trips[0],now+3000).some(x=>x.driver.id===first.id),false);
 TrackingReplay.control(s,'pause',now+4000);const paused=first.lat;assert.equal(TrackingReplay.tick(s,now+20000),false);assert.equal(first.lat,paused);TrackingReplay.control(s,'resume',now+24000);TrackingReplay.tick(s,now+27000);assert.ok(s.trackingReplay.progress<.1);
 TrackingReplay.tick(s,now+200000);assert.equal(s.trackingReplay.status,'finished');assert.equal(first.lat,TrackingReplay.route.at(-1).lat);assert.equal(first.lng,TrackingReplay.route.at(-1).lng);TrackingReplay.control(s,'stop',now+201000);assert.equal(first.status,'offline');
});
test('tracking replay API is owner-only and restart reuses one dedicated synthetic driver',async t=>{
 const h=await harness(t),o=h.client(),d=h.client();await owner(o);await driver(d,'d1');assert.equal((await d('/api/demo/tracking-replay',{action:'start'})).status,403);
 assert.equal((await o('/api/demo/tracking-replay',{action:'start'})).status,200);assert.equal((await o('/api/demo/tracking-replay',{action:'start'})).status,200);assert.equal(h.load().drivers.filter(d=>d.id===TrackingReplay.DRIVER).length,1);assert.equal((await o('/api/demo/tracking-replay',{action:'pause'})).data.status,'paused');assert.equal((await o('/api/demo/tracking-replay',{action:'resume'})).data.status,'running');
});
const RideExplanation=require('./public/ride-explanation.js');
test('ride explanations cover stages, provisional reservations and overdue pickups without claiming assignment early',()=>{
 const now=Date.now(),s=testState(now),t=s.trips[0];t.pickupAt=now+120*60000;t.reservedDriverId='d1';t.reservedDriverName='Maya';let r=RideExplanation.explain(s,t,'customer',now);assert.match(r.title,/provisionally/);assert.equal(r.assignedName,null);assert.match(r.meaning,/acceptance/);
 t.reservedDriverId=null;for(const status of ['awaiting_driver','needs_reassignment','accepted','heading_to_pickup','arrived','onboard','completed','cancelled']){t.status=status;const e=RideExplanation.explain(s,t,'owner',now);assert.ok(e.title&&e.meaning&&e.next);}
 t.status='accepted';t.driverId='d1';t.pickupAt=now-1000;r=RideExplanation.explain(s,t,'owner',now);assert.equal(r.late,true);assert.match(r.meaning,/not marked departure/);assert.match(r.next,/Check this pickup now/);
 t.status='onboard';assert.equal(RideExplanation.explain(s,t,'customer',now).late,false);
});
test('Charlotte is the configured default and replay route stays within Charlotte',async t=>{
 const h=await harness(t),c=h.client();const config=(await c('/api/config')).data;assert.equal(config.map.city,'Charlotte, NC');assert.ok(config.map.center[0]>35&&config.map.center[0]<36);assert.ok(config.map.center[1]<-80&&config.map.center[1]>-81);
 for(const p of TrackingReplay.route){assert.ok(p.lat>35&&p.lat<36&&p.lng>-81&&p.lng<-80);}
});
const CharlotteFleet=require('./charlotte-fleet.cjs');
test('Charlotte multi-car scenario assigns nearest eligible cars, completes all rides and reuses freed drivers',()=>{
 const now=Date.now(),s=testState(now),ordinary=s.trips[0].status;CharlotteFleet.start(s,now);const run=s.fleetScenario;
 assert.equal(run.driverIds.length,4);assert.equal(run.tripIds.length,6);let pending=s.offers.filter(o=>run.tripIds.includes(o.tripId)&&o.status==='pending');assert.equal(pending.length,4);assert.equal(new Set(pending.map(o=>o.driverId)).size,4);
 for(const o of pending){const t=s.trips.find(t=>t.id===o.tripId);assert.equal(t.demoCandidateRanking[0].driverId,o.driverId);}
 for(let i=1;i<=90;i++)CharlotteFleet.tick(s,now+i*3000);
 const trips=s.trips.filter(t=>run.tripIds.includes(t.id));assert.ok(trips.every(t=>t.status==='completed'));assert.equal(run.status,'finished');assert.ok(run.driverIds.some(id=>trips.filter(t=>t.driverId===id).length>1));assert.equal(s.trips[0].status,ordinary);
 for(const t of trips){assert.ok(t.startedAt&&t.completedAt);assert.ok(s.events.some(e=>e.tripId===t.id&&e.type==='trip.arrived'));assert.ok(t.confirmedDriver);}
 assert.ok(Object.values(run.trails).every(points=>points.length>5));assert.ok(run.driverIds.every(id=>s.drivers.find(d=>d.id===id).locationSource==='scenario'));
});
test('Charlotte scenario API is owner-only; restarting closes only its own synthetic work',async t=>{
 const h=await harness(t),o=h.client(),d=h.client();await owner(o);await driver(d,'d1');assert.equal((await d('/api/demo/charlotte-fleet',{action:'start'})).status,403);
 assert.equal((await o('/api/demo/charlotte-fleet',{action:'start'})).status,200);const old=h.load().fleetScenario.runId;assert.equal((await o('/api/demo/charlotte-fleet',{action:'start'})).status,200);const s=h.load();assert.notEqual(s.fleetScenario.runId,old);assert.ok(s.trips.filter(t=>t.demoRunId===old).every(t=>t.status==='cancelled'));assert.equal(s.trips.find(t=>t.reference==='PL-1001').status,'awaiting_driver');
});

test('urgent recovery offers to three drivers; declining one preserves others and acceptance closes competitors',()=>{
 const now=Date.now(),{s,trip}=sequentialFixture(now,5);trip.pickupAt=now+5*60000;D.tick(s,now);const first=s.offers[0];
 D.action(s,trip,'decline',{role:'driver',driverId:first.driverId,name:'Driver'},{offerId:first.id,reason:'On a break'},now+1000);
 let pending=s.offers.filter(o=>o.status==='pending');assert.equal(pending.length,3);assert.ok(pending.every(o=>o.mode==='urgent_group'));
 const decline=pending[0];D.action(s,trip,'decline',{role:'driver',driverId:decline.driverId,name:'Driver'},{offerId:decline.id,reason:'On a break'},now+2000);assert.equal(trip.status,'offered');
 pending=s.offers.filter(o=>o.status==='pending');const winner=pending[0],loser=pending[1];D.action(s,trip,'accept',{role:'driver',driverId:winner.driverId,name:'Winner'},{offerId:winner.id},now+3000);
 assert.equal(trip.driverId,winner.driverId);assert.equal(loser.status,'taken');assert.throws(()=>D.action(s,trip,'accept',{role:'driver',driverId:loser.driverId,name:'Late'},{offerId:loser.id},now+3001),/no longer/);
 assert.deepEqual(D.scoped(s,{role:'driver',driverId:loser.driverId}).offerUpdates,[{id:loser.id,status:'taken'}]);
});
test('manual driver selection requires owner, reason, suitable availability and an unconfirmed ride',()=>{
 const now=Date.now(),{s,trip}=sequentialFixture(now);D.tick(s,now);const old=s.offers[0],owner={role:'owner',name:'Owner'},body={driverId:'rank-2',reason:'Owner reviewed availability'};
 assert.throws(()=>D.action(s,trip,'manual_offer',{role:'driver'},body,now),/Owner/);
 assert.throws(()=>D.action(s,trip,'manual_offer',owner,{...body,reason:'free text'},now),/listed/);
 s.drivers[1].status='offline';assert.throws(()=>D.action(s,trip,'manual_offer',owner,body,now),/unavailable/);assert.equal(old.status,'pending');s.drivers[1].status='online';
 const selected=D.action(s,trip,'manual_offer',owner,body,now);assert.equal(selected.driverId,'rank-2');assert.equal(selected.mode,'manual');assert.equal(old.status,'replaced_by_owner');
 D.action(s,trip,'accept',{role:'driver',driverId:'rank-2',name:'Driver'}, {offerId:selected.id},now);assert.throws(()=>D.action(s,trip,'manual_offer',owner,body,now),/unconfirmed/);
});
test('group offers expire cleanly and urgency settings reject oversized broadcasts',()=>{
 const now=Date.now(),{s,trip}=sequentialFixture(now);s.settings.urgentGroupSize=2;
 D.action(s,trip,'group_offer',{role:'owner',name:'Owner'},{reason:'Urgent pickup'},now);assert.equal(s.offers.length,2);D.tick(s,now+46000);assert.equal(s.offers.filter(o=>o.status==='expired').length,2);assert.equal(s.offers.filter(o=>o.status==='pending').length,1);
 assert.throws(()=>Operations.validateSettings({...s.settings,urgentGroupSize:100}),/group of 2 or 3/);
});

const SharedPlanner=require('./shared-planner.cjs'),VehiclePlanner=require('./vehicle-planner.cjs');
function sharedFixture(now){
 const s=testState(now),base=s.trips[0],spots=require('./charlotte-fleet.cjs').spots;
 s.offers=[];s.reservations=[];s.drivers=[{id:'small',name:'Four Seat',seats:4,status:'online',capabilities:[],vehicle:'Sedan',plate:'TEST4',phone:'+15550101001',lat:spots[0].lat,lng:spots[0].lng,lastLocationAt:now},{id:'large',name:'Seven Seat',seats:7,status:'online',capabilities:[],vehicle:'Van',plate:'TEST7',phone:'+15550101002',lat:spots[0].lat,lng:spots[0].lng,lastLocationAt:now}];
 s.trips=[2,2,3].map((passengers,i)=>({...base,id:'shared-booking-'+i,reference:'BOOK-'+i,customerPhone:'+1555010200'+i,pickup:spots[0].name,destination:spots[1].name,pickupAt:now+(10+i*2)*60000,passengers,excluded:[],requirements:[],autoDispatch:false}));return s;
}
test('driver day favors a feasible regular driver, previews fallback, and saves only the selected driver and date', () => {
  const DriverDay = require('./driver-day.cjs');
  const now = Date.parse('2026-11-08T13:00:00Z');
  const state = sharedFixture(now);
  const [first, second, tomorrow] = state.trips;
  first.passengers = second.passengers = 4;
  state.drivers[1].lng += .01;
  tomorrow.pickupAt = now + 30 * 3600000;
  state.customerPreferences = Object.fromEntries(state.trips.map(t => ['ordinary:' + t.customerPhone, {driverId:'large'}]));
  const input = { driverId:'large', date:'2026-11-08', action:'preview' };
  const preview = DriverDay.view(state, input, now);
  assert.equal(preview.proposedCount, 1);
  assert.deepEqual(preview.rows.map(r => [r.reference,r.status]), [[first.reference,'proposed'],[second.reference,'fallback']]);
  assert.match(preview.rows[1].note,/Four Seat/);
  assert.equal(first.plannedDriverId, undefined);
  assert.throws(() => DriverDay.save(state, { ...input,previewKey:'wrong' }, 'Owner', now), { status:409 });
  const saved = DriverDay.save(state, { ...input,previewKey:preview.previewKey }, 'Owner', now);
  assert.equal(first.plannedDriverId, 'large');
  assert.equal(second.plannedDriverId, undefined);
  assert.equal(tomorrow.plannedDriverId, undefined);
  assert.equal(saved.rows[0].status, 'planned');
  assert.equal(DriverDay.view(state, { ...input,date:'2026-11-09' }, now).proposedCount, 1);
  assert.throws(() => DriverDay.save(state, { ...input,previewKey:preview.previewKey }, 'Owner', now), { status:409 });
});
test('fleet day plans morning through evening across drivers and accounts for runs still left', () => {
  const DriverDay = require('./driver-day.cjs');
  const now = Date.parse('2026-11-08T10:00:00Z');
  const state = sharedFixture(now);
  const template = state.trips[0];
  const drivers = [state.drivers[0],state.drivers[1],{ ...state.drivers[0],id:'accessible',name:'Accessible Car',
    plate:'TEST-ACCESS',capabilities:['wheelchair'] }];
  state.drivers = drivers;
  state.trips = [];
  state.customerPreferences = {};
  for (let hour = 7; hour <= 22; hour++) {
    for (const [index, driver] of drivers.entries()) {
      const ref = 'DAY-' + hour + '-' + index;
      const phone = '+1555010' + String(3000 + index);
      state.customerPreferences['ordinary:'+phone] = {driverId:driver.id};
      state.trips.push({ ...template,id:ref,reference:ref,customerPhone:phone,passengers:1,
        requirements:driver.capabilities,pickupAt:now+(hour-5)*3600000 });
    }
  }
  const left = { ...template,id:'left',reference:'LEFT',passengers:7,requirements:['wheelchair'],pickupAt:now+8*3600000 };
  const done = { ...template,id:'done',reference:'DONE',status:'completed',driverId:'small',pickupAt:now-60000 };
  const confirmed = { ...template,id:'confirmed',reference:'CONFIRMED',status:'accepted',driverId:'large',pickupAt:now+3600000 };
  state.trips.push(left,done,confirmed);
  const input = { action:'preview',scope:'fleet',driverId:'small',date:'2026-11-08' };
  const preview = DriverDay.view(state,input,now);
  assert.equal(preview.fleet.proposed,48);
  assert.deepEqual(preview.fleet.left.map(row=>row.reference),['LEFT']);
  assert.equal(preview.rows.filter(row=>row.status==='proposed').length,16);
  const saved = DriverDay.save(state,{...input,previewKey:preview.previewKey},'Owner',now);
  assert.equal(saved.fleet.drivers.reduce((n,d)=>n+d.tentative,0),48);
  assert.equal(saved.fleet.drivers.reduce((n,d)=>n+d.assigned,0),2);
  assert.equal(saved.fleet.drivers.reduce((n,d)=>n+d.completed,0),1);
  assert.equal(saved.fleet.drivers.reduce((n,d)=>n+d.remaining,0),49);
  assert.equal(saved.fleet.left.length,1);
  for (const driver of drivers) {
    const day = DriverDay.view(state,{...input,action:'view',driverId:driver.id},now);
    assert.equal(day.rows.filter(row=>row.status==='planned').length,16);
    assert.equal(day.rows.filter(row=>row.conflict).length,0);
  }
});
test('shared planning combines seven passengers in a seven-seat car and never overloads four seats',()=>{
 const now=Date.now(),s=sharedFixture(now),p=SharedPlanner.build(s,D.places,now);assert.equal(p.summary.bookings,3);assert.equal(p.cars.length,1);assert.equal(p.cars[0].driverId,'large');assert.equal(p.cars[0].stops[0].passengers,7);assert.equal(p.cars[0].stops[0].sharedStops.length,3);
 for(const c of p.cars)for(const run of c.stops)assert.ok(run.passengers<=c.seats);
});
test('shared run completes each pickup before drop-off, scopes customers and frees the car',()=>{
 const now=Date.now(),s=sharedFixture(now),p=SharedPlanner.build(s,D.places,now);SharedPlanner.apply(s,p,'Owner',now);const parent=s.trips.find(t=>t.isSharedRun);assert.ok(parent);assert.ok(s.trips.filter(t=>t.poolParentId).every(t=>t.status==='pooled'));
 const offer=D.offer(s,parent,'Owner',now),u={role:'driver',driverId:offer.driverId,name:'Seven Seat'};D.action(s,parent,'accept',u,{offerId:offer.id},now);
 assert.equal(D.scoped(s,u).trips.length,1);const customer=D.scoped(s,{role:'customer',phone:s.trips[0].customerPhone});assert.equal(customer.trips.length,1);assert.equal(customer.trips[0].id,s.trips[0].id);assert.equal(customer.vehiclePlan,undefined);assert.ok(!JSON.stringify(customer).includes(s.trips[1].customerPhone));
 D.action(s,parent,'depart',u,{},now);for(let i=0;i<3;i++){D.action(s,parent,'arrive',u,{},now);D.action(s,parent,'pickup',u,{},now);assert.equal(s.trips[i].status,'onboard');if(i<2){assert.equal(parent.status,'heading_to_pickup');assert.throws(()=>D.action(s,parent,'release',u,{reason:'Vehicle issue'},now),/onboard/);assert.throws(()=>D.action(s,parent,'complete',u,{},now),/transition/);}}
 assert.equal(parent.status,'onboard');D.action(s,parent,'complete',u,{},now+1000);assert.ok(s.trips.every(t=>t.status==='completed'));assert.equal(s.drivers.find(d=>d.id===u.driverId).status,'online');assert.equal(Operations.reports(s,{from:0,to:now+86400000}).summary.completedTrips,3);
});
test('shared planning keeps different destinations separate, reuses cars and rejects stale positions',()=>{
 const now=Date.now(),s=sharedFixture(now);s.trips[1].destination=D.places[0].name;s.trips[2].pickupAt=now+90*60000;
 const p=SharedPlanner.build(s,D.places,now);for(const c of p.cars)for(const run of c.stops)assert.equal(run.members.length,1);
 s.drivers.forEach(d=>d.lastLocationAt=now-121000);assert.equal(SharedPlanner.build(s,D.places,now).summary.bookings,0);
 const r=sharedFixture(now);r.drivers=[r.drivers[1]];r.trips[2].pickupAt=now+90*60000;const chain=SharedPlanner.build(r,D.places,now);assert.equal(chain.cars.length,1);assert.equal(chain.cars[0].stops.length,2);
});
test('seven-passenger booking validation and owner-only capacity/planning endpoints',async t=>{
 const now=Date.now(),s=sharedFixture(now),rows=D.validateRows(s,[{trip_id:'SEVEN',pickup_at:new Date(now+600000).toISOString(),customer_name:'Group',customer_phone:'+15550102001',pickup:s.trips[0].pickup,destination:s.trips[0].destination,passengers:'7',requirements:''}],now);assert.deepEqual(rows[0].errors,[]);
 const h=await harness(t,{clock:()=>now}),o=h.client(),c=h.client();await owner(o);await customer(c);h.mutate(state=>Object.assign(state,sharedFixture(now)));
 assert.equal((await c('/api/vehicle-plan',{action:'apply'})).status,403);assert.equal((await c('/api/vehicle-capacity',{driverId:'small',seats:7})).status,403);
 assert.equal((await o('/api/vehicle-capacity',{driverId:'small',seats:5})).status,400);assert.equal((await o('/api/vehicle-plan',{action:'preview'})).data.summary.bookings,3);
 const applied=await o('/api/vehicle-plan',{action:'apply'});assert.equal(applied.status,200);assert.equal(h.load().trips.filter(t=>t.isSharedRun).length,1);assert.equal((await o('/api/vehicle-plan',{action:'apply'})).status,200);assert.equal(h.load().trips.filter(t=>t.isSharedRun).length,1);
});

test('owner can split an unaccepted shared run without losing bookings or leaving offers open',()=>{
 const now=Date.now(),s=sharedFixture(now),p=SharedPlanner.build(s,D.places,now);SharedPlanner.apply(s,p,'Owner',now);const parent=s.trips.find(t=>t.isSharedRun);D.offer(s,parent,'Owner',now);D.action(s,parent,'unpool',{role:'owner',name:'Owner'},{},now);assert.equal(parent.status,'cancelled');assert.equal(s.offers.filter(o=>o.status==='pending').length,0);assert.ok(s.trips.filter(t=>!t.isSharedRun).every(t=>!t.poolParentId&&t.status==='awaiting_driver'&&t.autoDispatch));
});
test('shared demo is owner-only and repeated clicks do not duplicate test bookings',async t=>{
 const h=await harness(t),o=h.client(),c=h.client();await owner(o);await customer(c);assert.equal((await c('/api/demo/shared-plan',{})).status,403);const a=await o('/api/demo/shared-plan',{}),b=await o('/api/demo/shared-plan',{});assert.equal(a.status,200);assert.equal(a.data.runId,b.data.runId);const preview=await o('/api/vehicle-plan',{action:'preview'});const car=preview.data.cars.find(c=>c.driverId===a.data.driverIds[1]);assert.ok(car);assert.equal(car.seats,7);assert.ok(car.stops.some(t=>t.passengers===7&&t.members.length===3));
});

test('four-seat-only fleet groups four compatible passengers instead of designing a seven-seat run',()=>{
 const now=Date.now(),s=sharedFixture(now);s.drivers=[s.drivers[0]];const p=SharedPlanner.build(s,D.places,now);assert.equal(p.cars[0].seats,4);assert.equal(p.cars[0].stops[0].passengers,4);assert.equal(p.cars[0].stops[0].members.length,2);assert.ok(p.unplanned.length);
});

test('priority window keeps current rides, overdue pickups and next-hour boundary ahead of later and closed rides',()=>{
 const now=Date.parse('2026-10-31T03:30:00Z'),row=(id,status,offset,extra={})=>({id,reference:id,status,pickupAt:now+offset,customerName:id,pickup:'A',destination:'B',...extra});
 const trips=[row('LATER','awaiting_driver',3600001),row('DONE','completed',-7200000),row('HOUR','awaiting_driver',3600000),row('NOW','awaiting_driver',0),row('LATE','awaiting_driver',-1),row('ACTIVE','onboard',-7200000,{driverId:'d1'}),row('CHILD','pooled',60000,{poolParentId:'parent'})];
 assert.equal(Board.priority(trips[0],now),'later');assert.equal(Board.priority(trips[2],now),'hour');assert.equal(Board.priority(trips[4],now),'overdue');assert.equal(Board.priority(trips[5],now),'current');
 assert.deepEqual(Board.schedule(trips,{now,period:'priority'}).rows.map(t=>t.id),['ACTIVE','LATE','NOW','HOUR']);
 assert.deepEqual(Board.select(trips.filter(t=>!t.poolParentId),{now}).rows.map(t=>t.id),['ACTIVE','LATE','NOW','HOUR','LATER','DONE']);
 assert.equal(Board.priority(trips[0],now+1),'hour');assert.equal(Board.schedule(trips,{now,period:'priority',search:'HOUR'}).total,1);
});
test('priority results paginate a large due queue without dropping rows',()=>{
 const now=Date.now(),trips=Array.from({length:500},(_,i)=>({id:'due'+i,reference:'due'+i,status:'awaiting_driver',pickupAt:now+i*1000}));const last=Board.schedule(trips,{now,period:'priority',page:20});assert.equal(last.total,500);assert.equal(last.rows.length,25);assert.equal(last.pages,20);
});

test('map priorities group shared locations, filter urgency and separate fleet data',()=>{
 const now=Date.now(),places=[{name:'Pickup',lat:35.22,lng:-80.84},{name:'Drop',lat:35.23,lng:-80.83}],trip=(id,status,at,extra={})=>({id,reference:id,status,pickupAt:at,pickup:'Pickup',destination:'Drop',...extra});
 const s={trips:[trip('hour','awaiting_driver',now+3600000),trip('overdue','awaiting_driver',now-1000),trip('active','onboard',now-2000,{driverId:'d'}),trip('child','pooled',now,{poolParentId:'parent'}),trip('closed','completed',now),trip('other','awaiting_driver',now,{demoRunId:'other'}),trip('missing','awaiting_driver',now,{pickup:'Unknown'})]};
 const result=Board.mapPriorities(s,places,[{id:'d'}],now);assert.deepEqual(result.counts,{current:1,hour:2,overdue:1});assert.equal(result.groups.length,3);assert.equal(result.groups[0].rides.length,1);assert.equal(result.groups[0].kind,'hour');assert.equal(result.groups[0].offset,'left');assert.equal(result.groups[1].kind,'overdue');assert.equal(result.groups[1].offset,'right');assert.equal(result.groups[2].name,'Drop');assert.equal(result.groups[2].rides[0].target,'Drop-off');assert.deepEqual(result.missing,['missing']);
 const hour=Board.mapPriorities(s,places,[{id:'d'}],now,'hour');assert.equal(hour.groups.length,1);assert.equal(hour.groups[0].rides.length,1);assert.equal(hour.groups[0].kind,'hour');assert.equal(Board.mapPriorities(s,places,[{demoRunId:'other'}],now).total,1);
});

test('hybrid queue map filters show current and upcoming together, later separately, and future flags in attention',()=>{
 const now=Date.now(),places=[{name:'A',lat:35.22,lng:-80.84},{name:'B',lat:35.23,lng:-80.83}],s={trips:[{id:'active',status:'onboard',driverId:'d',pickupAt:now-1000,pickup:'A',destination:'B'},{id:'soon',status:'awaiting_driver',pickupAt:now+60000,pickup:'A',destination:'B'},{id:'late',status:'awaiting_driver',pickupAt:now-60000,pickup:'A',destination:'B'},{id:'future',status:'awaiting_driver',pickupAt:now+7200000,pickup:'A',destination:'B',redFlag:true}]};
 const ids=filter=>Board.mapPriorities(s,places,[{id:'d'}],now,filter).groups.flatMap(g=>g.rides.map(t=>t.id)).sort();assert.deepEqual(ids('now'),['active','soon']);assert.deepEqual(ids('later'),['future']);assert.deepEqual(ids('attention'),['future','late']);
});

test('owner recovery offers an overdue ride now without changing its pickup time or forcing acceptance',()=>{
 const now=Date.now(),{s,trip}=sequentialFixture(now),original=now-3600000;trip.pickupAt=original;trip.excluded=['rank-1','rank-2'];s.drivers[1].status='busy';
 assert.equal(D.eligible(s,trip,now).length,0);const preview=D.recoveryTrip(s,trip,null,now);assert.equal(trip.recoveryUntil,undefined);assert.equal(D.eligibility(s,preview,now).find(x=>x.driver.id==='rank-1').eligible,true);assert.equal(D.eligibility(s,preview,now).find(x=>x.driver.id==='rank-2').eligible,false);
 const body={driverId:'rank-1',recovery:true,reason:'Owner reviewed availability'};assert.throws(()=>D.action(s,trip,'manual_offer',{role:'driver'},body,now),/Owner/);const o=D.action(s,trip,'manual_offer',{role:'owner',name:'Owner'},body,now);assert.equal(o.driverId,'rank-1');assert.equal(trip.pickupAt,original);assert.equal(trip.driverId,null);assert.equal(trip.status,'offered');assert.ok(s.events.some(e=>e.type==='dispatch.recovery_reviewed'));
 D.action(s,trip,'accept',{role:'driver',driverId:'rank-1',name:'Driver'},{offerId:o.id},now+1000);assert.equal(trip.driverId,'rank-1');assert.equal(trip.pickupAt,original);
});
test('recovery excludes dropped drivers, rejects new busy state and cannot accept expired offers',()=>{
 const now=Date.now(),{s,trip}=sequentialFixture(now);trip.pickupAt=now-3600000;trip.droppedDrivers=['rank-1'];trip.excluded=['rank-1','rank-2'];const owner={role:'owner',name:'Owner'},body={recovery:true,reason:'Owner reviewed availability'};
 assert.throws(()=>D.action(s,trip,'manual_offer',owner,{...body,driverId:'rank-1'},now),/unavailable/);s.drivers[1].status='busy';assert.throws(()=>D.action(s,trip,'manual_offer',owner,{...body,driverId:'rank-2'},now),/unavailable/);s.drivers[1].status='online';const o=D.action(s,trip,'manual_offer',owner,{...body,driverId:'rank-2'},now);assert.throws(()=>D.action(s,trip,'accept',{role:'driver',driverId:'rank-2'},{offerId:o.id},now+45001),/no longer/);assert.equal(D.eligibility(s,trip,now+45001,o.id).find(c=>c.driver.id==='rank-2').eligible,false);
});
test('quick assignment review ranks recovery choices and calculates each arrival without changing the pickup',async t=>{
 const now=Date.now(),h=await harness(t,{clock:()=>now}),o=h.client();await owner(o);
 let id;
 const pickupAt=now-3600000;
 h.mutate(s=>{const f=sequentialFixture(now);f.trip.pickupAt=pickupAt;f.trip.excluded=['rank-1'];Object.assign(s,f.s);id=f.trip.id;});
 const review=await o('/api/trips/'+id+'/dispatch-review');
 assert.equal(review.status,200);
 const [nearest,alternative]=review.data.recoveryCandidates.filter(c=>c.eligible);
 assert.equal(nearest.driverId,'rank-1');
 assert.ok(nearest.eta<=alternative.eta);
 for(const choice of [nearest,alternative]) assert.equal(choice.arrivalAt,now+choice.eta*60000);
 const body={driverId:alternative.driverId,recovery:true,reason:'Owner reviewed availability'},key=crypto.randomUUID();
 assert.equal((await action(o,id,'manual_offer',body,key)).status,200);
 assert.equal((await action(o,id,'manual_offer',body,key)).status,200);
 const updated=h.load();
 assert.equal(updated.offers.length,1);
 assert.equal(updated.offers[0].driverId,alternative.driverId);
 assert.equal(updated.trips[0].pickupAt,pickupAt);
 assert.equal(updated.trips[0].driverId,null);
});

test('manual recovery offers continue by ETA after a decline or a 45-second timeout',()=>{
 for(const outcome of ['declined','expired']){
  const now=Date.now(),{s,trip}=sequentialFixture(now);
  const pickupAt=trip.pickupAt=now-12*60000;
  trip.redFlag=true;
  trip.status='needs_reassignment';
  const first=D.action(s,trip,'manual_offer',{role:'owner',name:'Dispatch'},{driverId:'rank-2',recovery:true,reason:'Owner reviewed availability'},now);
  if(outcome==='declined') D.action(s,trip,'decline',{role:'driver',driverId:'rank-2',name:'First driver'},{offerId:first.id,reason:'On a break'},now+1000);
  else {
   D.tick(s,first.expiresAt-1);
   assert.equal(s.offers.length,1);
   D.tick(s,first.expiresAt+2000);
  }
  assert.equal(first.status,outcome);
  const next=s.offers.at(-1);
  assert.equal(s.offers.filter(o=>o.status==='pending').length,1);
  assert.equal(next.mode,'recovery_sequential');
  assert.equal(next.driverId,'rank-1');
  assert.equal(next.expiresAt-next.offeredAt,45000);
  assert.equal(trip.pickupAt,pickupAt);
  assert.equal(trip.driverId,null);
  D.action(s,trip,'accept',{role:'driver',driverId:next.driverId,name:'Next driver'},{offerId:next.id},next.expiresAt-1);
  assert.equal(trip.driverId,next.driverId);
  assert.equal(trip.recoveryUntil,0);
 }
});

test('dispatch queue labels distinguish scheduled, searching, awaiting reply and missed pickups',()=>{
 const now=Date.now(),s=testState(now),t=s.trips[0];t.autoDispatch=true;t.pickupAt=now+100*60000;assert.equal(Board.dispatchLabel(s,t,now).label,'Scheduled');t.pickupAt=now+10*60000;assert.equal(Board.dispatchLabel(s,t,now).label,'Searching automatically');const o=D.offer(s,t,'Automatic dispatch',now);assert.match(Board.dispatchLabel(s,t,now).label,/Waiting:/);o.status='expired';t.pickupAt=now-600000;assert.equal(Board.dispatchLabel(s,t,now).label,'Pickup missed · review');assert.equal(t.pickupAt,now-600000);
});
test('owner receives dispatch worker health while customer and driver do not',async t=>{
 const h=await harness(t,{automaticDispatch:true}),o=h.client(),c=h.client(),d=h.client();await owner(o);await customer(c);await driver(d,'d1');const state=(await o('/api/state')).data.state;assert.equal(state.dispatchHealth.intervalSeconds,3);assert.ok(state.dispatchHealth.lastSuccessAt);assert.equal((await c('/api/state')).data.state.dispatchHealth,undefined);assert.equal((await d('/api/state')).data.state.dispatchHealth,undefined);
});

test('queued due ride explains that suitable cars are occupied instead of claiming no fleet exists',()=>{
 const now=Date.now(),s=testState(now),t=s.trips[0];t.autoDispatch=true;t.pickupAt=now+600000;s.drivers.forEach(d=>d.status='busy');t.dispatchError='No eligible driver';assert.equal(Board.dispatchLabel(s,t,now).label,'Waiting for a free car');s.drivers.forEach(d=>d.status='offline');assert.equal(Board.dispatchLabel(s,t,now).label,'No eligible driver');
});

const VolumeDemo=require('./volume-demo.cjs');
test('500-trip dataset is isolated, idempotent and contains capacity-correct historical and active assignments',()=>{
 const now=Date.now(),s=testState(now),before=JSON.stringify(s.trips),demo=VolumeDemo.seed(s,now),trips=s.trips.filter(t=>t.demoRunId===demo.runId);assert.equal(trips.length,500);assert.equal(s.drivers.filter(d=>d.demoRunId===demo.runId).length,20);assert.equal(trips.filter(t=>t.status==='completed').length,100);assert.equal(trips.filter(t=>t.status==='cancelled').length,50);assert.equal(trips.filter(t=>t.driverId&&!['completed','cancelled'].includes(t.status)).length,10);assert.equal(JSON.stringify(s.trips.filter(t=>t.demoRunId!==demo.runId)),before);for(const t of trips.filter(t=>t.driverId)){const d=s.drivers.find(d=>d.id===t.driverId);assert.ok(t.passengers<=d.seats);assert.equal(d.demoRunId,demo.runId);}assert.equal(VolumeDemo.seed(s,now).runId,demo.runId);assert.equal(s.trips.filter(t=>t.demoRunId===demo.runId).length,500);assert.equal(D.scoped(s,{role:'customer',phone:'+15550102001'}).volumeDemo,undefined);
});
test('indexed 500-trip API is owner-only, searches and paginates all rows without duplication',async t=>{
 const now=Date.now(),h=await harness(t,{clock:()=>now}),o=h.client(),c=h.client();await owner(o);await customer(c);assert.equal((await c('/api/demo/volume',{})).status,403);assert.equal((await c('/api/demo/volume')).status,403);const seeded=await o('/api/demo/volume',{});assert.equal(seeded.status,200);const again=await o('/api/demo/volume',{});assert.equal(again.data.runId,seeded.data.runId);const seen=new Set();for(let page=1;page<=20;page++){const r=await o('/api/demo/volume?page='+page);assert.equal(r.data.total,500);assert.equal(r.data.rows.length,25);for(const row of r.data.rows){assert.ok(!seen.has(row.id));seen.add(row.id);}}assert.equal(seen.size,500);const search=await o('/api/demo/volume?search=LOAD-0500');assert.equal(search.data.total,1);assert.equal(search.data.rows[0].reference,'LOAD-0500');const completed=await o('/api/demo/volume?status=completed');assert.equal(completed.data.total,100);assert.ok(completed.data.rows.every(t=>t.status==='completed'));assert.equal((await o('/api/demo/volume?page=999')).data.page,20);
});
test('trip SQL projection persists 500 records across reopen and stays aligned with a committed status change',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prolift-volume-')),dbPath=path.join(dir,'volume.sqlite'),now=Date.now();let app=createApp({dbPath,clock:()=>now,automaticDispatch:false});try{let run;app.mutate(s=>{run=VolumeDemo.seed(s,now).runId;s.trips.find(t=>t.reference==='LOAD-0500').status='cancelled';});app.close();app=createApp({dbPath,clock:()=>now,automaticDispatch:false});const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(dbPath,{readOnly:true});try{assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM trip_records WHERE dataset_id=?').get(run).n),500);assert.equal(db.prepare('SELECT status FROM trip_records WHERE reference=?').get('LOAD-0500').status,'cancelled');assert.ok(db.prepare('PRAGMA index_list(trip_records)').all().some(x=>x.name==='trip_records_dataset_time'));assert.equal(app.load().trips.filter(t=>t.demoRunId===run).length,500);}finally{db.close();}}finally{app.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('prolift-volume-'));fs.rmSync(resolved,{recursive:true,force:true});}
});

test('all records includes 500-test data and supports ordinary/dataset scope plus customer mobile search',()=>{
 const now=Date.now(),s=testState(now),v=VolumeDemo.seed(s,now);assert.equal(Board.select(s.trips,{now,scope:'all'}).total,504);assert.equal(Board.select(s.trips,{now,scope:v.runId}).total,500);assert.equal(Board.select(s.trips,{now,scope:'live'}).total,4);assert.equal(Board.select(s.trips,{now,scope:v.runId,search:s.trips.at(-1).customerPhone}).total,1);
});
test('regular customer driver gets the first offer even when farther; decline falls back to nearest suitable driver',()=>{
 const now=Date.now(),{s,trip}=sequentialFixture(now);
 Object.assign(trip,{lgtc:{test:true},plannedDriverId:'rank-2',plannedPickupAt:trip.pickupAt});
 s.customerPreferences={['ordinary:'+trip.customerPhone]:{driverId:'rank-3'}};
 const first=D.offer(s,trip,'Automatic dispatch',now);
 assert.equal(first.driverId,'rank-3');
 assert.equal(first.selectionReason,'regular_customer_driver');
 D.action(s,trip,'decline',{role:'driver',driverId:'rank-3',name:'Regular'},{offerId:first.id,reason:'On a break'},now+1000);
 assert.equal(s.offers.at(-1).driverId,'rank-1');
 assert.equal(s.offers.at(-1).selectionReason,'nearest_eligible');
});
test('regular driver preference never overrides availability, capacity, drops or another booking fleet',()=>{
 const now=Date.now(),{s,trip}=sequentialFixture(now);s.customerPreferences={['ordinary:'+trip.customerPhone]:{driverId:'rank-3'}};s.drivers[2].status='busy';assert.equal(D.eligible(s,trip,now)[0].driver.id,'rank-1');s.drivers[2].status='online';s.drivers[2].seats=1;trip.passengers=2;assert.equal(D.eligible(s,trip,now)[0].driver.id,'rank-1');s.drivers[2].seats=4;trip.excluded=['rank-3'];assert.equal(D.eligible(s,trip,now)[0].driver.id,'rank-1');assert.equal(D.regularDriver(s,{...trip,demoRunId:'another'}),null);
});
test('shared bookings with different regular drivers remain separate; later member drop history survives recovery',()=>{
 const now=Date.now(),s=sharedFixture(now);s.trips=s.trips.slice(0,2);s.customerPreferences={};s.customerPreferences['ordinary:'+s.trips[0].customerPhone]={driverId:'small'};s.customerPreferences['ordinary:'+s.trips[1].customerPhone]={driverId:'large'};let p=SharedPlanner.build(s,D.places,now);assert.ok(p.cars.flatMap(c=>c.stops).every(t=>t.members.length===1));s.customerPreferences={};s.trips[1].excluded=['small'];s.trips[1].droppedDrivers=['small'];p=SharedPlanner.build(s,D.places,now);SharedPlanner.apply(s,p,'Owner',now);const parent=s.trips.find(t=>t.isSharedRun);assert.ok(parent);assert.ok(parent.droppedDrivers.includes('small'));parent.droppedDrivers=[];assert.ok(D.recoveryTrip(s,parent,null,now).excluded.includes('small'));assert.equal(D.eligibility(s,D.recoveryTrip(s,parent,null,now),now).find(c=>c.driver.id==='small').eligible,false);
});
test('saving regular customer driver is owner-only, scoped and automatically used for future matching phone bookings',async t=>{
 const now=Date.now(),h=await harness(t,{clock:()=>now}),o=h.client(),c=h.client();await owner(o);await customer(c);let id,phone;h.mutate(s=>{const f=sequentialFixture(now);Object.assign(s,f.s);id=f.trip.id;phone=f.trip.customerPhone;});assert.equal((await c('/api/customer-preference',{tripId:id,driverId:'rank-3'})).status,403);assert.equal((await o('/api/customer-preference',{tripId:id,driverId:'unknown'})).status,400);assert.equal((await o('/api/customer-preference',{tripId:id,driverId:'rank-3'})).status,200);assert.equal(D.regularDriver(h.load(),{customerPhone:phone,demoRunId:null}), 'rank-3');const visible=(await c('/api/state')).data.state;assert.equal(visible.customerPreferences,undefined);assert.equal(visible.trips[0].preferredDriver.name,'Driver 3');const s=h.load(),rows=D.validateRows(s,[{trip_id:'REPEAT',pickup_at:new Date(now+3600000).toISOString(),customer_name:'Repeat',customer_phone:phone,pickup:s.trips[0].pickup,destination:s.trips[0].destination,passengers:'1',requirements:''}],now);assert.equal(D.regularDriver(s,rows[0].trip),'rank-3');assert.equal((await o('/api/customer-preference',{tripId:id,driverId:null})).status,200);assert.equal(D.regularDriver(h.load(),{customerPhone:phone}),null);
});

test('urgent fallback still gives a newly configured regular driver an exclusive first offer',()=>{
 const now=Date.now(),{s,trip}=sequentialFixture(now);trip.pickupAt=now+300000;D.tick(s,now);const initial=s.offers[0];s.customerPreferences={['ordinary:'+trip.customerPhone]:{driverId:'rank-3'}};D.action(s,trip,'decline',{role:'driver',driverId:initial.driverId,name:'First'},{offerId:initial.id,reason:'On a break'},now+1000);const pending=s.offers.filter(o=>o.status==='pending');assert.equal(pending.length,1);assert.equal(pending[0].driverId,'rank-3');assert.equal(pending[0].mode,'sequential');
});

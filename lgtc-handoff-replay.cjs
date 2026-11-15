const http = require('node:http');
const path = require('node:path');
const { createApp } = require('./server.cjs');
const domain = require('./domain.cjs');
const { serveFleet, simulationDrivers } = require('./fleet-simulation.cjs');
const port = Number(process.env.LGTC_DEMO_PORT || 4780);
const host = process.env.LGTC_DEMO_HOST || 'localhost';

let backend, clock, sessions, initial;
const approvedTest = ride => ride.lgtc?.test && ride.lgtc.serviceDate==='2026-11-14' &&
  ride.customerName.startsWith('Test Rider ') && /^\+1704555012[0-8]$/.test(ride.customerPhone) &&
  ['d2','d3'].includes(ride.plannedDriverId);
let testStepRunning=false;
const roles = {
  owner: {role:'owner'}, driver: {role:'driver',driverId:'d1'},
  james: {role:'driver',driverId:'d2'}, sofia: {role:'driver',driverId:'d3'}, backup: {role:'driver',driverId:'d4'}, retry: {role:'driver',driverId:'d5'}, customer: {role:'customer'}
};

async function call(path, data, cookie) {
  const response = await fetch(backend.url + path, {
    method: data ? 'POST' : 'GET',
    headers: {'Content-Type':'application/json', ...(cookie && {Cookie:cookie}), ...(data && {'Idempotency-Key':require('node:crypto').randomUUID()})},
    body: data && JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || response.statusText);
  return {result, cookie:response.headers.get('set-cookie')?.split(';')[0]};
}

async function resetDemo({preserveCompletedFleet=false}={}) {
  if (!initial) {
    const rows = require('node:fs').readFileSync(require('node:path').join(__dirname,'data','LGTC-Live-Three.csv'),'utf8').trim().split(/\r?\n/).map(line=>line.split(','));
    if (rows.length !== 3 || rows.some(row=>!/^900-80[1-3]-A$/.test(row[1]))) throw Error('Unexpected demo data');
    const drivers = domain.seed(Date.now()).drivers.slice(0,3);
    const trips = rows.map(row=>{
      const pickupAt = Date.parse('2026-11-13T'+row[14]+':00-05:00');
      const [checked] = domain.validateRows({trips:[]},[{
        trip_id:'LGTC-MCD1-2026-11-13-'+row[1],customer_name:row[4],customer_phone:'+1'+row[28],
        pickup:row[7],destination:row[16],pickup_at:new Date(pickupAt).toISOString(),passengers:'1',requirements:''
      }],pickupAt-3600000);
      if (checked.errors.length) throw Error(checked.errors.join(', '));
      return {...checked.trip,autoDispatch:true,...(row[1]==='900-802-A'?{}:{plannedDriverId:'d1'}),plannedEndAt:pickupAt+1200000};
    });
    for (const {driver,car,type} of simulationDrivers) {
      if (drivers.some(profile=>profile.name===driver)) continue;
      const number=Number(/^Test driver (\d+)$/.exec(driver)?.[1]);
      if (!Number.isInteger(number)) throw Error('Unexpected simulation driver: '+driver);
      const stop=domain.places[(number-1)%domain.places.length];
      const accessible=type==='Accessible';
      drivers.push({id:'fleet-test-'+number,name:driver,phone:'+170455501'+String(50+number),
        vehicle:car,vehicleId:'fleet-test-car-'+number,plate:'TEST-'+number,
        seats:accessible?7:4,capabilities:accessible?['wheelchair']:[],
        lat:stop.lat,lng:stop.lng});
    }
    initial = {drivers,trips};
  }
  backend?.close();
  clock = Math.min(...initial.trips.map(ride => ride.pickupAt)) - 15 * 60000;
  backend = createApp({
    dbPath:path.join(__dirname,'data','wifi-fleet-demo.sqlite'),
    fleetImportPath:path.join(__dirname,'data','private-fleet.sqlite'),
    clock:()=>clock,automaticDispatch:false,
    advanceRideClock(ride,action,user){
      if(user.role!=='driver'||!ride||ride.driverId!==user.driverId)return clock;
      if(action==='pickup'&&ride.status==='arrived')clock=Math.max(clock,ride.pickupAt);
      if(action==='complete'&&ride.status==='onboard')clock=Math.max(clock+60000,(ride.startedAt||ride.pickupAt)+60000,ride.plannedEndAt||ride.pickupAt+1200000);
      return clock;
    }
  });
  await new Promise(resolve => backend.server.listen(0,'127.0.0.1',resolve));
  backend.url = 'http://127.0.0.1:' + backend.server.address().port;
  backend.mutate(state => {
    const savedFleet = new Map(state.drivers.filter(driver=>driver.importedDriver && driver.recurringShift).map(driver=>[driver.id,driver]));
    state.drivers = structuredClone(initial.drivers);
    for (const driver of state.drivers) {
      const saved = savedFleet.get(driver.id);
      if (!saved) continue;
      for (const field of ['importedDriver','vehicleId','vehicle','plate','seats','capabilities',
        'recurringShift','rosterManaged','availability','driverDisabled','vehicleDisabled']) {
        if (Object.hasOwn(saved,field)) driver[field] = saved[field];
      }
    }
    const approved=state.trips.filter(approvedTest);
    const completedFleet=preserveCompletedFleet?state.trips.filter(ride=>ride.reference.startsWith('TEST284-')&&['completed','needs_reassignment'].includes(ride.status)):[];
    state.trips = [...structuredClone(initial.trips),...approved];
    state.offers = [];
    state.events = [];
    state.reservations = [];
    state.customerMessages = [];
    for (const driver of state.drivers) {
      driver.status = driver.id === 'd1' ? 'online' : 'offline';
      driver.lastLocationAt = clock;
    }
    for (const ride of state.trips) Object.assign(ride, {
      status:'awaiting_driver',driverId:null,excluded:[],retryAt:0,dispatchExhausted:false,dispatchError:'',redFlag:false
    });
    domain.tick(state,clock);
    for (const driver of state.drivers) driver.status = 'online';
    state.trips.push(...completedFleet);
  });
  sessions = {};
  for (const key of ['owner','driver','james','sofia']) sessions[key] = (await call('/api/demo-login',roles[key])).cookie;
  const phone = initial.trips[0].customerPhone;
  const {result:{demoCode}} = await call('/api/auth/request-code',{phone});
  sessions.customer = (await call('/api/auth/verify',{phone,code:demoCode,name:'Alex Morgan'})).cookie;
}

const replayScript = String.raw`
<style>
main{grid-template-columns:repeat(3,minmax(360px,1fr))!important;overflow-x:auto}
main>section{min-width:0}
.ride-progress{padding:8px;background:white;border-bottom:1px solid #d3dee8}
.ride-progress h3{font-size:14px;margin:0 0 5px}
.ride-progress ol{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.ride-progress li{font-size:12px;padding:3px 6px;border-radius:4px;background:#edf3f8}
.ride-progress li[data-state=active]{background:#dbeafe;color:#193e80}
.ride-progress li[data-state=completed]{background:#dcfce7;color:#14532d}
.ride-progress li[data-state=attention]{background:#fee2e2;color:#991b1b}
.ride-progress li[data-state=next]{background:#fef3c7;color:#78350f}
</style>
<script>
const owner = document.querySelector('iframe[title="owner"]');
const summary = document.createElement('section');
summary.className = 'ride-progress';
summary.setAttribute('aria-label', 'LGTC ride progress');
summary.setAttribute('aria-live', 'polite');
summary.textContent = 'Loading ride progress…';
owner.before(summary);
const pickupTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'
});
const activeStages = {
  accepted: 'Driver confirmed', heading_to_pickup: 'Heading to pickup',
  arrived: 'At pickup', onboard: 'Passenger onboard'
};
let previousOffer;
let advancedAfterCancellation = false;
let cancellationHandoffScheduled = false;
function showProgress({trips, drivers, offers}) {
  const secondRide = trips.find(ride => /900-802-A$/.test(ride.reference));
  const backupDriver = drivers.find(driver => driver.id === 'd4');

  if (backupDriver && !chooser.querySelector('option[value="backup"]')) {
    chooser.add(new Option(backupDriver.name, 'backup'));
  }
  const retryDriver = drivers.find(driver => driver.id === 'd5');
  if (retryDriver && !chooser.querySelector('option[value="retry"]')) chooser.add(new Option(retryDriver.name, 'retry'));
  const thirdRide = trips.find(ride => /900-803-A$/.test(ride.reference));
  if(secondRide?.status==='cancelled'&&thirdRide?.status==='awaiting_driver'&&!advancedAfterCancellation&&!reset.disabled){
    advancedAfterCancellation=true;
    advance.click();
  }
  const rideIds=new Set(trips.filter(ride=>/900-80[1-3]-A$/.test(ride.reference)).map(ride=>ride.id));
  const offer=offers.find(item=>rideIds.has(item.tripId)&&item.status==='pending');
  if(offer&&offer.id!==previousOffer){
    const driver=drivers.find(item=>item.id===offer.driverId);
    const role={d1:'driver',d2:'james',d3:'sofia',d4:'backup',d5:'retry'}[offer.driverId]||offer.driverId;
    if(driver&&!Array.from(chooser.options).some(option=>option.value===role))chooser.add(new Option(driver.name,role));
    if(driver&&chooser.value!==role){chooser.value=role;chooser.onchange();}
  }
  previousOffer=offer?.id;
  const rides = trips.filter(ride => /900-80[1-3]-A$/.test(ride.reference))
    .sort((a, b) => a.pickupAt - b.pickupAt);
  const next = rides.find(ride => ['offered', 'awaiting_driver', 'needs_reassignment'].includes(ride.status));
  const rows = rides.map(ride => {
    const label = ride.status === 'cancelled' ? ['scheduled', 'Cancelled'] : ride.dispatchExhausted ? ['attention', 'Needs Attention'] : activeStages[ride.status]
      ? ['active', 'Active · ' + activeStages[ride.status]]
      : ride.status === 'completed' ? ['completed', 'Completed']
      : ride === next ? ['next', ride.status === 'offered' ? 'Next · Offer pending' : 'Next pickup']
      : ['scheduled', 'Scheduled'];
    const row = document.createElement('li');
    row.dataset.state = label[0];
    if (ride === secondRide) row.dataset.jordanAction = '';
    row.textContent = pickupTime.format(ride.pickupAt) + ' ET · ' + ride.reference.match(/900-80[1-3]-A$/)[0] + ' · ' + label[1];
    const driverId = ride.driverId || offers.find(offer => offer.tripId === ride.id && offer.status === 'pending')?.driverId;
    const name = drivers.find(driver => driver.id === driverId)?.name;
    if (name) row.textContent += ' · ' + name;
    if (ride.status === 'cancelled' && ride.cancellationReason) {
      row.textContent += ' · Cancellation reason: ' + ride.cancellationReason;
    }
    if (['completed', 'cancelled'].includes(ride.status)) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = row.textContent;
      open.title = 'Open ride timeline';
      open.style.cssText = 'border:0;background:none;color:inherit;text-align:left;text-decoration:underline;cursor:pointer;font:inherit;padding:0';
      open.onclick = () => owner.contentWindow.dispatchEvent(new CustomEvent('royalcab-demo-open-ride', {detail:ride.id}));
      row.replaceChildren(open);
    }
    return row;
  });
  const heading = document.createElement('h3');
  const completedCount = rides.filter(ride => ride.status === 'completed').length;
  const cancelledCount = rides.filter(ride => ride.status === 'cancelled').length;
  heading.textContent = 'Ride progress · ' + completedCount + ' of 3 completed · ' + cancelledCount + ' cancelled';
  const list = document.createElement('ol');
  list.append(...rows);
  const needsJordan = secondRide?.dispatchExhausted && ['awaiting_driver','needs_reassignment'].includes(secondRide.status);
  if (needsJordan) {
    const jordanDeclined = offers.some(offer => offer.tripId === secondRide.id && offer.driverId === 'd4' && offer.status === 'declined');
    const action = jordanDeclined ? retrySearch : addBackup;
    if (summary.textContent === heading.textContent + list.textContent + action.textContent + reschedule.textContent + cancelRide.textContent && summary.contains(action)) return;
    list.querySelector('[data-jordan-action]').append(action, reschedule, cancelRide);
  }
  if (summary.textContent !== heading.textContent + list.textContent) summary.replaceChildren(heading, list);
}
let ownerEvents;
owner.addEventListener('load', () => {
  ownerEvents?.close();
  ownerEvents = new EventSource('/owner/api/events');
  ownerEvents.addEventListener('state', event => showProgress(JSON.parse(event.data).state));
});
const maya = document.querySelector('iframe[title="driver"]');
const james = document.createElement('iframe');
james.title = 'James';
james.src = '/james/';
james.hidden = true;
const sofia = document.createElement('iframe');
sofia.title = 'Sofia';

sofia.hidden = true;
maya.after(james, sofia);
const backup = document.createElement('iframe');
backup.title = 'Jordan';
backup.hidden = true;
sofia.after(backup);
const addBackup = document.createElement('button');
addBackup.textContent = 'Send offer to Jordan';
addBackup.style.marginInlineStart = '8px';
addBackup.onclick = async () => {
  addBackup.disabled = true;
  try {
    const result = await fetch('/add-backup', {method:'POST'});
    document.querySelector('#status').textContent = await result.text();
  } finally {
    addBackup.disabled = false;
  }
};
const retrySearch = document.createElement('button');
retrySearch.textContent = 'Retry driver search';
retrySearch.style.marginInlineStart = '8px';
retrySearch.onclick = async () => {
  retrySearch.disabled = true;
  try {
    const response = await fetch('/retry-search', {method:'POST'});
    document.querySelector('#status').textContent = await response.text();
  } catch {
    document.querySelector('#status').textContent = 'Could not retry driver search. Try again.';
  } finally {
    retrySearch.disabled = false;
  }
};
const reschedule = document.createElement('form');
reschedule.style.marginTop = '6px';
reschedule.innerHTML = '<label>New pickup (ET) <input name="pickup" type="time" required></label> <button>Reschedule pickup</button>';
reschedule.onsubmit = async event => {
  event.preventDefault();
  const button = reschedule.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/reschedule-pickup?time=' + encodeURIComponent(reschedule.elements.pickup.value), {method:'POST'});
    document.querySelector('#status').textContent = await response.text();
  } catch {
    document.querySelector('#status').textContent = 'Could not reschedule. Try again.';
  } finally {
    button.disabled = false;
  }
};
const cancelRide = document.createElement('button');
cancelRide.textContent = 'Cancel ride';
const cancelDialog = document.createElement('dialog');
cancelDialog.innerHTML = '<form method="dialog"><h2>Cancel this ride?</h2><p>Customer will see the cancellation and dispatch will open the next pickup.</p><label>Cancellation reason <input name="reason" required maxlength="200"></label> <button value="keep" formnovalidate>Keep ride</button> <button value="cancel">Confirm cancellation</button></form>';
document.body.append(cancelDialog);
cancelRide.onclick = () => {
  cancelDialog.querySelector('form').reset();
  cancelDialog.returnValue = '';
  cancelDialog.showModal();
};
cancelDialog.onclose = async () => {
  if (cancelDialog.returnValue !== 'cancel') return;
  cancelRide.disabled = true;
  try {
    const response = await fetch('/cancel-attention-ride', {method:'POST', body:cancelDialog.querySelector('input').value});
    document.querySelector('#status').textContent = await response.text();
  } catch {
    document.querySelector('#status').textContent = 'Could not cancel the ride. Try again.';
  } finally {
    cancelRide.disabled = false;
  }
};
const chooser = document.createElement('select');
chooser.setAttribute('aria-label','Demo driver');
chooser.innerHTML = '<option value="driver">Maya Chen</option><option value="james">James Wilson</option><option value="sofia">Sofia Martinez</option>';
maya.before(chooser);
chooser.onchange = () => {
  maya.hidden = chooser.value !== 'driver';
  james.hidden = chooser.value !== 'james';
  sofia.hidden = chooser.value !== 'sofia';
  backup.hidden = ['driver','james','sofia'].includes(chooser.value);
  const backupPath = '/' + chooser.value + '/';
  if (!backup.hidden && backup.getAttribute('src') !== backupPath) {
    james.removeAttribute('src');
    sofia.removeAttribute('src');
    backup.src = backupPath;
  } else if (backup.hidden) backup.removeAttribute('src');
  if (!sofia.hidden && !sofia.getAttribute('src')) {
    james.removeAttribute('src');
    sofia.src = '/sofia/';
  }
  if (!james.hidden && !james.getAttribute('src')) {
    sofia.removeAttribute('src');
    james.src = '/james/';
  }
};
const driver = document.querySelector('iframe[title="driver"]');
const customer = document.querySelector('iframe[title="customer"]');
const advance = document.querySelector('#advance');
const reset = document.querySelector('#reset');
advance.hidden = true;
let completed = 0;

let awaitingOffer = false;


function updateReplay() {
  const customerPage = customer.contentDocument;
  if(!customerPage)return;
  const total=Number(summary.querySelector('h3')?.textContent.match(/(\d) of 3 completed/)?.[1]||0);
  if(total>completed&&!reset.disabled){
    completed=total;
    if(completed<3){awaitingOffer=true;advance.click();}
    else document.querySelector('#status').textContent='All three rides completed.';
  }

  const offerVisible = Boolean(previousOffer);
  const upcoming = customerPage.querySelector('#next-customer-ride');
  if (advancedAfterCancellation && !cancellationHandoffScheduled && offerVisible && upcoming &&
      customerPage.querySelector('h1')?.textContent.trim() === 'Ride cancelled') {
    cancellationHandoffScheduled = true;
    setTimeout(() => {
      const page = customer.contentDocument;
      if (!reset.disabled && page.querySelector('h1')?.textContent.trim() === 'Ride cancelled') {
        page.querySelector('#next-customer-ride')?.click();
      }
    }, 4000);
  }
  if (awaitingOffer && offerVisible && upcoming) {
    awaitingOffer = false;
    setTimeout(() => {
      const page = customer.contentDocument;
      if (!reset.disabled && page.querySelector('h1')?.textContent.trim() === 'Ride completed') {
        page.querySelector('#next-customer-ride')?.click();
      }
    }, 4000);
  }
}
reset.addEventListener('click', async event => {
  event.stopImmediatePropagation();
  reset.disabled = true;
  const panels = document.querySelector('main');
  panels.inert = true;
  document.querySelector('#status').textContent = 'Resetting all three rides…';
  try {
    const response = await fetch('/reset', {method:'POST'});
    if (!response.ok) throw Error('Reset failed');
    location.reload();
  } catch {
    document.querySelector('#status').textContent = 'Reset failed. Try again.';
    panels.inert = false;
    reset.disabled = false;
  }
}, true);
for (const panel of [driver, james, sofia, backup, customer]) {
  panel.addEventListener('load', () => {
    new MutationObserver(updateReplay).observe(panel.contentDocument.body, {
      childList: true, subtree: true, characterData: true
    });
    updateReplay();
  });
}
</script>`;

let pendingReset;
let fleetRun;
function startFleetRun(){
  if(fleetRun || pendingReset || testStepRunning)throw Error('Another demo action is running.');
  const rows=require('./fleet-simulation.cjs').simulationRides;
  const at=time=>Date.parse('2026-11-14T'+time+':00-05:00');

  const start=Math.min(...rows.map(r=>at(r.pickup)))-900000;
  const finish=Math.max(...rows.map(r=>at(r.end)));
  const state=backend.load();
  if(state.trips.some(t=>t.reference.startsWith('TEST284-')))throw Error('The 284-ride test is already loaded.');
  const drivers=state.drivers.filter(d=>d.status==='online'&&!d.driverDisabled&&!d.vehicleDisabled);
  if(!drivers.length)throw Error('No online test drivers.');
  const driverIds=new Set(drivers.map(d=>d.id));
  const [pickup,destination]=domain.places;
  const checked=domain.validateRows(state,rows.map(r=>({trip_id:'TEST284-'+r.reference,customer_name:'Fleet Test Rider',
    customer_phone:'+17045550149',pickup:pickup.name,destination:destination.name,pickup_at:new Date(at(r.pickup)).toISOString(),
    passengers:'1',requirements:r.type==='Accessible'?'wheelchair':''})),start);
  if(checked.some(r=>r.errors.length))throw Error('Unable to load the test rides.');
  const trips=checked.map(({trip},i)=>({...trip,plannedEndAt:at(rows[i].end)}));
  const tripIds=new Set(trips.map(t=>t.id));
  backend.mutate(s=>s.trips.push(...trips));
  let now=start;
  fleetRun=setInterval(()=>{
    try{

      backend.mutate(s=>{
        const batch=s.trips.filter(t=>tripIds.has(t.id));
        const local={...s,trips:batch,drivers:s.drivers.filter(d=>driverIds.has(d.id)),offers:s.offers.filter(o=>tripIds.has(o.tripId))};
        const actor=d=>({role:'driver',driverId:d.id,name:d.name});
        for(const d of local.drivers)if(d.status==='online')Object.assign(d,{lat:pickup.lat,lng:pickup.lng,lastLocationAt:now,locationSource:"scenario"});
        for(const t of batch){
          const d=local.drivers.find(d=>d.id===t.driverId);
          if(t.status==='heading_to_pickup'&&now>=t.pickupAt){
            domain.action(local,t,'arrive',actor(d),{},now);
            domain.action(local,t,'pickup',actor(d),{},now);
          }
          if(t.status==='onboard'&&now>=t.plannedEndAt)domain.action(local,t,'complete',actor(d),{},now);
          if(t.status==='awaiting_driver'&&now>=t.pickupAt){
            t.autoDispatch=false;t.redFlag=true;t.dispatchExhausted=true;t.status='needs_reassignment';
          }
        }
        domain.tick(local,now);
        for(const o of local.offers.filter(o=>o.status==='pending'&&o.offeredAt<now)){
          const t=batch.find(t=>t.id===o.tripId),d=local.drivers.find(d=>d.id===o.driverId);
          domain.action(local,t,'accept',actor(d),{offerId:o.id},now);
          domain.action(local,t,'depart',actor(d),{},now);
        }
        s.offers=[...s.offers.filter(o=>!tripIds.has(o.tripId)),...local.offers];
        s.events=local.events;s.notifications=local.notifications;
      });
      backend.publish();
      if(now>=finish){clearInterval(fleetRun);fleetRun=null;}
      now+=30000;
    }catch(error){clearInterval(fleetRun);fleetRun=null;console.error(error);}
  },100);
}
let missedPickupDemo;
let acceptanceTestId, firstAcceptance;
async function serve(req,res) {
  if(req.url==='/owner/acceptance-test'&&['GET','POST'].includes(req.method)){
    const reset=req.method==='POST';
    if(reset&&req.headers.origin&&req.headers.origin!=='http://'+req.headers.host){
      res.writeHead(403);return res.end();
    }
    if(reset)firstAcceptance?.release();
    if(reset||!acceptanceTestId){
      for(const key of ['owner','driver','james'])sessions[key]=(await call('/api/demo-login',roles[key])).cookie;
      acceptanceTestId=backend.mutate(state=>{
        const existing=state.trips.find(t=>t.reference==='DUAL-ACCEPT-TEST');
        if(existing&&!reset)return existing.id;
        if(existing){
          for(const d of state.drivers.filter(d=>d.id===existing.driverId&&d.status==='busy')){
            if(!state.trips.some(t=>t.id!==existing.id&&t.driverId===d.id&&!['completed','cancelled'].includes(t.status)))d.status='online';
          }
          state.trips=state.trips.filter(t=>t.id!==existing.id);
          state.offers=state.offers.filter(o=>o.tripId!==existing.id);
        }
        const drivers=state.drivers.filter(d=>['d1','d2'].includes(d.id));
        if(drivers.length!==2||drivers.some(d=>d.status==='busy'))throw Error('Test drivers are busy.');
        const [pickup,destination]=domain.places;
        const pickupAt=clock+60000;
        const ride=domain.validateRows(state,[{trip_id:'DUAL-ACCEPT-TEST',customer_name:'Acceptance Test Rider',
          customer_phone:'+17045550148',pickup:pickup.name,destination:destination.name,pickup_at:new Date(pickupAt).toISOString(),passengers:'1'}],clock)[0].trip;
        ride.demoRunId='dual-accept-test';
        const group={...state,trips:[ride],offers:[],drivers:drivers.map(d=>({...d,demoRunId:ride.demoRunId,rosterManaged:false,rosterServiceDate:null,availability:{},recurringShift:null,status:'online',lat:pickup.lat,lng:pickup.lng,lastLocationAt:clock}))};
        domain.offer(group,ride,'Owner test',clock,{mode:'urgent_group',limit:2});
        if(group.offers.length!==2)throw Error('Both test offers are required.');
        delete ride.demoRunId;
        for(const d of drivers){
          Object.assign(d,{status:'online',lat:pickup.lat,lng:pickup.lng,lastLocationAt:clock});
          d.availability={...d.availability,[new Date(pickupAt-5*3600000).toISOString().slice(0,10)]:{startAt:clock-60000,endAt:clock+3600000}};
          for(const offer of state.offers.filter(o=>o.driverId===d.id&&o.status==='pending'))domain.closeOffer(state,offer,'expired',clock);
        }
        state.trips.push(ride);state.offers.push(...group.offers);
        return ride.id;
      });
    }
    if(reset){res.writeHead(303,{Location:'/owner/acceptance-test'});return res.end();}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end('<!doctype html><title>Two-driver acceptance test</title><style>body{font:16px system-ui;margin:12px}.screens{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.screens section{min-width:0}@media(max-width:760px){.screens{grid-template-columns:1fr}}iframe{width:100%;height:78vh;border:1px solid #ccd5e1}</style><h1>Two-driver acceptance test</h1><form method="post"><button type="submit">Reset acceptance test</button></form><p>Open Ride actions on both cards, then click Accept trip on both screens.</p><div class="screens"><section><h2>Owner</h2><iframe title="Owner Dispatch" src="/owner/#acceptance-test"></iframe></section><section><h2>Maya</h2><iframe title="Maya Driver" src="/driver/"></iframe></section><section><h2>James</h2><iframe title="James Driver" src="/james/"></iframe></section></div><a href="/owner/" target="_blank">Open Owner</a>');
  }
  if(req.method==='POST'&&req.url==='/owner/missed-group-test'){
    if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host){res.writeHead(403);return res.end();}
    const now=clock, sandbox=domain.seed(now,{customerRemindersEnabled:false});
    const ride=sandbox.trips[0], stop=domain.places[0];
    Object.assign(ride,{pickupAt:now-60000,autoDispatch:true});
    sandbox.trips=[ride];
    sandbox.drivers=Array.from({length:5},(_,i)=>({...sandbox.drivers[0],id:'group-'+i,name:'Recovery driver '+(i+1),plate:'REC-'+i,lat:stop.lat,lng:stop.lng,lastLocationAt:now}));
    domain.tick(sandbox,now);
    const history=()=>sandbox.offers.map(o=>sandbox.drivers.find(d=>d.id===o.driverId).name+' ('+o.status+')').join(', ');
    const pending=history();
    const test=createApp({dbPath:':memory:',clock:()=>now,automaticDispatch:false});
    try{
      test.mutate(state=>Object.assign(state,sandbox));
      await new Promise(resolve=>test.server.listen(0,'127.0.0.1',resolve));
      const url='http://127.0.0.1:'+test.server.address().port;
      const post=(route,data,cookie)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':require('node:crypto').randomUUID(),...(cookie&&{Cookie:cookie})},body:JSON.stringify(data)});
      const offers=sandbox.offers.slice(0,2);
      const cookies=await Promise.all(offers.map(async o=>{
        const login=await post('/api/demo-login',{role:'driver',driverId:o.driverId});
        return login.headers.get('set-cookie').split(';')[0];
      }));
      const replies=await Promise.all(offers.map(async (o,i)=>{
        const response=await post('/api/trips/'+ride.id+'/action',{action:'accept',offerId:o.id},cookies[i]);
        return {code:response.status,name:sandbox.drivers.find(d=>d.id===o.driverId).name,body:await response.json()};
      }));
      const final=test.load(), confirmed=final.trips[0].confirmedDriver?.name;
      if(!confirmed||replies.filter(r=>r.code===200).length!==1||final.offers.filter(o=>o.status==='taken').length!==4)throw Error('Unexpected acceptance results');
      return res.end('Offers sent: '+pending+' · Confirmed assignment: '+confirmed+' · Other driver: '+replies.find(r=>r.code!==200).body.error+' · Four offers closed as Taken.');
    }finally{test.close();}
  }
  if(req.method==='POST'&&['/owner/missed-retry','/owner/missed-accept','/owner/missed-decline'].includes(req.url)){
    if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host){res.writeHead(403);return res.end();}
    const demo=missedPickupDemo;
    try{
      if(!demo?.thirdDecline||demo.minute<16)throw Error('Finish the all-decline scenario first.');
      const {sandbox,ride}=demo, now=demo.start+15*60000;
      if(req.url.endsWith('retry')){
        if(!ride.dispatchExhausted)throw Error('The ride is no longer in Needs Attention.');
        const stop=domain.places.find(p=>p.name===ride.pickup);
        const driver={...sandbox.drivers[0],id:'d4',name:'Jordan Reed',plate:'RECOVERY-4',status:'online',lat:stop.lat,lng:stop.lng,lastLocationAt:now};
        const excluded=[...ride.excluded];
        domain.action(sandbox,ride,'retry',{role:'owner',name:'Fleet owner'},{},now);
        ride.excluded=excluded;
        sandbox.drivers.push(driver);
        // Explicit owner recovery after the automatic deadline.
        ride.autoDispatch=false;
        ride.recoveryUntil=now+45000;
        ride.recoveryDriverIds=[driver.id];
        domain.offer(sandbox,ride,'Fleet owner',now,{driverId:driver.id,mode:'recovery_sequential'});
      }else{
        const offer=sandbox.offers.find(o=>o.driverId==='d4'&&o.status==='pending');
        if(!offer)throw Error('Jordan has no pending offer.');
        const decline=req.url.endsWith('decline');
        domain.action(sandbox,ride,decline?'decline':'accept',{role:'driver',driverId:'d4',name:'Jordan Reed'},{offerId:offer.id,reason:'Unable to take this trip'},now+1000);
        if(decline)ride.dispatchError='Pickup missed: the 15-minute recovery window ended, and Jordan declined the owner retry. All four drivers declined.';

      }
      req.url='/owner/missed-pickup-demo';
      req.method='GET';
    }catch(error){res.writeHead(409);return res.end(error.message);}
  }
  if(['/owner/missed-pickup-demo','/owner/missed-pickup-demo?accept=1','/owner/missed-pickup-demo?decline=1','/owner/missed-pickup-demo?decline=2','/owner/missed-pickup-demo?decline=3'].includes(req.url)){
    if(req.method==='POST'){
      if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host){res.writeHead(403);return res.end();}
      const start=clock;
      const sandbox=domain.seed(start,{customerRemindersEnabled:false});
      const ride=sandbox.trips[0];
      Object.assign(ride,{reference:'MISSED-PICKUP-TEST',pickupAt:start,autoDispatch:true,demoRunId:'missed-pickup-test'});
      sandbox.trips=[ride];
      sandbox.drivers.forEach(driver=>Object.assign(driver,{demoRunId:ride.demoRunId,status:'offline'}));
      missedPickupDemo={sandbox,ride,minute:0,attempts:0,start,started:performance.now(),recover:req.url.includes("?"),decline:req.url.includes("decline="),secondDecline:/decline=[23]$/.test(req.url),thirdDecline:req.url.endsWith("decline=3")};
    }
    if(missedPickupDemo){
      const demo=missedPickupDemo;
      const target=Math.min(15,Math.floor((performance.now()-demo.started)/1500));
      while(demo.minute<=target){
        const now=demo.start+demo.minute*60000;
        const driver=demo.sandbox.drivers[0];
        if(demo.recover&&demo.minute===8){
          const stop=domain.places.find(place=>place.name===demo.ride.pickup);
          Object.assign(driver,{status:'online',lat:stop.lat,lng:stop.lng,lastLocationAt:now});
        }
        if(demo.recover&&demo.minute===9){
          const offer=demo.sandbox.offers.find(o=>o.tripId===demo.ride.id&&o.status==='pending');
          if(offer){
            const responseAt=offer.offeredAt+1000;
            if(demo.decline)Object.assign(demo.sandbox.drivers[1],{status:'online',lat:driver.lat,lng:driver.lng,lastLocationAt:responseAt});
            domain.action(demo.sandbox,demo.ride,demo.decline?'decline':'accept',{role:'driver',driverId:driver.id,name:driver.name},{offerId:offer.id,reason:'Unable to take this trip'},responseAt);
          }
        }
        if(demo.decline&&demo.minute===10){
          const offer=demo.sandbox.offers.find(o=>o.status==='pending');
          const next=demo.sandbox.drivers[1];
          if(offer){
            const at=offer.offeredAt+1000;
            if(demo.secondDecline)Object.assign(demo.sandbox.drivers[2],{status:'online',lat:next.lat,lng:next.lng,lastLocationAt:at});
            domain.action(demo.sandbox,demo.ride,demo.secondDecline?'decline':'accept',{role:'driver',driverId:next.id,name:next.name},{offerId:offer.id,reason:'Unable to take this trip'},at);
          }
        }
        if(demo.secondDecline&&demo.minute===11){
          const offer=demo.sandbox.offers.find(o=>o.status==='pending');
          const sofia=demo.sandbox.drivers[2];
          if(offer)domain.action(demo.sandbox,demo.ride,demo.thirdDecline?'decline':'accept',{role:'driver',driverId:sofia.id,name:sofia.name},{offerId:offer.id,reason:'Unable to take this trip'},offer.offeredAt+1000);
        }
        if(!(demo.decline&&demo.minute===9)&&!(demo.secondDecline&&demo.minute===10))domain.tick(demo.sandbox,now);
        if(demo.minute<15&&['awaiting_driver','offered'].includes(demo.ride.status))demo.attempts++;
        demo.minute++;
      }
      res.setHeader('Content-Type','application/json');
      res.setHeader('Cache-Control','no-store');
      return res.end(JSON.stringify({minute:target,attempts:demo.attempts,attention:!!demo.ride.dispatchExhausted,reason:demo.ride.dispatchError,status:demo.ride.status,history:demo.sandbox.offers.map(o=>demo.sandbox.drivers.find(d=>d.id===o.driverId).name+' ('+o.status+')'),driver:demo.sandbox.drivers.find(d=>d.id===(demo.ride.driverId||demo.sandbox.offers.find(o=>o.status==="pending")?.driverId))?.name}));
    }
    return res.end('null');
  }
  if(req.method==='POST' && req.url==='/owner/advance-approved-test'){
    if(req.headers.origin && req.headers.origin!=='http://'+req.headers.host){res.writeHead(403);return res.end();}
    if(testStepRunning || pendingReset){res.writeHead(409);return res.end('A demo action is already running.');}
    testStepRunning=true;
    try{
      const state=backend.load();
      const rides=state.trips.filter(approvedTest);
      if(rides.length!==9)throw Error('Expected nine approved test rides.');
      const lead=(state.settings.dispatchLeadMinutes||15)*60000;
      const steps=rides.flatMap(ride=>{
        const offer=state.offers.find(o=>o.tripId===ride.id&&o.status==='pending');
        if(offer)return [{ride,offer,at:offer.offeredAt,action:'accept'}];
        if(ride.status==='awaiting_driver')return [{ride,at:ride.pickupAt-lead,action:'offer'}];
        if(ride.status==='accepted')return [{ride,at:clock,action:'depart'}];
        if(ride.status==='heading_to_pickup')return [{ride,at:ride.pickupAt,action:'arrive'}];
        if(ride.status==='arrived')return [{ride,at:ride.pickupAt,action:'pickup'}];
        if(ride.status==='onboard')return [{ride,at:ride.plannedEndAt,action:'complete'}];
        return [];
      }).sort((a,b)=>a.at-b.at);
      const step=steps[0];
      if(!step)return res.end('All nine test rides completed.');
      const {ride,offer,at,action}=step;
      clock=Math.max(clock,at);
      for(const key of ["owner","james","sofia"])sessions[key]=(await call("/api/demo-login",roles[key])).cookie;
      const driver=state.drivers.find(d=>d.id===ride.plannedDriverId);
      const session=sessions[driver.id==='d2'?'james':'sofia'];
      if(action==='offer'){
        backend.mutate(s=>{
          const d=s.drivers.find(x=>x.id===driver.id);
          if(d.status!=='online')throw Error(driver.name+' is unavailable.');
          const stop=domain.places.find(p=>p.name===ride.pickup);
          Object.assign(d,{lat:stop.lat,lng:stop.lng,lastLocationAt:clock,locationSource:'scenario'});
        });
        await call('/api/trips/'+ride.id+'/action',{action:'manual_offer',driverId:driver.id,reason:'Owner reviewed availability'},sessions.owner);
      }else{
        await call('/api/trips/'+ride.id+'/action',{action,...(offer&&{offerId:offer.id})},session);
      }
      return res.end(ride.lgtc.reference+' · '+driver.name+' · '+action+' · '+new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeStyle:'short'}).format(clock)+' ET');
    }catch(error){res.writeHead(409);return res.end(error.message);}
    finally{testStepRunning=false;}
  }
  if(req.url==='/owner/run-284'&&req.method==='POST'){
    if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host){res.writeHead(403);return res.end();}
    try{startFleetRun();return res.end('284-ride dispatch started.');}
    catch(error){res.writeHead(409);return res.end(error.message);}
  }
  if(req.method==='POST'&&req.url==='/owner/retry-accessible-test'){
    if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host){res.writeHead(403);return res.end();}
    try{
      if(fleetRun||pendingReset||testStepRunning)throw Error('Another demo action is running.');
      const result=backend.mutate(state=>{
        const ride=state.trips.find(t=>t.reference==='TEST284-1-42164-A'&&t.status==='needs_reassignment');
        if(!ride)throw Error('Accessible test ride is not awaiting recovery.');
        const at=ride.pickupAt-60000*(state.settings.dispatchLeadMinutes||15);
        if(clock>at)throw Error('The test clock has already passed the offer window.');
        for(const driver of state.drivers.filter(d=>['fleet-test-7','fleet-test-8','fleet-test-9'].includes(d.id))){
          const pickup=domain.places.find(stop=>stop.name===ride.pickup);
          Object.assign(driver,{lat:pickup.lat,lng:pickup.lng,lastLocationAt:at,locationSource:"scenario"});
        }
        const eligible=domain.eligibility(state,ride,at).filter(c=>c.eligible).sort((a,b)=>a.eta-b.eta);
        const best=eligible[0];if(!best)throw Error('No accessible driver is eligible.');
        const offer=domain.offer(state,ride,'Owner test dispatch',at,{driverId:best.driver.id});
        return {at,eligible:eligible.map(c=>[c.driver.name,c.eta]),driver:best.driver.name,status:offer.status};
      });
      clock=result.at;
      sessions.owner=(await call('/api/demo-login',roles.owner)).cookie;
      backend.publish();
      return res.end(JSON.stringify(result));
    }catch(error){res.writeHead(409);return res.end(error.message);}
  }
  if (serveFleet(req,res)) return;
  if (req.method === 'POST' && req.url === '/owner/export-filtered.csv') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        res.writeHead(413);
        return res.end('Export is too large.');
      }
      chunks.push(chunk);
    }
    const csv = new URLSearchParams(Buffer.concat(chunks).toString()).get('csv');
    if (!csv?.startsWith('"Trip ID","Rider","Status"')) {
      res.writeHead(400);
      return res.end('No trip export was supplied.');
    }
    res.writeHead(200, {
      'Content-Type':'text/csv; charset=utf-8',
      'Content-Disposition':'attachment; filename="royalcab-trips.csv"',
      'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff'
    });
    return res.end(csv);
  }
  if (req.url === '/' && req.method === 'GET') {
    const page = '<!doctype html><meta charset="utf-8"><title>RoyalCab LGTC replay</title><style>body{margin:0;font:16px system-ui;background:#edf3f8}header{padding:12px}main{display:grid;gap:8px}h2{margin:0;padding:8px;background:#253c53;color:white;font-size:16px}iframe{border:0;width:100%;height:calc(100dvh - 95px);background:white}</style><header><button id="reset">Reset three rides</button> <label><input type="checkbox" id="maya-nine"> Maya gets the first 9:00 AM offer</label> <button id="advance">Open next pickup window</button> <span role="status" id="status"></span></header><main><section><h2>Owner</h2><iframe title="owner" src="/owner/"></iframe></section><section><h2>Driver</h2><iframe title="driver" src="/driver/"></iframe></section><section><h2>Customer</h2><iframe title="customer" src="/customer/"></iframe></section></main><script>const mayaOption=document.querySelector("#maya-nine");try{mayaOption.checked=localStorage.getItem("royalcab.maya-nine")==="true";}catch{} mayaOption.onchange=()=>{try{localStorage.setItem("royalcab.maya-nine",String(mayaOption.checked));}catch{}};document.querySelector("#advance").onclick=async()=>{const r=await fetch(document.querySelector("#maya-nine").checked?"/advance?maya=1":"/advance",{method:"POST"});document.querySelector("#status").textContent=await r.text();};</script>';
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(page + replayScript);
  }
  if (req.method === 'POST' && req.url === '/reset') {
    if(fleetRun){clearInterval(fleetRun);fleetRun=null;}
    pendingReset ??= resetDemo().finally(() => { pendingReset = null; });
    await pendingReset;
    return res.end('All three rides reset. Maya has the first offer and James and Sofia are online as backups.');
  }
  if (req.method === 'POST' && req.url === '/add-backup' && !pendingReset) {
    const snapshot = backend.load();
    const ride = snapshot.trips.find(trip => /900-802-A$/.test(trip.reference));
    if (!ride?.dispatchExhausted) {
      res.writeHead(409);
      return res.end('The 9:00 AM search must be exhausted before adding the backup.');
    }
    if (!snapshot.drivers.some(driver => driver.id === 'd4')) backend.mutate(state => {
      const template = state.drivers.find(driver => driver.id === 'd1');
      state.drivers.push({
        id:'d4', name:'Jordan Lee', phone:'+15550101004', status:'online', seats:4,
        capabilities:[], plate:'DEMO 404', vehicle:'Demo sedan',
        lat:template.lat, lng:template.lng, lastLocationAt:clock
      });
    });
    sessions.backup = (await call('/api/demo-login',roles.backup)).cookie;
    await call('/api/trips/' + ride.id + '/action', {action:'manual_offer', driverId:'d4', reason:'Owner reviewed availability'}, sessions.owner);
    return res.end('Offer sent to Jordan Lee. Waiting for acceptance.');
  }
  if (req.method === 'POST' && req.url === '/retry-search' && !pendingReset) {
    const snapshot = backend.load();
    const ride = snapshot.trips.find(trip => /900-802-A$/.test(trip.reference));
    if (!ride?.dispatchExhausted || !snapshot.offers.some(offer =>
      offer.tripId === ride.id && offer.driverId === 'd4' && offer.status === 'declined')) {
      res.writeHead(409);
      return res.end('Wait until Jordan declines and the ride needs attention.');
    }
    if (!snapshot.drivers.some(driver => driver.id === 'd5')) {
      backend.mutate(state => {
        const template = state.drivers.find(driver => driver.id === 'd1');
        state.drivers.push({
          id:'d5', name:'Taylor Brooks', phone:'+15550101005', status:'online', seats:4,
          capabilities:[], plate:'DEMO 505', vehicle:'Demo sedan',
          lat:template.lat, lng:template.lng, lastLocationAt:clock
        });
      });
    }
    sessions.retry ??= (await call('/api/demo-login',roles.retry)).cookie;
    backend.mutate(state => {
      const trip = state.trips.find(item => item.id === ride.id);
      // The replay checks new availability while preserving the earlier declines.
      trip.retryAt = clock;
      domain.tick(state,clock);
    });
    await call('/api/driver/status',{status:'online'},sessions.retry);
    return res.end('Driver search retried with Taylor Brooks online.');
  }
  if (req.method === 'POST' && req.url.startsWith('/reschedule-pickup?') && !pendingReset) {
    const time = new URL(req.url,'http://localhost').searchParams.get('time');
    const ride = backend.load().trips.find(trip => /900-802-A$/.test(trip.reference));
    if (!ride?.dispatchExhausted || !['awaiting_driver','needs_reassignment'].includes(ride.status)) {
      res.writeHead(409);
      return res.end('The ride must be in Needs Attention with no active offer.');
    }
    const [hour, minute] = (time || '').split(':').map(Number);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) {
      res.writeHead(400);
      return res.end('Enter a valid pickup time in Eastern Time.');
    }
    const original = initial.trips.find(trip => trip.id === ride.id);
    const serviceStart = original.pickupAt - 9 * 3600000;
    const pickupAt = serviceStart + (hour * 60 + minute) * 60000;
    if (pickupAt <= clock || pickupAt === ride.pickupAt) {
      res.writeHead(400);
      return res.end('Choose a different future pickup time.');
    }
    clock = Math.max(clock, pickupAt - 15 * 60000);
    backend.mutate(state => {
      const trip = state.trips.find(item => item.id === ride.id);
      const delta = pickupAt - trip.pickupAt;
      trip.pickupAt = pickupAt;
      trip.demoRescheduled = true;
      // Declines applied to the old pickup time. Preserve driver releases.
      trip.excluded = [...(trip.droppedDrivers || [])];
      if (Number.isFinite(trip.plannedEndAt)) trip.plannedEndAt += delta;
      trip.status = 'awaiting_driver';
      trip.dispatchExhausted = false;
      trip.dispatchError = '';
      trip.redFlag = false;
      trip.retryAt = Math.max(clock,pickupAt - 15 * 60000);
      domain.event(state,'trip.rescheduled',trip,'Fleet owner','Pickup moved to ' + time + ' ET');
      domain.tick(state,clock);
    });
    const maya = backend.load().drivers.find(driver => driver.id === 'd1');
    await call('/api/driver/status',{status:maya.status},sessions.driver);
    return res.end('Pickup rescheduled to ' + time + ' ET.');
  }
  if (req.method === 'POST' && req.url === '/cancel-attention-ride' && !pendingReset) {
    const ride = backend.load().trips.find(trip => /900-802-A$/.test(trip.reference));
    if (!ride?.dispatchExhausted || !['awaiting_driver','needs_reassignment'].includes(ride.status)) {
      res.writeHead(409);
      return res.end('The ride must be in Needs Attention to use this shortcut.');
    }
    const reason = (await new Response(req).text()).trim();
    if (!reason || reason.length > 200) {res.writeHead(400);return res.end('Enter a reason of up to 200 characters.');}
    await call('/api/trips/' + ride.id + '/action', {action:'cancel',reason}, sessions.owner);
    return res.end('Ride cancelled.');
  }
  if (pendingReset) {res.writeHead(503);return res.end('Demo reset in progress.');}
  if (req.method === 'POST' && ['/advance','/advance?maya=1'].includes(req.url)) {
    const next = backend.load().trips.filter(ride => ride.status === 'awaiting_driver')
      .sort((a,b) => a.pickupAt-b.pickupAt)[0];
    if (next) {
      clock = Math.max(clock,next.pickupAt-15*60000);
      backend.mutate(state => {
        const ride=state.trips.find(t=>t.id===next.id);
        const pin=req.url.endsWith('?maya=1')&&ride.reference.endsWith('900-802-A')&&
          !state.offers.some(o=>o.tripId===ride.id);
        if(pin){ride.plannedDriverId='d1';ride.plannedPickupAt=ride.pickupAt;}
        domain.tick(state,clock);
        if(pin){delete ride.plannedDriverId;delete ride.plannedPickupAt;}
      });
      const james = backend.load().drivers.find(driver => driver.id === 'd2');
      if (james.status !== 'busy') await call('/api/driver/status',{status:james.status},sessions.james);
    }
    return res.end(next ? 'Next offer is ready.' : 'No more pickups.');
  }
  const [, role, route] = req.url.match(/^\/([^/]+)(\/.*)$/) || [];
  if(/^fleet-test-[1-9][0-9]?$/.test(role||'')&&backend.load().drivers.some(d=>d.id===role)){
    roles[role]={role:'driver',driverId:role};
  }
  if (!Object.hasOwn(roles,role)) {
    const ref = req.headers.referer && new URL(req.headers.referer).pathname.split('/')[1];
    if (Object.hasOwn(roles,ref)) {res.writeHead(307,{Location:'/'+ref+req.url});return res.end();}
    res.writeHead(404);return res.end();
  }
  const requestSessions = sessions;
  if(!requestSessions[role]&&role.startsWith('fleet-test-'))requestSessions[role]=(await call('/api/demo-login',roles[role])).cookie;
  const headers = {...req.headers,host:new URL(backend.url).host,cookie:requestSessions[role]};
  if (headers.origin === 'http://' + req.headers.host) headers.origin = backend.url;
  let actionBody;
  const actionRoute = /^\/api\/trips\/([^/]+)\/action$/.exec(route);
  if (req.method === 'POST' && roles[role].driverId && actionRoute) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    actionBody = Buffer.concat(chunks);
    const {action} = JSON.parse(actionBody.toString());
    if(action==='accept'&&actionRoute[1]===acceptanceTestId){
      if(firstAcceptance&&firstAcceptance.role!==role)firstAcceptance.release();
      else if(!firstAcceptance)await new Promise(resolve=>{
        const release=()=>{clearTimeout(timer);firstAcceptance=null;resolve();};
        const timer=setTimeout(release,15000);
        firstAcceptance={role,release};
      });
    }
  }
  const upstream = http.request(backend.url + route,{method:req.method,headers},response => {
    if (response.headers['set-cookie']) requestSessions[role] = response.headers['set-cookie'][0].split(';')[0];
    delete response.headers['set-cookie'];
    if (route === '/') {
      delete response.headers['x-frame-options'];
      response.headers['content-security-policy'] = response.headers['content-security-policy'].replace("frame-ancestors 'none'","frame-ancestors 'self'");
    }
    res.writeHead(response.statusCode,response.headers);
    response.pipe(res);
  });
  res.on('close',()=>upstream.destroy());
  upstream.on('error',()=>res.destroy());
  if (actionBody) upstream.end(actionBody);
  else req.pipe(upstream);
}

resetDemo({preserveCompletedFleet:true}).then(() => http.createServer((req,res) => {
  serve(req,res).catch(error => {console.error(error);if(!res.headersSent)res.writeHead(500);res.end('Demo request failed.');});
}).listen(port,host,()=>console.log('Ready on http://'+host+':'+port))).catch(error => {
  console.error(error);
  process.exitCode = 1;
});







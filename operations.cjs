const crypto=require('node:crypto');
const defaults={dispatchLeadMinutes:15,urgentGroupEnabled:true,urgentGroupMinutes:5,urgentGroupSize:3,customerReminderMinutes:10,customerRemindersEnabled:true,timezone:'America/New_York',companyName:'ProLift'};
function normalize(s){s.customerPreferences ||= {};s.settings={...defaults,...s.settings};s.customerMessages ||= [];s.assignmentHistory ||= [];s.reservations ||= [];s.supportRequests ||= [];return s;}
function settings(s){return {...defaults,...s.settings};}
function validateSettings(body){
  const next={...defaults,...body};
  for(const field of ['dispatchLeadMinutes','customerReminderMinutes'])if(!Number.isInteger(next[field])||next[field]<1||next[field]>180)throw Error('Timing must be a whole number between 1 and 180 minutes');
  if(typeof next.customerRemindersEnabled!=='boolean')throw Error('Choose whether reminders are enabled');
  if(typeof next.urgentGroupEnabled!=='boolean'||!Number.isInteger(next.urgentGroupMinutes)||next.urgentGroupMinutes<1||next.urgentGroupMinutes>30||![2,3].includes(next.urgentGroupSize))throw Error('Urgent offers require a 1–30 minute window and a group of 2 or 3 drivers');
  next.companyName=String(next.companyName).trim();if(!next.companyName||next.companyName.length>80)throw Error('Company name must be 1–80 characters');
  try{new Intl.DateTimeFormat('en-US',{timeZone:next.timezone}).format();}catch{throw Error('Enter a valid timezone');}
  return Object.fromEntries(Object.keys(defaults).map(key=>[key,next[key]]));
}
function formatTime(s,time){return new Intl.DateTimeFormat('en-US',{timeZone:settings(s).timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(time))+' ('+settings(s).timezone+')';}
function vehicleSnapshot(driver){return {vehicleId:driver.vehicleId||'vehicle-'+crypto.createHash('sha256').update(driver.plate||driver.id).digest('hex').slice(0,12),vehicle:driver.vehicle||'Not recorded',plate:driver.plate||'Not recorded',color:driver.color||null};}
function message(s,t,type,text,assignmentId,now){
  normalize(s);const key=`${t.id}:${assignmentId}:${type}`;
  if(s.customerMessages.some(m=>m.key===key))return;
  s.customerMessages.unshift({id:crypto.randomUUID(),key,tripId:t.id,reference:t.reference,assignmentId,type,recipient:t.customerPhone,customerName:t.customerName,text,createdAt:now,status:'demo_logged',channel:'sms',deliveryNote:'Demo outbox only — no SMS sent'});
}
function confirmed(s,t,driver,offer,now){
  normalize(s);const v=vehicleSnapshot(driver);
  t.confirmedDriver={driverId:driver.id,name:driver.name,phone:driver.contactPhone||driver.phone,...v};t.assignmentId=offer.id;t.confirmedAt=now;
  s.assignmentHistory.push({id:offer.id,tripId:t.id,reference:t.reference,pickupAt:t.pickupAt,driverId:driver.id,driverName:driver.name,...v,assignedAt:now,startedAt:null,endedAt:null,outcome:'active'});
  const p=settings(s),car=[v.color,v.vehicle].filter(Boolean).join(' ');
  message(s,t,'confirmed',`${p.companyName}: Your ride ${t.reference} is confirmed. Pickup: ${t.pickup}, ${formatTime(s,t.pickupAt)}. Driver: ${driver.name}. Driver phone: ${driver.contactPhone||driver.phone||'Contact dispatch'}. Car: ${car}. Plate: ${v.plate}. Destination: ${t.destination}. Open ProLift to track your ride.`,offer.id,now);
  if(now>=t.pickupAt-p.customerReminderMinutes*60000)t.reminderCoveredByAssignment=offer.id;
}
function started(s,t,now){normalize(s);t.startedAt=now;const row=s.assignmentHistory.find(a=>a.id===t.assignmentId);if(row)row.startedAt=now;}
function stage(s,t,phase,now){
  if(!t.assignmentId||!t.confirmedDriver)return;const p=settings(s),d=t.confirmedDriver;
  const text={depart:`Your driver ${d.name} is heading to ${t.pickup}. Car: ${d.vehicle}, plate ${d.plate}. Driver phone: ${d.phone||'contact dispatch'}.`,arrive:`Your driver ${d.name} has arrived at ${t.pickup}. Match car ${d.vehicle} and plate ${d.plate} before boarding.`,pickup:`Your ride is underway to ${t.destination}. Open ProLift for trip updates.`,complete:'Your ride is complete. Your trip summary, rating and help options are available in Ride history.'}[phase];
  if(text)message(s,t,'stage_'+phase,`${p.companyName}: ${t.reference}. ${text}`,t.assignmentId,now);
}
function outcome(s,t,result,now){
  normalize(s);const row=s.assignmentHistory.find(a=>a.id===t.assignmentId);if(row){row.outcome=result;row.endedAt=now;}
  if(['released','cancelled'].includes(result)&&t.assignmentId){
    for(const m of s.customerMessages)if(m.tripId===t.id&&m.assignmentId===t.assignmentId&&['confirmed','pickup_reminder'].includes(m.type))m.superseded=true;
    message(s,t,result,result==='released'?`${settings(s).companyName}: The driver for ${t.reference} is no longer assigned. We are finding a replacement; previous driver/car details no longer apply.`:`${settings(s).companyName}: Ride ${t.reference} has been cancelled. Previous driver/car details no longer apply.`,t.assignmentId,now);
    t.assignmentId=null;t.confirmedDriver=null;t.reminderCoveredByAssignment=null;
  }
}
function reminders(s,now){
  normalize(s);const p=settings(s);if(!p.customerRemindersEnabled)return false;let changed=false;
  for(const t of s.trips){
    if(!t.assignmentId||!t.confirmedDriver||!['accepted','heading_to_pickup','arrived'].includes(t.status)||now<t.pickupAt-p.customerReminderMinutes*60000||now>t.pickupAt||t.reminderCoveredByAssignment===t.assignmentId)continue;
    const before=s.customerMessages.length,d=t.confirmedDriver;
    message(s,t,'pickup_reminder',`${p.companyName}: Pickup reminder for ${t.reference}: ${formatTime(s,t.pickupAt)} at ${t.pickup}. Driver: ${d.name}, ${d.phone||'contact dispatch'}. Car: ${[d.color,d.vehicle].filter(Boolean).join(' ')}. Plate: ${d.plate}. Open ProLift for current trip updates.`,t.assignmentId,now);
    t.reminderCoveredByAssignment=t.assignmentId;changed ||= before!==s.customerMessages.length;
  }
  return changed;
}
function reports(s,{from=0,to=Date.now()+86400000,group='driver'}={}){
  normalize(s);if(!['driver','vehicle'].includes(group))throw Error('Choose driver or vehicle reports');
  if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)throw Error('Choose a valid report date range');
  const trips=s.trips.filter(t=>!t.isSharedRun&&t.pickupAt>=from&&t.pickupAt<to),ids=new Set(trips.map(t=>t.id));
  const groups=new Map();
  function row(key,name,detail=''){if(!groups.has(key))groups.set(key,{id:key,name,detail,offered:0,declined:0,timedOut:0,assignments:0,completed:0,released:0,cancelled:0,active:0,unrecorded:0,onboardMinutes:0,missingTiming:0});return groups.get(key);}
  for(const a of s.assignmentHistory.filter(a=>ids.has(a.tripId))){const r=group==='driver'?row(a.driverId,a.driverName):row(a.vehicleId,a.plate,a.vehicle);r.assignments++;r[a.outcome==='active'?'active':a.outcome]=(r[a.outcome==='active'?'active':a.outcome]||0)+1;if(a.outcome==='completed'&&a.startedAt&&a.endedAt>=a.startedAt)r.onboardMinutes+=(a.endedAt-a.startedAt)/60000;}
  // Older trips can be counted by recorded driver, but their car is never guessed
  // from today's driver profile. Keep missing historical vehicle data explicit.
  let legacyTrips=0;
  for(const t of trips.filter(t=>t.driverId&&!s.assignmentHistory.some(a=>a.tripId===t.id))){legacyTrips++;const d=s.drivers.find(d=>d.id===t.driverId);const r=group==='driver'?row(t.driverId,d?.name||t.driverId):row('unknown-legacy','Vehicle not recorded','Older trip; no assignment snapshot');r.assignments++;r[t.status==='completed'?'completed':t.status==='cancelled'?'cancelled':'active']++;if(t.startedAt&&t.completedAt>=t.startedAt)r.onboardMinutes+=(t.completedAt-t.startedAt)/60000;else if(t.status==='completed')r.missingTiming++;}
  for(const o of s.offers.filter(o=>ids.has(o.tripId)&&o.status==='accepted'&&!s.assignmentHistory.some(a=>a.id===o.id))){
    const trip=trips.find(t=>t.id===o.tripId);if(trip.driverId===o.driverId&&!s.assignmentHistory.some(a=>a.tripId===trip.id))continue;
    const d=s.drivers.find(d=>d.id===o.driverId),r=group==='driver'?row(o.driverId,d?.name||o.driverId):row('unknown-legacy','Vehicle not recorded','Older trip; no assignment snapshot');r.assignments++;r.unrecorded++;
  }
  if(group==='driver')for(const o of s.offers.filter(o=>ids.has(o.tripId))){const d=s.drivers.find(d=>d.id===o.driverId),r=row(o.driverId,d?.name||o.driverId);r.offered++;if(o.status==='declined')r.declined++;if(o.status==='expired')r.timedOut++;}
  const rows=[...groups.values()].map(r=>({...r,onboardMinutes:r.missingTiming&&r.onboardMinutes===0?null:Math.round(r.onboardMinutes*10)/10})).sort((a,b)=>a.id==='unknown-legacy'?1:b.id==='unknown-legacy'?-1:b.completed-a.completed||a.name.localeCompare(b.name));
  return {group,from,to,rows,legacyTrips,basis:'Scheduled pickup date; accepted assignment snapshots. Each reassignment counts as another assignment.',summary:{trips:trips.length,completedTrips:trips.filter(t=>t.status==='completed').length,cancelledTrips:trips.filter(t=>t.status==='cancelled').length,unassigned:trips.filter(t=>!t.driverId&&!['completed','cancelled'].includes(t.status)).length}};
}
function csv(report){
  const fields=report.group==='driver'?['name','id','offered','declined','timedOut','assignments','completed','released','cancelled','active','unrecorded','onboardMinutes']:['name','detail','assignments','completed','released','cancelled','active','unrecorded','onboardMinutes'];
  const cell=v=>{let text=String(v??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
  const labels={name:report.group==='driver'?'Driver':'Plate',id:'Driver ID',detail:'Vehicle',offered:'Offers',declined:'Declines',timedOut:'Timed out',assignments:'Assignments',completed:'Completed',released:'Dropped',cancelled:'Cancelled',active:'Active',unrecorded:'Outcome not recorded',onboardMinutes:'Recorded minutes onboard'};
  return '\uFEFF'+[fields.map(f=>cell(labels[f])).join(','),...report.rows.map(r=>fields.map(f=>cell(r[f])).join(','))].join('\r\n');
}
module.exports={defaults,normalize,settings,validateSettings,confirmed,started,stage,outcome,reminders,reports,csv};

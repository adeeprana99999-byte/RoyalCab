const D=require('./domain.cjs'),Operations=require('./operations.cjs');
function projectForecasts(state,routing,now) {
 const drivers=new Map(state.drivers.map(driver=>[driver.id,driver]));
 const places=new Map((routing.places||D.places).map(place=>[place.name,place]));
 for(const trip of state.trips){
  const forecast=routing.pickupForecast(trip,drivers.get(trip.driverId),places.get(trip.pickup),now);
  if(forecast) trip.pickupForecast=forecast;
 }
}
function inspect(s,t,now=Date.now()){
 if(!t)throw Error('Trip not found');
 const pending=s.offers.find(o=>o.tripId===t.id&&o.status==='pending'&&o.expiresAt>now),lead=Operations.settings(s).dispatchLeadMinutes;
 const ignored=s.offers.filter(o=>o.tripId===t.id&&o.status==='pending').map(o=>o.id),candidates=D.eligible(s,t,now,ignored),ranks=new Map(candidates.map((c,i)=>[c.driver.id,i+1]));
 const recovery=D.eligibility(s,D.recoveryTrip(s,t,null,now),now,ignored).sort((a,b)=>(a.eta??999)-(b.eta??999)||a.driver.id.localeCompare(b.driver.id));
 const phase=['completed','cancelled'].includes(t.status)?'closed':t.driverId?'confirmed':pending?'awaiting_reply':t.pickupAt>now+lead*60000?'scheduled':'searching';
 return {tripId:t.id,reference:t.reference,etaSource:s.roadRouting&&!t.demoRunId&&!t.lgtc?.test?'road':'simulated',phase,pickupAt:t.pickupAt,opensAt:t.pickupAt-lead*60000,pending:pending?{driverName:s.drivers.find(d=>d.id===pending.driverId)?.name,expiresAt:pending.expiresAt,attemptNumber:pending.attemptNumber}:null,chosenDriverId:t.driverId||pending?.driverId||null,
 recoveryCandidates:recovery.map(c=>({driverId:c.driver.id,name:c.driver.name,vehicle:c.driver.vehicle,plate:c.driver.plate,seats:c.driver.seats,eta:c.eta,arrivalAt:c.eta===null?null:now+c.eta*60000,eligible:c.eligible,reasons:c.reasons})),
 candidates:D.eligibility(s,t,now,ignored).map(c=>({driverId:c.driver.id,name:c.driver.name,vehicle:c.driver.vehicle,plate:c.driver.plate,eta:c.eta,eligible:c.eligible,rank:ranks.get(c.driver.id)||null,reasons:c.reasons})).sort((a,b)=>(a.rank||999)-(b.rank||999)||a.name.localeCompare(b.name)),
 attempts:s.offers.filter(o=>o.tripId===t.id).map(o=>({driver:s.drivers.find(d=>d.id===o.driverId)?.name||'Driver not recorded',status:o.status,attempt:o.attemptNumber,reason:o.declineReason||null,at:o.offeredAt||null})),at:now};
}
function readiness(s,now=Date.now()){
 if(s.roadRouting) projectForecasts(s,s.roadRouting,now);
 const active=s.trips.filter(t=>!t.poolParentId&&!t.demoRunId&&!['completed','cancelled'].includes(t.status));
 const rows=active.map(t=>{const pending=s.offers.find(o=>o.tripId===t.id&&o.status==='pending'&&o.expiresAt>now);let level='planned',reason='Scheduled for later';
 if(t.status==='onboard'){level='on_trip';reason='Passenger onboard';}
 else if(t.driverId){
   const overdue=t.pickupAt<now&&t.status!=='arrived', late=t.pickupForecast?.lateMinutes>0;
   level=overdue||late?'attention':'confirmed';
   reason=overdue?'Pickup time passed; check driver progress':late?'Road ETA predicts pickup '+t.pickupForecast.lateMinutes+' min late':'Driver accepted';
 }
 else if(t.redFlag||t.dispatchExhausted||t.reservationIssue||t.pickupAt<now){level='attention';reason=t.redFlag?'Driver dropped ride':t.reservationIssue?'Reserved driver unavailable':t.pickupAt<now?'Pickup overdue without a confirmed driver':'No remaining eligible driver';}
 else if(pending){level='reply';reason='Waiting for '+(s.drivers.find(d=>d.id===pending.driverId)?.name||'driver');}
 else if(t.pickupAt<=now+Operations.settings(s).dispatchLeadMinutes*60000){level='searching';reason='Searching for an eligible driver';}
 return {id:t.id,reference:t.reference,customerName:t.customerName,pickup:t.pickup,destination:t.destination,pickupAt:t.pickupAt,level,reason,driverName:s.drivers.find(d=>d.id===t.driverId)?.name||t.reservedDriverName||null};}).sort((a,b)=>Number(b.level==='attention')-Number(a.level==='attention')||a.pickupAt-b.pickupAt);
 return {at:now,counts:Object.fromEntries(['attention','searching','reply','confirmed','on_trip','planned'].map(k=>[k,rows.filter(r=>r.level===k).length])),rows};
}
module.exports={inspect,readiness,projectForecasts};

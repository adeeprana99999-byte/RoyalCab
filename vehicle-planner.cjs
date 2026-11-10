'use strict';
const crypto=require('node:crypto');
const R=require('./reservations.cjs');
const closed=t=>['completed','cancelled'].includes(t.status);
function plannedDriver(trip) {
 return trip.plannedDriverId && trip.plannedPickupAt===trip.pickupAt &&
  !(trip.excluded || []).includes(trip.plannedDriverId) ? trip.plannedDriverId : null;
}
function minutes(a,b){return Math.max(1,Math.ceil(Math.hypot((a.lat-b.lat)*111,(a.lng-b.lng)*84)*1.25/.5));}
function build(s,places,now=Date.now(),options={}){
 const preferredDriver=options.preferredDriver || (trip=>require('./domain.cjs').regularDriver(s,trip));
 const includeTrip=options.includeTrip || (trip=>trip.pickupAt<=now+86400000);
 const savedPlan=trip=>options.keepPlans&&plannedDriver(trip);
 const place=name=>places.find(p=>p.name===name),cars=[],unplanned=[];
 for(const d of s.drivers){
  if(s.offers.some(o=>o.driverId===d.id&&o.status==='pending'&&o.expiresAt>now))continue;
  if(!['online','busy'].includes(d.status)||['device','replay'].includes(d.locationSource)||!Number.isFinite(d.lat)||!Number.isFinite(d.lng)||!Number.isFinite(d.lastLocationAt)||now-d.lastLocationAt>120000||now<d.lastLocationAt)continue;
  if(cars.some(c=>R.sameVehicle(c.driver,d)))continue;
  let ready=now,position={lat:d.lat,lng:d.lng};const active=s.trips.find(t=>!t.poolParentId&&t.driverId===d.id&&!closed(t));
  if(d.status==='busy'&&!active)continue;
  if(active){const from=place(active.pickup),to=place(active.destination);if(!from||!to)continue;ready=active.status==='onboard'?now+(minutes(position,to)+5)*60000:Math.max(now+minutes(position,from)*60000,active.pickupAt)+(minutes(from,to)+5)*60000;position=to;}
  cars.push({driver:d,ready,position,stops:[],commitments:s.trips.filter(t=>!closed(t)&&!t.poolParentId&&t.id!==active?.id&&
    (t.reservedDriverId===d.id||t.driverId===d.id||!t.driverId&&t.pickupAt>=now&&(t.isSharedRun||savedPlan(t))&&plannedDriver(t)===d.id)),activeTripId:active?.id||null});
 }
 const trips=s.trips.filter(t=>['awaiting_driver','needs_reassignment'].includes(t.status)&&!t.driverId&&!t.reservedDriverId&&!t.poolParentId&&!t.isSharedRun&&!savedPlan(t)&&t.pickupAt>=now&&includeTrip(t)&&!s.offers.some(o=>o.tripId===t.id&&o.status==='pending'&&o.expiresAt>now));
 const preferences=new Map(trips.map(t=>[t.id,preferredDriver(t)]));
 trips.sort((a,b)=>Number(!!preferences.get(b.id))-Number(!!preferences.get(a.id))||a.pickupAt-b.pickupAt||b.passengers-a.passengers||a.id.localeCompare(b.id));
 for(const t of trips){
  const from=place(t.pickup),to=place(t.destination);let options=[];
  if(from&&to)for(const car of cars){const d=car.driver;if((d.demoRunId||null)!==(t.demoRunId||null)||d.seats<t.passengers||!t.requirements.every(r=>d.capabilities.includes(r))||(t.excluded||[]).includes(d.id))continue;
   let at=car.ready,pos=car.position,valid=true;
   const sequence=[...car.stops.map(x=>s.trips.find(t=>t.id===x.tripId)),...car.commitments,t].sort((a,b)=>a.pickupAt-b.pickupAt||a.id.localeCompare(b.id));
   // Re-evaluate the complete car schedule from its actual current work.
   let startReady=now,startPos={lat:d.lat,lng:d.lng};if(car.activeTripId){const a=s.trips.find(t=>t.id===car.activeTripId),af=place(a.pickup),ad=place(a.destination);startReady=a.status==='onboard'?now+(minutes(startPos,ad)+5)*60000:Math.max(now+minutes(startPos,af)*60000,a.pickupAt)+(minutes(af,ad)+5)*60000;startPos=ad;}
   at=startReady;pos=startPos;let chosen,stops=[];
   for(const ride of sequence){const a=place(ride.pickup),b=place(ride.destination);if(!a||!b){valid=false;break;}const travel=minutes(pos,a),arrival=at+travel*60000;if(arrival>ride.pickupAt){valid=false;break;}const end=ride.pickupAt+((ride.routeDurationMinutes||minutes(a,b))+5)*60000;const stop={tripId:ride.id,reference:ride.reference,pickup:ride.pickup,destination:ride.destination,pickupAt:ride.pickupAt,arriveAt:arrival,endAt:end,passengers:ride.passengers,deadheadMinutes:travel,committed:ride.id!==t.id&&!car.stops.some(x=>x.tripId===ride.id)};stops.push(stop);if(ride.id===t.id)chosen=stop;at=end;pos=b;}
   if(valid)options.push({car,stops,chosen,at,pos,score:chosen.deadheadMinutes+(d.seats-t.passengers)*.6});
  }
  const preferred=preferences.get(t.id);
  options.sort((a,b)=>Number(b.car.driver.id===preferred)-Number(a.car.driver.id===preferred)||a.score-b.score||a.car.driver.seats-b.car.driver.seats||a.car.driver.id.localeCompare(b.car.driver.id));const best=options[0];
  if (!best) {
   const fits = s.drivers.some(d => (d.demoRunId || null) === (t.demoRunId || null) && d.seats >= t.passengers &&
    t.requirements.every(requirement => d.capabilities.includes(requirement)));
   const reason = !from || !to ? 'Location needs coordinates' : !fits ? 'No vehicle meets the seat and accessibility needs' :
    'No suitable car can reach this pickup on time without overlapping another ride';
   unplanned.push({tripId:t.id,reference:t.reference,passengers:t.passengers,reason});
   continue;
  }
  best.car.stops=best.stops.filter(x=>!x.committed);best.car.ready=best.at;best.car.position=best.pos;
 }
 return {id:crypto.randomUUID(),at:now,mode:'private',horizonHours:24,estimated:true,summary:{planned:cars.reduce((n,c)=>n+c.stops.length,0),unplanned:unplanned.length,carsUsed:cars.filter(c=>c.stops.length).length},cars:cars.filter(c=>c.stops.length).map(c=>({driverId:c.driver.id,name:c.driver.name,vehicle:c.driver.vehicle,plate:c.driver.plate,seats:c.driver.seats,activeTripId:c.activeTripId,stops:c.stops})),unplanned};
}
function apply(s,plan,actor,now=Date.now()){
 for(const t of s.trips){delete t.plannedDriverId;delete t.plannedPickupAt;}
 for(const c of plan.cars)for(const stop of c.stops){const t=s.trips.find(t=>t.id===stop.tripId);t.plannedDriverId=c.driverId;t.plannedPickupAt=t.pickupAt;t.autoDispatch=true;}
 s.vehiclePlan=plan;return plan;
}
module.exports={build,apply,minutes,plannedDriver};

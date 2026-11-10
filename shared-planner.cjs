'use strict';
const crypto=require('node:crypto'),Planner=require('./vehicle-planner.cjs'),Ops=require('./operations.cjs');
const uid=()=>crypto.randomUUID();
function build(s,places,now=Date.now(),options={}){
 const D=require('./domain.cjs');
 const includeTrip=options.includeTrip || (trip=>trip.pickupAt<=now+86400000);
 const preferredDriver=trip=>D.regularDriver(s,trip);
 const plannerOptions={...options,includeTrip,preferredDriver};
 const loc=n=>places.find(p=>p.name===n),candidates=s.trips.filter(t=>!t.poolParentId&&!t.isSharedRun&&['awaiting_driver','needs_reassignment'].includes(t.status)&&!t.driverId&&!t.reservedDriverId&&t.pickupAt>=now&&includeTrip(t)&&!(options.keepPlans&&Planner.plannedDriver(t))&&!s.offers.some(o=>o.tripId===t.id&&o.status==='pending'&&o.expiresAt>now)).sort((a,b)=>a.pickupAt-b.pickupAt||a.id.localeCompare(b.id));
 const groups=[];
 function route(members){let at=members[0].pickupAt,pos=loc(members[0].pickup),stops=[];if(!pos||!loc(members[0].destination))return null;for(const t of members){const target=loc(t.pickup);if(!target)return null;at=Math.max(t.pickupAt,at+(stops.length?Planner.minutes(pos,target)*60000:0));if(at>t.pickupAt+3*60000)return null;stops.push({tripId:t.id,reference:t.reference,pickup:t.pickup,pickupAt:t.pickupAt,plannedAt:at,passengers:t.passengers,customerName:t.customerName,customerPhone:t.customerPhone});pos=target;}return {stops,duration:Math.ceil((at-members[0].pickupAt)/60000)+Planner.minutes(pos,loc(members[0].destination))};}
 for(const t of candidates){let group=groups.find(g=>g[0].destination===t.destination&&preferredDriver(g[0])===preferredDriver(t)&&(!preferredDriver(t)||g.reduce((n,x)=>n+x.passengers,0)+t.passengers<=(s.drivers.find(d=>d.id===preferredDriver(t))?.seats??0))&&(g[0].demoRunId||null)===(t.demoRunId||null)&&t.pickupAt-g[0].pickupAt<=10*60000&&g.reduce((n,x)=>n+x.passengers,0)+t.passengers<=Math.min(7,Math.max(0,...s.drivers.filter(d=>(d.demoRunId||null)===(t.demoRunId||null)&&['online','busy'].includes(d.status)&&now-d.lastLocationAt<=120000&&!['device','replay'].includes(d.locationSource)&&[...g,t].every(x=>x.requirements.every(r=>d.capabilities.includes(r)))&&!s.offers.some(o=>o.driverId===d.id&&o.status==='pending'&&o.expiresAt>now)).map(d=>d.seats)))&&g.every(x=>loc(x.pickup)&&loc(t.pickup)&&Math.hypot((loc(x.pickup).lat-loc(t.pickup).lat)*111,(loc(x.pickup).lng-loc(t.pickup).lng)*84)<=2)&&route([...g,t]));if(group)group.push(t);else groups.push([t]);}
 const runs=groups.map(g=>{const r=route(g);return {...g[0],id:g.length>1?'shared-plan-'+uid():g[0].id,reference:g.length>1?'SHARED · '+g.map(t=>t.reference).join(' + '):g[0].reference,passengers:g.reduce((n,t)=>n+t.passengers,0),requirements:[...new Set(g.flatMap(t=>t.requirements))],excluded:[...new Set(g.flatMap(t=>t.excluded||[]))],members:g.map(t=>t.id),sharedStops:r?.stops||[],routeDurationMinutes:r?.duration};});
 const removed=new Set(candidates.map(t=>t.id)),temp={...s,trips:[...s.trips.filter(t=>!removed.has(t.id)),...runs]};
 const plan=Planner.build(temp,places,now,plannerOptions);plan.mode='shared';plan.summary.bookings=0;
 for(const c of plan.cars)for(const stop of c.stops){const run=runs.find(r=>r.id===stop.tripId);stop.members=run.members;stop.sharedStops=run.sharedStops;stop.routeDurationMinutes=run.routeDurationMinutes;stop.requirements=run.requirements;plan.summary.bookings+=run.members.length;}
 // A combined run that cannot fit a car is split and reconsidered as individual bookings.
 const failed=new Set(plan.unplanned.map(t=>t.tripId));const retry=candidates.filter(t=>runs.some(r=>failed.has(r.id)&&r.members.includes(t.id)));if(retry.length){
  const usedIds=new Set(plan.cars.flatMap(c=>c.stops.flatMap(t=>t.members))),usedCars=new Set(plan.cars.map(c=>c.driverId));
  const fallback=Planner.build({...s,drivers:s.drivers.filter(d=>!usedCars.has(d.id)),trips:s.trips.filter(t=>!usedIds.has(t.id)&&(!removed.has(t.id)||retry.some(x=>x.id===t.id)))},places,now,plannerOptions);
  for(const c of fallback.cars){for(const stop of c.stops){stop.members=[stop.tripId];stop.sharedStops=[];plan.summary.bookings++;}plan.cars.push(c);}plan.unplanned=fallback.unplanned;
 }
 plan.summary.planned=plan.cars.reduce((n,c)=>n+c.stops.length,0);plan.summary.carsUsed=plan.cars.length;plan.summary.unplanned=plan.unplanned.length;return plan;
}
function apply(s,plan,actor,now){
 const originals=new Map(s.trips.map(t=>[t.id,t]));
 for(const car of plan.cars)for(const run of car.stops){
  if(run.members.length===1){const t=originals.get(run.members[0]);t.plannedDriverId=car.driverId;t.plannedPickupAt=t.pickupAt;t.autoDispatch=true;continue;}
  const members=run.members.map(id=>originals.get(id));if(members.some(t=>!t||t.poolParentId||t.driverId))throw Error('A booking changed. Build the schedule again.');
  const base=members[0],parent={...base,id:'shared-'+uid(),reference:'POOL-'+uid().slice(0,6).toUpperCase(),customerName:members.length+' shared bookings',customerPhone:'shared-run',passengers:run.passengers,requirements:run.requirements,droppedDrivers:[...new Set(members.flatMap(t=>t.droppedDrivers||[]))],recoveryUntil:0,recoveryDriverIds:[],excluded:[...new Set(members.flatMap(t=>t.excluded||[]))],isSharedRun:true,sharedStops:run.sharedStops,collectedStops:0,routeDurationMinutes:run.routeDurationMinutes,plannedDriverId:car.driverId,plannedPickupAt:base.pickupAt,status:'awaiting_driver',driverId:null,autoDispatch:true,redFlag:members.some(t=>t.redFlag),createdAt:now};
  s.trips.push(parent);for(const t of members){t.poolParentId=parent.id;t.status='pooled';t.autoDispatch=false;}run.appliedTripId=parent.id;
 }
 s.vehiclePlan=plan;return plan;
}
function sync(s,parent,now){
 if(!parent?.isSharedRun)return;
 for(let i=0;i<parent.sharedStops.length;i++){
  const child=s.trips.find(t=>t.id===parent.sharedStops[i].tripId);if(!child||child.poolParentId!==parent.id)continue;
  if(parent.driverId&&!child.driverId){const d=s.drivers.find(d=>d.id===parent.driverId);Ops.confirmed(s,child,d,{id:parent.assignmentId+':'+child.id},now);}
  if(!parent.driverId&&child.driverId)Ops.outcome(s,child,parent.status==='cancelled'?'cancelled':'released',now);
  child.driverId=parent.driverId;child.redFlag=parent.redFlag;
  const picked=i<(parent.collectedStops||0),current=i===(parent.collectedStops||0);
  const next=parent.status==='completed'?'completed':parent.status==='cancelled'?'cancelled':picked?'onboard':parent.driverId?(current&&['arrived','heading_to_pickup'].includes(parent.status)?parent.status:'accepted'):'pooled';
  if(child.status!==next){if(next==='onboard')Ops.started(s,child,now);if(next==='completed'){Ops.outcome(s,child,'completed',now);child.completedAt=now;}if(next==='cancelled')Ops.outcome(s,child,'cancelled',now);const phase={heading_to_pickup:'depart',arrived:'arrive',onboard:'pickup',completed:'complete'}[next];if(phase)Ops.stage(s,child,phase,now);child.status=next;}
 }
}
module.exports={build,apply,sync};

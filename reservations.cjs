const crypto=require('node:crypto');
const Operations=require('./operations.cjs');
const active=r=>r.status==='reserved';
function sameVehicle(a,b){return a.vehicleId&&b.vehicleId?a.vehicleId===b.vehicleId:!!a.plate&&a.plate===b.plate;}
function minutes(a,b){return Math.max(1,Math.ceil(Math.hypot((a.lat-b.lat)*111,(a.lng-b.lng)*84)*1.25/.5));}
function locations(t,places){const from=places.find(p=>p.name===t.pickup),to=places.find(p=>p.name===t.destination);if(!from||!to)throw Error('Trip locations need review before reserving');return {from,to};}
function window(t,s,places){const {from,to}=locations(t,places);return {startsAt:t.pickupAt-Operations.settings(s).dispatchLeadMinutes*60000,endsAt:t.pickupAt+((t.routeDurationMinutes||minutes(from,to))+5)*60000};}
function current(s,tripId){return(s.reservations||[]).find(r=>r.tripId===tripId&&active(r));}
function resourceBusy(s,driver){return s.trips.some(t=>t.driverId&& !['completed','cancelled'].includes(t.status)&&t.driverId!==driver.id&&sameVehicle(driver,t.confirmedDriver||s.drivers.find(d=>d.id===t.driverId)||{}));}
function conflicts(s,driver,t,places,now=Date.now()){
  const w=window(t,s,places),start=now,end=Math.max(t.pickupAt,now)+(w.endsAt-t.pickupAt);
  return(s.reservations||[]).some(r=>active(r)&&r.tripId!==t.id&&(r.driverId===driver.id||sameVehicle(driver,r))&&r.startsAt<end&&r.endsAt>start);
}
function reserve(s,t,driverId,places,now=Date.now()){
  Operations.normalize(s);const d=s.drivers.find(d=>d.id===driverId);if(!d||!t)throw Error('Trip or driver not found');
  const lead=Operations.settings(s).dispatchLeadMinutes;
  if(t.status!=='awaiting_driver'||t.driverId||current(s,t.id))throw Error('This ride is already assigned, offered or reserved');
  if(t.pickupAt<=now+lead*60000||t.pickupAt>now+7*86400000)throw Error('Reserve rides outside the dispatch window and within the next 7 days');
  if((d.demoRunId||null)!==(t.demoRunId||null))throw Error('Demo and ordinary fleet reservations are separate');
  if(d.seats<t.passengers||!t.requirements.every(r=>d.capabilities.includes(r)))throw Error('Your vehicle does not meet this ride’s requirements');
  const w=window(t,s,places);
  if(s.reservations.some(r=>active(r)&&(r.driverId===d.id||sameVehicle(d,r))&&r.startsAt<w.endsAt&&r.endsAt>w.startsAt))throw Error('This overlaps another driver or vehicle reservation');
  for(const ride of s.trips.filter(x=>x.driverId&&!['completed','cancelled'].includes(x.status))){
    const assigned=s.drivers.find(d=>d.id===ride.driverId);if(ride.driverId!==d.id&&!sameVehicle(d,ride.confirmedDriver||assigned||{}))continue;
    const {from,to}=locations(ride,places),position=assigned||from;
    const estimatedEnd=ride.status==='onboard'?now+(minutes(position,to)+5)*60000:Math.max(now+minutes(position,from)*60000,ride.pickupAt)+((ride.routeDurationMinutes||minutes(from,to))+5)*60000;
    if(estimatedEnd>w.startsAt)throw Error('Your current ride may overlap this pickup');
  }
  const r={id:'reservation-'+crypto.randomUUID(),tripId:t.id,driverId:d.id,driverName:d.name,plate:d.plate,vehicleId:d.vehicleId||null,vehicle:d.vehicle,...w,status:'reserved',createdAt:now};
  s.reservations.push(r);t.reservedDriverId=d.id;t.reservedDriverName=d.name;t.reservationIssue=false;return r;
}
function release(s,t,status,reason,now=Date.now()){
  const r=current(s,t.id);if(!r)return null;r.status=status;r.reason=reason;r.updatedAt=now;t.reservedDriverId=null;t.reservedDriverName=null;return r;
}
function scheduled(s,driverId,places,now=Date.now(),page=1){
  Operations.normalize(s);const d=s.drivers.find(d=>d.id===driverId);if(!d)throw Error('Driver not found');
  const rows=s.trips.filter(t=>(t.demoRunId||null)===(d.demoRunId||null)&&t.status==='awaiting_driver'&&t.pickupAt>now&&t.pickupAt<=now+7*86400000&&!t.driverId)
    .filter(t=>!current(s,t.id)||current(s,t.id).driverId===d.id).sort((a,b)=>a.pickupAt-b.pickupAt);
  const pages=Math.max(1,Math.ceil(rows.length/25)),selected=Math.max(1,Math.min(page,pages));
  return {page:selected,pages,total:rows.length,trips:rows.slice((selected-1)*25,selected*25).map(t=>({id:t.id,reference:t.reference,pickup:t.pickup,destination:t.destination,pickupAt:t.pickupAt,passengers:t.passengers,requirements:t.requirements,reservation:current(s,t.id)||null,window:window(t,s,places),suitable:d.seats>=t.passengers&&t.requirements.every(r=>d.capabilities.includes(r))}))};
}
module.exports={current,window,reserve,release,scheduled,conflicts,resourceBusy,sameVehicle};

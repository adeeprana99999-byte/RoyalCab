const crypto=require('node:crypto');
const categories={late_pickup:'Driver is late',booking_question:'Booking question',vehicle_issue:'Vehicle issue',lost_item:'Lost item'};
function authorized(t,user){return user.role==='owner'||user.role==='customer'&&t.customerPhone===user.phone||user.role==='driver'&&t.driverId===user.driverId;}
function request(s,t,user,body,now=Date.now()){
  if(!t||!authorized(t,user))throw Error('This trip is not available to your account');
  if(!categories[body.category])throw Error('Choose a support category');
  if(body.category==='lost_item'&&t.status!=='completed')throw Error('Lost-item requests are available after completing the ride');
  const details=user.role==='driver'?categories[body.category]+' — driver requests dispatch assistance':String(body.details||'').trim();
  if(details.length<5||details.length>1000)throw Error('Describe the issue in 5–1000 characters');
  s.supportRequests ||= [];
  const duplicate=s.supportRequests.find(r=>r.tripId===t.id&&r.createdBy===user.role+':'+(user.phone||user.driverId||'owner')&&r.category===body.category&&r.status!=='resolved');
  if(duplicate)return duplicate;
  const r={id:'help-'+crypto.randomUUID(),tripId:t.id,reference:t.reference,customerPhone:t.customerPhone,createdBy:user.role+':'+(user.phone||user.driverId||'owner'),createdByRole:user.role,createdByName:user.name,category:body.category,details,status:'open',ownerReply:'',createdAt:now,updatedAt:now};s.supportRequests.unshift(r);return r;
}
function summary(s,t,user){
  if(!t||!authorized(t,user))throw Error('This trip is not available to your account');
  if(t.status!=='completed')throw Error('The ride summary is available after completion');
  const a=(s.assignmentHistory||[]).find(a=>a.id===t.assignmentId),d=t.confirmedDriver;
  return {reference:t.reference,passenger:t.customerName,pickup:t.pickup,destination:t.destination,scheduledPickup:t.pickupAt,startedAt:t.startedAt||a?.startedAt||null,completedAt:t.completedAt||a?.endedAt||null,driver:d?.name||a?.driverName||'Not recorded',vehicle:d?.vehicle||a?.vehicle||'Not recorded',plate:d?.plate||a?.plate||'Not recorded',rating:t.rating||null,note:'Ride summary only. This is not a payment or tax receipt; no fare was processed.'};
}
function summaryText(report){return ['PROLIFT — COMPLETED RIDE SUMMARY','Trip: '+report.reference,'Passenger: '+report.passenger,'Pickup: '+report.pickup,'Destination: '+report.destination,'Scheduled pickup: '+new Date(report.scheduledPickup).toISOString(),'Started: '+(report.startedAt?new Date(report.startedAt).toISOString():'Not recorded'),'Completed: '+(report.completedAt?new Date(report.completedAt).toISOString():'Not recorded'),'Driver: '+report.driver,'Vehicle: '+report.vehicle,'Plate: '+report.plate,'Rating: '+(report.rating||'Not rated'),'',report.note].join('\r\n');}
module.exports={categories,authorized,request,summary,summaryText};

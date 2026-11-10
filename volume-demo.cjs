'use strict';
const D=require('./domain.cjs'),Ops=require('./operations.cjs'),{spots}=require('./charlotte-fleet.cjs');
function seed(s,now=Date.now()){
 if(s.volumeDemo&&s.trips.filter(t=>t.demoRunId===s.volumeDemo.runId).length===500)return s.volumeDemo;
 if(s.volumeDemo)throw Error('Existing test dataset changed; review it before adding another batch');
 const runId=D.id('volume-500'),drivers=Array.from({length:20},(_,i)=>{const p=spots[i%spots.length];return {id:D.id('volume-car'),name:'TEST Car '+String(i+1).padStart(2,'0'),phone:'+1555088'+String(i+1).padStart(4,'0'),status:'online',seats:i%3===0?7:4,capabilities:i%5===0?['wheelchair']:[],vehicle:i%3===0?'Test 7-seat van':'Test 4-seat sedan',plate:'LOAD '+String(i+1).padStart(3,'0'),lat:p.lat+(Math.floor(i/4)-2)*.001,lng:p.lng+(i%3-1)*.001,lastLocationAt:now,demoRunId:runId,demoScenario:'volume-500',testData:true};});
 s.drivers.push(...drivers);
 for(let i=0;i<500;i++){
  const from=i%4,to=(from+1+i%3)%4,completed=i<100,cancelled=i>=100&&i<150,current=i>=150&&i<160,attention=i>=160&&i<200,due=i>=200&&i<300;
  const pickupAt=completed?now-(40+i*3)*60000:cancelled?now-(30+(i-100)*2)*60000:current?now-5*60000:attention?now-(10+i%20)*60000:due?now+(5+i%10)*60000:now+(60+(i-300)*6)*60000;
  const t={id:D.id('volume-trip'),reference:'LOAD-'+String(i+1).padStart(4,'0'),customerName:'TEST Rider '+String(i+1).padStart(4,'0'),customerPhone:'+1555090'+String(i+1).padStart(4,'0'),pickup:spots[from].name,destination:spots[to].name,pickupAt,passengers:[1,2,3,4,5,6,7][i%7],requirements:[],status:'awaiting_driver',driverId:null,redFlag:attention,excluded:[],createdAt:now,demoRunId:runId,demoScenario:'volume-500',testData:true,autoDispatch:attention||due||i>=300};
  if(completed||current){const d=drivers[(completed?i:i-150)%drivers.length];t.passengers=Math.min(t.passengers,d.seats);const assignedAt=completed?pickupAt-300000:now-600000,o={id:D.id('volume-offer'),tripId:t.id,driverId:d.id,status:'accepted',offeredAt:assignedAt-1000,respondedAt:assignedAt,expiresAt:assignedAt+45000,attemptNumber:1,mode:'fixture'};s.offers.push(o);t.driverId=d.id;t.status=completed?'completed':i<155?'heading_to_pickup':'onboard';Ops.confirmed(s,t,d,o,assignedAt);if(completed||t.status==='onboard')Ops.started(s,t,completed?pickupAt:now-300000);if(completed){t.completedAt=pickupAt+25*60000;Ops.outcome(s,t,'completed',t.completedAt);}else d.status='busy';}
  else if(cancelled){t.status='cancelled';t.cancelledAt=pickupAt+60000;t.autoDispatch=false;}
  s.trips.push(t);
 }
 const result={runId,createdAt:now,count:500,drivers:20,initial:{completed:100,cancelled:50,current:10,attention:40,due:100,later:200}};s.volumeDemo=result;D.event(s,'demo.volume_created',null,'Owner','500 isolated Charlotte test bookings; no real passengers or messages');return result;
}
module.exports={seed};

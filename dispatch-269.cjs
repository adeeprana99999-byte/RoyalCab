const fs=require('node:fs');
const D=require('./domain.cjs');
const base=Date.UTC(2026,10,14,5), hub=D.places[0];
const min=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
const rows=fs.readFileSync('data/lgtc-20261114-simulation-ready.csv','utf8').trim().split(/\r?\n/).slice(1).map(line=>Array.from(line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g),m=>m[1])).sort((a,b)=>a[5].localeCompare(b[5])||Number(a[3])-Number(b[3])).slice(0,269);
const s=D.seed(base,{customerRemindersEnabled:false});
s.drivers=Array.from({length:20},(_,i)=>({id:'test-'+String(i+1).padStart(2,'0'),name:'Test driver '+(i+1),status:'online',seats:i<6?7:4,capabilities:i<6?['wheelchair']:[],plate:'TEST-'+(i+1),vehicle:'Test car '+(i+1),lat:hub.lat,lng:hub.lng,lastLocationAt:base}));
s.trips=rows.map((r,i)=>({id:'test-ride-'+i,reference:r[4],pickup:hub.name,destination:hub.name,pickupAt:base+min(r[5])*60000,endAt:base+min(r[6])*60000,passengers:1,requirements:/accessible/i.test(r[2])?['wheelchair']:[],status:'awaiting_driver',driverId:null,excluded:[],autoDispatch:true,createdAt:base}));
const user=d=>({role:'driver',driverId:d.id,name:d.name});
const result=rows.map(r=>({reference:r[4],pickup:r[5],end:r[6],accessible:/accessible/i.test(r[2]),events:[]}));
const start=min(rows[0][5])-15, finish=Math.max(...rows.map(r=>min(r[6])));
for(let time=start;time<=finish;time++){
 const now=base+time*60000;
 for(const [i,t] of s.trips.entries()){
  const d=s.drivers.find(d=>d.id===t.driverId);
  if(t.status==='heading_to_pickup'&&now>=t.pickupAt){D.action(s,t,'arrive',user(d),{},now);D.action(s,t,'pickup',user(d),{},now);result[i].events.push([time,'Onboard',d.name]);}
  if(t.status==='onboard'&&now>=t.endAt){D.action(s,t,'complete',user(d),{},now);result[i].events.push([time,'Completed',d.name]);}
  if(!t.driverId&&t.autoDispatch&&now>=t.pickupAt){t.autoDispatch=false;result[i].events.push([time,'Needs Attention','',t.dispatchError||'Pickup window closed without an accepted offer']);}
 }
 D.tick(s,now);
 for(const o of s.offers.filter(o=>o.status==='pending')){
  const i=s.trips.findIndex(t=>t.id===o.tripId), t=s.trips[i], d=s.drivers.find(d=>d.id===o.driverId);
  D.action(s,t,'accept',user(d),{offerId:o.id},now);D.action(s,t,'depart',user(d),{},now);
  result[i].events.push([time,'Offer pending',d.name],[time+0.5,'Heading to pickup',d.name]);
 }
}
console.log(result.reduce((counts,r)=>{const status=r.events.at(-1)?.[1];counts[status]=(counts[status]||0)+1;return counts;},{}));
fs.writeFileSync('public/dispatch-269-data.json',JSON.stringify({start,finish,drivers:s.drivers.map(d=>d.name),rides:result}));

const fs = require('node:fs');
const path = require('node:path');
const { spots } = require('./charlotte-fleet.cjs');
const { workbook } = require('./excel.cjs');
const { easternPickup } = require('./lgtc.cjs');

const rider = {name:'Repeat Test Rider',phone:'+12025550109'};
const [pickup, dropoff] = spots.map(spot => spot.name);

function writeExampleFiles() {
  const eastern = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
  const today=eastern.format(new Date());
  const tomorrow=new Date(Date.parse(today+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  const [year,month,day]=tomorrow.split('-');
  const legs=['08','09'].map((hour,i)=>{
    const row=Array(38).fill('');
    Object.assign(row,{0:'MCD1',1:'551-10'+i+'-A',2:month+'/'+day+'/'+year,3:'A',4:rider.name,7:pickup,
      10:'Charlotte',11:'NC',12:'28202',14:hour+':00',16:dropoff,19:'Charlotte',20:'NC',21:'28202',
      23:hour+':30',28:rider.phone});
    return row.join(',');
  });
  const folder=path.join(__dirname,'demo-generated');
  fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'LGTC-next-day.csv'),legs.join('\n')+'\n');
  const rows=[['trip_id','pickup_at','customer_name','customer_phone','pickup','destination','passengers','requirements'],
    ['DEMO-XLSX-01',new Date(easternPickup(tomorrow,600)).toISOString(),rider.name,rider.phone,pickup,dropoff,'1','']];
  fs.writeFileSync(path.join(folder,'Planned-rides.xlsx'),workbook(rows));
  return folder;
}

async function start(createApp) {
  const hosted=process.env.PROLIFT_HOSTED_DEMO==='1';
  const password=hosted?(process.env.PROLIFT_PREVIEW_PASSWORD||''):undefined;
  const invite=hosted?process.env.PROLIFT_PREVIEW_INVITE_TOKEN:undefined;
  const app=createApp({dbPath:':memory:',hostedDemoPassword:password,hostedDemoInvite:invite});
  const port=Number(process.env.PORT||4720);
  await new Promise((resolve,reject)=>{
    app.server.once('error',reject);
    app.server.listen(port,hosted?'0.0.0.0':'127.0.0.1',resolve);
  }).catch(error=>{app.close();throw error;});
  const url='http://localhost:'+app.server.address().port;
  const apiRoot='http://127.0.0.1:'+app.server.address().port;
  const authorization=hosted?'Basic '+Buffer.from('preview:'+password,'utf8').toString('base64'):null;
  let cookie;
  async function post(route, body) {
    const response=await fetch(apiRoot+route,{method:'POST',
      headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{}),...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
    if(!response.ok) throw Error(route+' failed with HTTP '+response.status);
    if(response.headers.has('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
    return response.json();
  }
  try {
    await post('/api/demo-login',{role:'owner'});
    await post('/api/demo/volume',{});
    await post('/api/demo/queue-review',{});
    await post('/api/demo/shared-plan',{});
    await post('/api/demo/charlotte-fleet',{action:'start'});
    await post('/api/demo/tracking-replay',{action:'start'});
    await post('/api/demo/next-ride',{});
    await post('/api/demo/start-trip',{});
    await post('/api/lgtc/customer',{action:'save',...rider,driverId:'d1'});
    await post('/api/lgtc/settings',{enabled:true,driverIds:['d1','d2'],buffer:10,profiles:{A:{mode:'standard',base:1,extras:[]}}});
    const folder=writeExampleFiles();
    console.log(hosted?'RoyalCab / ProLift hosted demo listening on port '+app.server.address().port:'RoyalCab / ProLift demo '+url);
    console.log('Demo datasets loaded. Next-day LGTC and Excel files: '+folder);
  } catch(error) {
    app.close();
    app.server.closeAllConnections();
    app.server.close();
    throw error;
  }
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
    app.close();
    app.server.closeAllConnections();
    app.server.close(()=>process.exit());
  });
}
function startDemo(createApp) {
  return start(createApp).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

if (require.main === module) startDemo(require('./server.cjs').createApp);
module.exports = { startDemo };

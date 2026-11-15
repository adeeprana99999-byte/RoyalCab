const {xlsx}=require('./excel.cjs');

function validateRoster(file) {
  function rows(sheet, headers) {
    const all=xlsx(file,sheet);
    const head=all.findIndex(row=>headers.every(label=>row.includes(label)));
    if(head<0) throw Error('Use the original roster template with Driver roster first and Vehicles second.');
    return all.slice(head+1).flatMap((row,index)=>row.some(value=>String(value??'').trim()) ?
      [{line:head+index+2,...Object.fromEntries(headers.map(label=>[label,String(row[all[head].indexOf(label)]??'').trim()]))}] : []);
  }
  const vehicles=rows(2,['VIN','Confirmed status','Passenger seats','Wheelchair positions']);
  const drivers=rows(1,['Imported driver name','Confirmed account ID','Driver status','Confirmed current VIN','Service date (ET)','Shift start (ET)','Shift end (ET)']);
  const issues=[], fleet=new Map(), accounts=new Set(), shifts=[];
  const status=value=>['Enabled','Disabled'].includes(value);
  const integer=value=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value));
  const report=(sheet,row,message)=>issues.push({sheet,row:row.line,message});
  const vinOf=value=>value.toUpperCase();
  const date=value=>{
    if(integer(value)&&Number(value)>25569&&Number(value)<2958466)return new Date((Number(value)-25569)*86400000).toISOString().slice(0,10);
    const time=Date.parse(value+'T00:00:00Z');
    return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(time)&&new Date(time).toISOString().startsWith(value)?value:null;
  };
  const minutes=value=>{
    if(/^(?:0(?:\.\d+)?|\.\d+)$/.test(value))return Math.round(Number(value)*1440);
    if(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)){const [h,m]=value.split(':').map(Number);return h*60+m;}
    return null;
  };
  for(const row of vehicles){
    const issue=message=>report('Vehicles',row,message);
    const vin=vinOf(row.VIN), begin=issues.length;
    if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))issue('Enter a 17-character VIN.');
    if(fleet.has(vin)){issue('Duplicate VIN.');fleet.get(vin).valid=false;continue;}
    if(!status(row['Confirmed status']))issue('Confirm vehicle status.');
    if(row['Confirmed status']==='Enabled'){
      if(!integer(row['Passenger seats'])||Number(row['Passenger seats'])<1)issue('Confirm passenger seats excluding the driver.');
      if(!integer(row['Wheelchair positions']))issue('Confirm wheelchair positions, including 0 if applicable.');
    }
    fleet.set(vin,{valid:issues.length===begin,enabled:row['Confirmed status']==='Enabled', seats:Number(row['Passenger seats']), wheelchair:Number(row['Wheelchair positions'])});
  }
  for(const row of drivers){
    const issue=message=>report('Driver roster',row,message);
    const id=row['Confirmed account ID'].toLowerCase(), vin=vinOf(row['Confirmed current VIN']), vehicle=fleet.get(vin), begin=issues.length;
    if(!status(row['Driver status']))issue('Confirm driver status.');
    if(id&&accounts.has(id))issue('Duplicate driver account ID.');
    if(id)accounts.add(id);
    if(row['Driver status']!=='Enabled')continue;
    if(!id)issue('Confirm the driver account ID.');
    if(!vehicle?.valid||!vehicle.enabled)issue('Link an enabled vehicle with verified capacity using its VIN.');
    const day=date(row['Service date (ET)']), start=minutes(row['Shift start (ET)']), end=minutes(row['Shift end (ET)']);
    if(!day||start===null||end===null||start>=end||end>=1440)issue('Enter a valid same-day Eastern shift with end after start.');
    if(issues.length===begin){
      if(shifts.some(shift=>shift.vin===vin&&shift.day===day&&shift.start<end&&start<shift.end))issue('This vehicle is already linked to an overlapping shift.');
      else shifts.push({id,vin,day,start,end,seats:vehicle.seats,wheelchair:vehicle.wheelchair});
    }
  }
  if(!vehicles.length||!drivers.length)throw Error('Include at least one vehicle and one driver.');
  return {vehicles:vehicles.length,drivers:drivers.length,eligibleLinks:shifts.length,issues,links:shifts};
}
module.exports={validateRoster};


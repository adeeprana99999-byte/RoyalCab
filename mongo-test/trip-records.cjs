'use strict';

function importedTime(value) {
  const sourceTime=String(value ?? '').trim();
  const clockTime=/^([01]?\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(sourceTime);
  const minute=clockTime ? Number(clockTime[1])*60+Number(clockTime[2])
    : /^(?:0(?:\.\d+)?|\.\d+)$/.test(sourceTime) ? Math.round(Number(sourceTime)*1440) : 0;
  return minute>0 && minute<1440
    ? String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0') : '';
}
function tripRecords(db) {
  const collection=db.collection('lgtc_rides');
  return {
    async trips() {
      const rows=await collection.find({}, {
        projection:{reference:1,service_date:1,source_row:1,status:1,'details.sourceFields':1}
      }).sort({service_date:1,source_row:1}).toArray();
      return rows.map(row=>{
        const fields=row.details?.sourceFields || [];
        const [,group,leg]=/^(.*)-([A-Z])$/i.exec(row.reference)||[];
        return {id:String(row._id),reference:row.reference,date:row.service_date,row:row.source_row,
          group:group || row.reference,leg:leg?.toUpperCase(),program:String(fields[0] ?? '').trim(),
          pickup:importedTime(fields[14]),status:row.status,
          from:String(fields[10] ?? '').trim(),to:String(fields[19] ?? '').trim()};
      });
    },
    async trip(id) {
      const row=await collection.findOne({_id:id});
      if (!row) return null;
      const details=row.details || {}, fields=details.sourceFields || [];
      const miles=String(fields[33] ?? '').trim();
      return {reference:row.reference,date:row.service_date,row:row.source_row,status:row.status,
        passenger:details.name,phone:details.phone,pickupAddress:details.pickupAddress,
        dropoffAddress:details.destinationAddress,pickup:importedTime(fields[14]),dropoff:importedTime(fields[23]),
        serviceCode:String(fields[3] ?? ''),miles:/^\d{1,5}(?:\.\d{1,3})?$/.test(miles) ? Number(miles) : null,
        instructions:details.instructions};
    }
  };
}
module.exports={tripRecords};

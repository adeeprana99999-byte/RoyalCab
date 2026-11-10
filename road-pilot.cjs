const { createHash, timingSafeEqual } = require('node:crypto');

const fingerprint = value => createHash('sha256').update(value).digest();
const addressKey = parts => parts.map(part=>String(part || '').trim().replace(/\s+/g,' ').toUpperCase()).join('|');

function configure(input) {
  if (!Array.isArray(input?.drivers) || !input.drivers.length || !Array.isArray(input.verifiedStops) || input.verifiedStops.length < 2) {
    throw Error('Road pilot configuration needs enrolled drivers and at least two verified stops.');
  }
  const codes = new Set();
  const token = code => {
    if (typeof code !== 'string' || code.length < 20 || code.length > 150 || codes.has(code)) {
      throw Error('Use a different access code of at least 20 characters for each pilot account.');
    }
    codes.add(code);
    return fingerprint(code);
  };
  const owner = token(input.ownerCode);
  const driverTokens = new Map(), plates = new Set();
  const drivers = input.drivers.map(d=>{
    if (!/^[a-zA-Z0-9_-]{2,80}$/.test(d.id || '') || driverTokens.has(d.id) ||
        !['name','phone','vehicle','plate'].every(key=>typeof d[key]==='string' && d[key].trim() && d[key].length<=100) ||
        !/^\+[1-9]\d{7,14}$/.test(d.phone) || plates.has(d.plate.toUpperCase()) ||
        !Number.isInteger(d.seats) || d.seats<1 || d.seats>7 || !Array.isArray(d.capabilities) ||
        d.capabilities.some(capability=>capability!=='wheelchair')) throw Error('Invalid or duplicate enrolled driver or vehicle.');
    driverTokens.set(d.id,token(d.code)); plates.add(d.plate.toUpperCase());
    return {id:d.id,name:d.name,phone:d.phone,vehicle:d.vehicle,plate:d.plate,seats:d.seats,capabilities:d.capabilities,
      status:'offline',locationSource:'device',trackingEnabled:false,lat:null,lng:null,lastLocationAt:0};
  });
  const names = new Set(), addresses = new Map();
  const stops = input.verifiedStops.map(stop=>{
    const fields=[stop.address,stop.city,stop.state,stop.zip];
    if (typeof stop.name!=='string' || !stop.name.trim() || stop.name.length>100 || names.has(stop.name) ||
        fields.some(field=>typeof field!=='string'||!field.trim()||field.length>140) ||
        !Number.isFinite(stop.lat) || Math.abs(stop.lat)>90 || !Number.isFinite(stop.lng) || Math.abs(stop.lng)>180) {
      throw Error('Invalid or duplicate verified stop.');
    }
    const key=addressKey(fields);
    if (addresses.has(key)) throw Error('Each verified address must map to a single stop.');
    names.add(stop.name);addresses.set(key,stop.name);
    return { name:stop.name,lat:stop.lat,lng:stop.lng };
  });
  const authenticate = (role,driverId,code) => {
    const target=role==='owner'?owner:role==='driver'?driverTokens.get(driverId):null;
    return !!(target && typeof code==='string' && code.length<=150 && timingSafeEqual(target,fingerprint(code)));
  };
  return { drivers,stops,authenticate,hasDriver:id=>driverTokens.has(id),resolve:fields=>addresses.get(addressKey(fields)) };
}
module.exports = { configure };

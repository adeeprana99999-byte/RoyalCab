(function(root){
 function journey(t,driver,now=Date.now()){
  const assigned=!!t.driverId,late=!['onboard','completed','cancelled'].includes(t.status)&&t.pickupAt<now;
  const stages={accepted:['Driver confirmed','Your driver has accepted. They have not marked themselves on the way yet.',1],heading_to_pickup:['Driver is on the way','Your driver is heading to your pickup.',1],arrived:['Your driver has arrived','Meet your driver at the pickup. Check the car and plate before boarding.',2],onboard:['You’re on your way','Your ride is in progress. Your destination is shown below.',3]};
  const [title,description,step]=stages[t.status]||['Finding your driver',t.pickupAt>now?'Your pickup is booked. We will confirm your driver closer to pickup.':'A driver has not accepted yet. Dispatch is looking for someone available.',0];
  const fresh=assigned&&driver&&Number.isFinite(driver.lat)&&Number.isFinite(driver.lng)&&now>=driver.lastLocationAt&&now-driver.lastLocationAt<=120000&&driver.status!=='offline'&&!(driver.locationSource==='device'&&driver.trackingEnabled===false);
  return {title,description,step,late,location:fresh?'available':'unavailable',source:fresh?(driver.locationSource==='device'?'device':'simulated'):'none',ageSeconds:fresh?Math.floor((now-driver.lastLocationAt)/1000):null};
 }
 const api={journey};if(typeof module==='object'&&module.exports)module.exports=api;else root.ProLiftRider=api;
})(typeof globalThis!=='undefined'?globalThis:this);

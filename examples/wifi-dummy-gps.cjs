'use strict';

const { randomUUID } = require('node:crypto');
const { places } = require('../domain.cjs');
const base = 'http://127.0.0.1:4781';

async function request(path, data) {
  const response = await fetch(base + path, data ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(data)
  } : { cache: 'no-store' });
  if (!response.ok) throw Error(await response.text());
  return response.json();
}

async function sendPoint(stop) {
  const { at } = await request('/owner/api/state');
  const point = { latitude: stop.lat, longitude: stop.lng, accuracy: 8 };
  const post = capturedAt => request('/driver/api/driver/location', {
    points: [{ ...point, id: randomUUID(), capturedAt }]
  });
  let result = await post(at);
  // The replay can advance between reading its clock and uploading a point.
  if (result.rejected[0]?.reason === 'invalid_time') result = await post(result.serverTime);
  if (result.accepted.length !== 1) throw Error(JSON.stringify(result.rejected));
  console.log('Accepted dummy GPS', point.latitude, point.longitude);
}

async function main() {
  const { state } = await request('/owner/api/state');
  const ride = state.trips.find(t => t.lgtc?.test !== false &&
    t.reference === 'LGTC-MCD1-2026-11-13-900-801-A');
  if (!ride) throw Error('Maya’s dummy ride is missing.');
  const action = data => request('/driver/api/trips/' + ride.id + '/action', data);
  const stage = process.argv[2];
  if (stage === 'depart' && ride.status === 'offered') {
    const offer = state.offers.find(o => o.tripId === ride.id && o.driverId === 'd1' && o.status === 'pending');
    if (!offer) throw Error('Maya needs a pending offer.');
    await action({ action: 'accept', offerId: offer.id });
    await request('/driver/api/driver/tracking', { enabled: true });
    await action({ action: 'depart' });
    await sendPoint(places.find(p => p.name === ride.pickup));
  } else if (stage === 'pickup' && ride.status === 'heading_to_pickup' && ride.driverId === 'd1') {
    await action({ action: 'arrive' });
    await action({ action: 'pickup' });
    await sendPoint(places.find(p => p.name === ride.pickup));
  } else if (stage === 'dropoff' && ride.status === 'onboard' && ride.driverId === 'd1') {
    await action({ action: 'complete' });
    await sendPoint(places.find(p => p.name === ride.destination));
  } else {
    throw Error('Run depart, pickup and dropoff in order after resetting the dummy ride.');
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

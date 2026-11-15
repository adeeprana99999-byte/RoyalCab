'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MongoClient } = require('mongodb');

const uri = process.env.ROYALCAB_MONGO_URI;
if (!uri) throw Error('Set ROYALCAB_MONGO_URI in your terminal using a dedicated test credential.');
const database = 'royalcab_dispatch_test';
const rideId = randomUUID();
const drivers = ['maya-demo', 'james-demo'];
const connect = async () => new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }).connect();

async function run() {
  const clients = [];
  try {
    for (const driver of drivers) clients.push(await connect());
    const collection = client => client.db(database).collection('acceptance_tests');
    await collection(clients[0]).insertOne({
      _id: rideId, status: 'offered', driverId: null,
      offers: drivers.map(driverId => ({ driverId, status: 'pending' }))
    });
    const results = await Promise.all(drivers.map((driverId, index) =>
      collection(clients[index]).updateOne(
        { _id: rideId, status: 'offered', driverId: null, offers: { $elemMatch: { driverId, status: 'pending' } } },
        { $set: { status: 'accepted', driverId, 'offers.$[winner].status': 'accepted', 'offers.$[other].status': 'taken' } },
        { arrayFilters: [{ 'winner.driverId': driverId }, { 'other.driverId': { $ne: driverId } }] }
      )
    ));
    assert.equal(results.filter(result => result.modifiedCount === 1).length, 1);
    const winner = drivers[results.findIndex(result => result.modifiedCount === 1)];
    await Promise.all(clients.splice(0).map(client => client.close()));
    const verifier = await connect();
    clients.push(verifier);
    const saved = await collection(verifier).findOne({ _id: rideId });
    assert.equal(saved.status, 'accepted');
    assert.equal(saved.driverId, winner);
    assert.deepEqual(saved.offers.map(offer => offer.status), drivers.map(driver => driver === winner ? 'accepted' : 'taken'));
    console.log(JSON.stringify({ database, rideId, winner, otherOffer: 'taken', verifiedAfterReconnect: true }));
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
  }
}
run().catch(error => {
  // Connection errors can include deployment details. Keep logs concise.
  console.error('MongoDB acceptance test failed:', error.name, error.code ?? '');
  process.exitCode = 1;
});

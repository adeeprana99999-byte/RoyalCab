'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MongoClient } = require('mongodb');
const { xlsx } = require('../excel.cjs');

const database = 'royalcab_dispatch_test';
const serviceDate = '2026-11-03';
const dataDir = path.join(__dirname, '..', 'data');

function loadImport() {
  const rows = xlsx(fs.readFileSync(path.join(dataDir, 'TPA-Vehicle.xlsx')));
  const header = rows.findIndex(row => row.includes('Vehicle Identification Number (VIN)'));
  assert.ok(header >= 0, 'Missing fleet workbook header');
  const vinColumn = rows[header].indexOf('Vehicle Identification Number (VIN)');
  const driverColumn = rows[header].indexOf('Last Known Driver');
  assert.ok(driverColumn >= 0, 'Missing fleet driver column');
  const fleetKeys = (column, normalize) => [...new Set(rows.slice(header + 1)
    .map(row => normalize(String(row[column] ?? '').trim())).filter(Boolean))];

  const db = new DatabaseSync(path.join(dataDir, 'private-fleet.sqlite'), { readOnly: true });
  try {
    const lookup = db.prepare('SELECT payload FROM fleet_import_records WHERE kind=? AND record_key=?');
    const fleet = (kind, keys) => keys.map(key => {
      const record = lookup.get(kind, key);
      assert.ok(record, 'A workbook fleet record is missing from SQLite');
      return { _id: key, ...JSON.parse(record.payload) };
    });
    const vehicles = fleet('vehicle', fleetKeys(vinColumn, value => value.toUpperCase()));
    const drivers = fleet('driver', fleetKeys(driverColumn, value => value.toLowerCase()));
    const sourceRows = db.prepare('SELECT * FROM lgtc_sheet_legs WHERE service_date=? ORDER BY source_row').all(serviceDate);
    assert.equal(new Set(sourceRows.map(row => row.schedule_id)).size, 1, 'Expected one LGTC schedule');
    const rides = sourceRows.map(({details, ...row}) => {
      const source = JSON.parse(details);
      assert.equal(source.sourceFields.length, 38, 'Incomplete LGTC source row');
      return { _id: row.schedule_id + ':' + row.source_row, ...row, details: source };
    });
    assert.deepEqual([vehicles.length, drivers.length, rides.length], [181, 105, 284]);
    return { vehicles, drivers, lgtc_rides: rides };
  } finally {
    db.close();
  }
}

async function main() {
  const records = loadImport();
  const expected = Object.fromEntries(Object.entries(records).map(([name, docs]) => [name, docs.length]));
  const apply = process.argv.includes('--apply');
  if (!apply && !process.argv.includes('--verify')) {
    console.log(JSON.stringify({ database, serviceDate, sourceVerified: expected, uploaded: false }));
    return;
  }
  const uri = process.env.ROYALCAB_MONGO_URI;
  if (!uri) throw Error('MISSING_URI');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    const db = client.db(database);
    const verified = {};
    for (const [name, docs] of Object.entries(records)) {
      const collection = db.collection(name);
      if (apply) await collection.bulkWrite(docs.map(({_id, ...fields}) => ({
        updateOne: { filter: { _id }, update: { $set: fields }, upsert: true }
      })));
      verified[name] = await collection.countDocuments({ _id: { $in: docs.map(doc => doc._id) } });
      assert.equal(verified[name], docs.length, 'MongoDB count differs from the workbook');
    }
    console.log(JSON.stringify({ database, serviceDate, verified }));
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message === 'MISSING_URI'
    ? 'Set ROYALCAB_MONGO_URI in this PowerShell window before importing.'
    : 'Import did not finish (' + (error.code || error.name) + '). Rerunning is safe.');
  process.exitCode = 1;
});

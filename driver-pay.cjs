'use strict';

const easternDate = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',
  year:'numeric',month:'2-digit',day:'2-digit'});

function createDriverPay(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS driver_pay_rates (
    driver_id TEXT PRIMARY KEY, basis TEXT NOT NULL, rate_cents INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS driver_trip_pay (
    trip_id TEXT PRIMARY KEY, driver_id TEXT NOT NULL, reference TEXT NOT NULL,
    service_date TEXT NOT NULL, basis TEXT, rate_cents INTEGER, quantity REAL, amount_cents INTEGER
  );
  CREATE INDEX IF NOT EXISTS driver_trip_pay_day ON driver_trip_pay(driver_id,service_date);`);
  const findRate = db.prepare('SELECT basis, rate_cents AS rateCents FROM driver_pay_rates WHERE driver_id=?');
  const setRate = db.prepare('INSERT INTO driver_pay_rates VALUES(?,?,?) ON CONFLICT(driver_id) DO UPDATE SET basis=excluded.basis,rate_cents=excluded.rate_cents');
  const save = db.prepare('INSERT OR IGNORE INTO driver_trip_pay VALUES(?,?,?,?,?,?,?,?)');
  const list = db.prepare(`SELECT trip_id AS tripId, reference, basis, rate_cents AS rateCents, quantity,
    amount_cents AS amountCents FROM driver_trip_pay WHERE driver_id=? AND service_date=? ORDER BY reference,trip_id`);

  function record(ride) {
    const rate = findRate.get(ride.driverId);
    let quantity = null;
    if (rate?.basis === 'hour' && Number.isFinite(ride.startedAt) && ride.completedAt >= ride.startedAt) {
      quantity = (ride.completedAt-ride.startedAt)/3600000;
    } else if (rate?.basis === 'mile' && Number.isFinite(ride.miles) && ride.miles > 0) {
      quantity = ride.miles;
    }
    const amount = quantity === null ? null : Math.round(quantity * rate.rateCents);
    save.run(ride.id,ride.driverId,ride.reference,easternDate.format(ride.completedAt),
      rate?.basis ?? null,rate?.rateCents ?? null,quantity,amount);
  }

  return {
    rates:drivers=>drivers.filter(driver=>!driver.demoRunId).map(driver=>({
      id:driver.id,name:driver.name,...findRate.get(driver.id)
    })),
    set(driverId,basis,rateCents) {
      if (!['mile','hour'].includes(basis) || !Number.isInteger(rateCents) || rateCents<1 || rateCents>100000) {
        throw Error('Enter a rate between $0.01 and $1,000.00 per mile or hour.');
      }
      setRate.run(driverId,basis,rateCents);
    },
    record,
    day(driverId,date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0,10)!==date) throw Error('Choose a valid pay date.');
      const rides=list.all(driverId,date);
      return {date,rides,totalCents:rides.reduce((total,ride)=>total+(ride.amountCents ?? 0),0)};
    },
    today:now=>easternDate.format(now)
  };
}
module.exports = {createDriverPay};

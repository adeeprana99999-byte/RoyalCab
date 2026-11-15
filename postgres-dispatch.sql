BEGIN;

CREATE TABLE IF NOT EXISTS fleet_drivers (
    id text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS fleet_vehicles (
    id text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT true,
    passenger_seats smallint NOT NULL CHECK (passenger_seats BETWEEN 1 AND 7),
    wheelchair_accessible boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS dispatch_trips (
    id text PRIMARY KEY,
    reference text NOT NULL UNIQUE,
    pickup_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN (
        'awaiting_driver', 'offered', 'accepted', 'heading_to_pickup', 'arrived',
        'onboard', 'completed', 'cancelled', 'needs_reassignment'
    )),
    driver_id text REFERENCES fleet_drivers(id),
    vehicle_id text REFERENCES fleet_vehicles(id),
    CHECK (status NOT IN ('accepted','heading_to_pickup','arrived','onboard')
        OR (driver_id IS NOT NULL AND vehicle_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS dispatch_queue ON dispatch_trips (status, pickup_at);

CREATE TABLE IF NOT EXISTS dispatch_offers (
    id text PRIMARY KEY,
    trip_id text NOT NULL REFERENCES dispatch_trips(id),
    driver_id text NOT NULL REFERENCES fleet_drivers(id),
    vehicle_id text NOT NULL REFERENCES fleet_vehicles(id),
    status text NOT NULL CHECK (status IN (
        'pending','accepted','declined','expired','taken','cancelled',
        'replaced_by_owner','released'
    )),
    offered_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > offered_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_accepted_offer_per_trip
    ON dispatch_offers (trip_id) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS pending_offers_by_trip
    ON dispatch_offers (trip_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS dispatch_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id text NOT NULL REFERENCES dispatch_trips(id),
    actor text NOT NULL,
    event_type text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMIT;

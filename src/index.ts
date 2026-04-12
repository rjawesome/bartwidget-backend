import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import admin from 'firebase-admin';
import unzipper from 'unzipper';
import { parse } from 'csv-parse';
import { createClient } from '@libsql/client';
import { Message } from 'firebase-admin/messaging';
import dotenv from 'dotenv';

dotenv.config();

// --- Firebase Admin Setup ---
// Make sure you have the serviceAccountKey.json file in your backend directory
const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf-8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// --- Turso DB Setup ---
const turso = (process.env.REALTIME_DB && process.env.REALTIME_TOKEN)
    ? createClient({
        url: process.env.REALTIME_DB,
        authToken: process.env.REALTIME_TOKEN,
    }) : null;

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(bodyParser.json());


interface Station {
    id: string;
    name: string;
    lat: string;
    lon: string;
}

interface Route {
    id: string;
    shortName: string;
    longName: string;
    color: string;
}

interface Trip {
    id: string;
    routeId: string;
    headsign: string;
    directionId: string;
}

interface Departure {
    tripId?: string | null;
    routeId?: string | null;
    routeName: string;
    destination: string;
    time: number;
    delay: number;
}

// --- Data Storage ---
let stations: Record<string, Station> = {};
let routes: Record<string, Route> = {};
let trips: Record<string, Trip> = {};
let stationDepartures: Record<string, Record<string, Departure[]>> = {};

// --- GTFS Static Data Handling ---
const gtfsStaticUrl = 'https://www.bart.gov/dev/schedules/google_transit.zip';
const stopsFile = 'stops.txt';
const routesFile = 'routes.txt';
const tripsFile = 'trips.txt';

async function updateStaticData() {
    console.log('Fetching and updating GTFS static data...');
    try {
        const response = await fetch(gtfsStaticUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch GTFS static data: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const directory = await unzipper.Open.buffer(Buffer.from(buffer));
        
        let parsedStations: Record<string, Station> | null = null;
        let parsedRoutes: Record<string, Route> | null = null;
        let parsedTrips: Record<string, Trip> | null = null;

        const stopsFileEntry = directory.files.find(f => f.path === stopsFile);
        if (stopsFileEntry) {
            const content = await stopsFileEntry.buffer();
            const parser = parse(content, {
                columns: true,
                skip_empty_lines: true
            });

            const newStations: Record<string, Station> = {};
            for await (const row of parser) {
                // We only care about stations, not platforms or entrances
                if (row.location_type === '1' || row.location_type === '0') {
                    newStations[row.stop_id] = {
                        id: row.stop_id,
                        name: row.stop_name.split('(')[0].trimEnd(), // mainly for Millbrae
                        lat: row.stop_lat,
                        lon: row.stop_lon
                    };
                }
            }
            parsedStations = newStations;
        } else {
            console.error(`${stopsFile} not found in the zip archive.`);
        }

        const routesFileEntry = directory.files.find(f => f.path === routesFile);
        if (routesFileEntry) {
            const content = await routesFileEntry.buffer();
            const parser = parse(content, { columns: true, skip_empty_lines: true });
            const newRoutes: Record<string, Route> = {};
            for await (const row of parser) {
                newRoutes[row.route_id] = {
                    id: row.route_id,
                    shortName: row.route_short_name,
                    longName: row.route_long_name,
                    color: row.route_color
                };
            }
            parsedRoutes = newRoutes;
        } else {
            console.error(`${routesFile} not found in the zip archive.`);
        }

        const tripsFileEntry = directory.files.find(f => f.path === tripsFile);
        if (tripsFileEntry) {
            const content = await tripsFileEntry.buffer();
            const parser = parse(content, { columns: true, skip_empty_lines: true });
            const newTrips: Record<string, Trip> = {};
            for await (const row of parser) {
                newTrips[row.trip_id] = {
                    id: row.trip_id,
                    routeId: row.route_id,
                    headsign: row.trip_headsign,
                    directionId: row.direction_id
                };
            }
            parsedTrips = newTrips;
        } else {
            console.error(`${tripsFile} not found in the zip archive.`);
        }

        // Atomically replace static data tables
        if (parsedStations && parsedRoutes && parsedTrips) {
            stations = parsedStations;
            routes = parsedRoutes;
            trips = parsedTrips;
            console.log(`Successfully updated static data: ${Object.keys(stations).length} stations, ${Object.keys(routes).length} routes, ${Object.keys(trips).length} trips.`);
            
            if (turso) {
                try {
                    // Deduplicate station names
                    const stationNames = Array.from(new Set(Object.values(stations).map(s => s.name)));
                    await turso.execute({
                        sql: `INSERT INTO stations (system, data) VALUES (?, ?) ON CONFLICT (system) DO UPDATE SET data = excluded.data`,
                        args: ['BART', JSON.stringify(stationNames)]
                    });
                    await turso.execute({
                        sql: `INSERT INTO stations (system, data) VALUES (?, ?) ON CONFLICT (system) DO UPDATE SET data = excluded.data`,
                        args: ['BART2', JSON.stringify(stations)]
                    });
                    console.log('Successfully wrote station list to Turso DB.');
                } catch (dbError) {
                    console.error('Error writing stations to Turso DB:', dbError);
                }
            }
        }
    } catch (error) {
        console.error('Error updating static data:', error);
    }
}

// --- GTFS Realtime Data Handling ---
const tripUpdateUrl = 'http://api.bart.gov/gtfsrt/tripupdate.aspx';
const alertsUrl = 'http://api.bart.gov/gtfsrt/alerts.aspx';

async function fetchRealtimeData() {
    console.log("fetching realtime data")
    try {
        const response = await fetch(tripUpdateUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch trip updates: ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

        const newDepartures: Record<string, Record<string, Departure[]>> = {};

        feed.entity.forEach(entity => {
            if (entity.tripUpdate) {
                const tripId = entity.tripUpdate.trip?.tripId;
                const scheduleRelationship = entity.tripUpdate.trip?.scheduleRelationship;
                let routeId = entity.tripUpdate.trip?.routeId;
                
                let destination = '';
                let routeName = '';

                // Use static data for scheduled trips to find route and destination
                if (tripId && trips[tripId] && (scheduleRelationship === 0)) {
                    routeId = trips[tripId].routeId || routeId;
                    destination = trips[tripId].headsign || destination;
                }

                if (routeId && routes[routeId]) {
                    routeName = routes[routeId].shortName || routes[routeId].longName || routeName;
                }

                entity.tripUpdate.stopTimeUpdate?.forEach(stopUpdate => {
                    const stopId = stopUpdate.stopId;
                    if (stopId && stations[stopId]) { // Ensure it's a station we're tracking
                        const departureTime = stopUpdate.departure?.time;
                        const departureDelay = stopUpdate.departure?.delay;
                        if (departureTime && (typeof departureTime === 'number' ? departureTime : departureTime.toNumber())*1000 >= Date.now()) {
                            const stationName = stations[stopId].name;
                            let currentRouteId = routeId;
                            let currentRouteName = routeName;
                            let currentDestination = destination;

                            if (!currentRouteId || currentRouteId === '') {
                                if (stationName === 'Pittsburg Center') {
                                    if (stopId.endsWith('-1')) {
                                        currentRouteName = 'Yellow-N';
                                        currentDestination = 'Antioch';
                                    } else {
                                        currentRouteName = 'Yellow-S';
                                        currentDestination = 'SFO';
                                    }
                                } else if (stationName === 'Antioch') {
                                    currentRouteName = 'Yellow-S';
                                    currentDestination = 'SFO';
                                } else {
                                    return; // Skip this stop for fake trips we can't identify
                                }
                            }

                            currentDestination = currentDestination.replace('San Francisco International Airport', 'SFO')

                            if (currentDestination && currentDestination.includes(' / ')) {
                                const parts = currentDestination.split(' / ');
                                currentDestination = parts[parts.length - 1].trim();
                                currentDestination = currentDestination.split('/')[0];
                            }

                            currentDestination = currentDestination.split('(')[0].trimEnd()

                            if (!newDepartures[stationName]) {
                                newDepartures[stationName] = {};
                            }
                            if (!newDepartures[stationName][currentRouteName]) {
                                newDepartures[stationName][currentRouteName] = [];
                            }
                            
                            // Simple structure for departure info
                            newDepartures[stationName][currentRouteName].push({
                                tripId: tripId,
                                routeId: currentRouteId,
                                routeName: currentRouteName,
                                destination: currentDestination,
                                time: Number(departureTime),
                                delay: departureDelay != null ? Number(departureDelay) : 0
                            });
                        }
                    }
                });
            }
        });

        // Sort departures and keep only the next two for each line/direction
        for (const stationName in newDepartures) {
            for (const directionKey in newDepartures[stationName]) {
                const departures = newDepartures[stationName][directionKey];
                departures.sort((a: Departure, b: Departure) => a.time - b.time);
                newDepartures[stationName][directionKey] = departures.slice(0, 2);
            }
        }

        checkForChangesAndNotify(newDepartures);
        stationDepartures = newDepartures;

        // Write realtime departures to Turso DB
        if (turso) {
            try {
                const timestamp = new Date().toISOString();
                const queries = Object.entries(newDepartures).map(([stationName, lines]) => {
                    // Replicate the exact data format sent in the push notification
                    const pushData = {
                        timestamp,
                        station: stationName,
                        departures: JSON.stringify(lines)
                    };
                    return {
                        sql: `INSERT INTO realtime_data (station, data) VALUES (?, ?) ON CONFLICT (station) DO UPDATE SET data = excluded.data`,
                        args: [stationName, JSON.stringify(pushData)]
                    };
                });
                if (queries.length > 0) {
                    await turso.batch(queries, "write");
                }
            } catch (dbError) {
                console.error('Error writing realtime data to Turso DB:', dbError);
            }
        }
    } catch (error) {
        console.error('Error fetching realtime data:', error);
    }
    console.log("done fetching realtime data")
}

function checkForChangesAndNotify(newDepartures: Record<string, Record<string, Departure[]>>) {
    const timestamp = new Date().toISOString();
    const messagePromises: Promise<string>[] = [];

    for (const stationName in newDepartures) {
        const oldStationLines = stationDepartures[stationName] || {};
        const newStationLines = newDepartures[stationName];

        const allLineKeys = new Set([...Object.keys(oldStationLines), ...Object.keys(newStationLines)]);

        for (const lineKey of allLineKeys) {
            const oldDepartures = oldStationLines[lineKey] || [];
            const newDepartures = newStationLines[lineKey] || [];

            let hasSignificantChange = false;
            if (oldDepartures.length !== newDepartures.length) {
                hasSignificantChange = true;
            } else {
                for (const newDeparture of newDepartures) {
                    const oldDeparture = oldDepartures.find((d: Departure) => d.tripId === newDeparture.tripId);
                    if (!oldDeparture || Math.abs(oldDeparture.time - newDeparture.time) > 30) {
                        hasSignificantChange = true;
                        break;
                    }
                }
            }

            if (hasSignificantChange) {
                const topic = `BART_${stationName.replace(/[^a-zA-Z0-9-_.~%]/g, '_')}`;
                const message: Message = {
                    data: {
                        timestamp,
                        station: stationName,
                        departures: JSON.stringify(newStationLines)
                    },
                    android: {
                        ttl: 20 * 60 * 1000 // 20 minutes in milliseconds
                    },
                    apns: {
                        headers: {
                            'apns-expiration': Math.floor(Date.now() / 1000 + 20 * 60).toString()
                        }
                    },
                    topic: topic,
                };

                messagePromises.push(admin.messaging().send(message));
                break; 
            }
        }
    }

    if (messagePromises.length > 0) {
        Promise.all(messagePromises)
            .then(() => console.log(`Successfully sent ${messagePromises.length} notifications.`))
            .catch(error => console.error('Error sending notifications:', error));
    }
}


app.post('/poll', (req, res) => {
    const { stationName } = req.body;

    if ( !stationName) {
        return res.status(400).send('fcmId and stationName are required');
    }

    // Verify stationName exists
    const stationExists = Object.values(stations).some(s => s.name === stationName);
    if (!stationExists) {
        return res.status(400).send(`Invalid stationName: ${stationName}`);
    }


    const departures = stationDepartures[stationName] || [];
    res.status(200).json({
        departures: departures
    });
});

app.listen(port, '0.0.0.0', async () => {
    console.log(`Server is running on http://0.0.0.0:${port}`);
    await updateStaticData(); // Initial fetch of station data
    setInterval(updateStaticData, 24 * 60 * 60 * 1000); // Fetch static data every 24 hours
    await fetchRealtimeData();
    setInterval(fetchRealtimeData, 30000); // Fetch realtime data every 30 seconds
});

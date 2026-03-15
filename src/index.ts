import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import admin from 'firebase-admin';
import unzipper from 'unzipper';
import { parse } from 'csv-parse';

// --- Firebase Admin Setup ---
// Make sure you have the serviceAccountKey.json file in your backend directory
const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf-8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
const port = 3000;

app.use(bodyParser.json());

const dataFile = './data.json';
let fcmData: Record<string, string> = {};

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

// Load fcm data from file on startup
if (fs.existsSync(dataFile)) {
    const rawData = fs.readFileSync(dataFile, 'utf-8');
    fcmData = JSON.parse(rawData);
}

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
                        name: row.stop_name,
                        lat: row.stop_lat,
                        lon: row.stop_lon
                    };
                }
            }
            stations = newStations;
            console.log(`Successfully updated ${Object.keys(stations).length} stations.`);
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
            routes = newRoutes;
            console.log(`Successfully updated ${Object.keys(routes).length} routes.`);
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
            trips = newTrips;
            console.log(`Successfully updated ${Object.keys(trips).length} trips.`);
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

                            if (currentDestination && currentDestination.includes('/')) {
                                const parts = currentDestination.split('/');
                                currentDestination = parts[parts.length - 1].trim();
                            }


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

    } catch (error) {
        console.error('Error fetching realtime data:', error);
    }
    console.log("done fetching realtime data")
}

function checkForChangesAndNotify(newDepartures: Record<string, Record<string, Departure[]>>) {
    const timestamp = new Date().toISOString();

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
                const tokens = Object.keys(fcmData).filter(token => fcmData[token] === stationName);

                if (tokens.length > 0) {
                    console.log("sending message to ", tokens);
                    const message = {
                        // notification: {
                        //     title: `BART Update for ${stationName}`,
                        //     body: `Departure times for line ${lineKey} have changed.`
                        // },
                        data: {
                            timestamp,
                            station: stationName,
                            departures: JSON.stringify(newStationLines)
                        },
                        tokens: tokens,
                    };

                    admin.messaging().sendEachForMulticast(message)
                        .then((response) => {
                            console.log(response.successCount + ' messages were sent successfully');
                            console.log(JSON.stringify(response))
                        })
                        .catch((error) => {
                            console.log('Error sending message:', error);
                        });
                }
                break; 
            }
        }
    }
}


app.post('/register', (req, res) => {
    console.log('recieved register request')
    const { fcmId, stationName } = req.body;

    if (!fcmId || !stationName) {
        return res.status(400).send('fcmId and stationName are required');
    }

    // Verify stationName exists
    const stationExists = Object.values(stations).some(s => s.name === stationName);
    if (!stationExists) {
        return res.status(400).send(`Invalid stationName: ${stationName}`);
    }

    fcmData[fcmId] = stationName;

    // Save data to file
    fs.writeFileSync(dataFile, JSON.stringify(fcmData, null, 2));

    const departures = stationDepartures[stationName] || [];
    res.status(200).json({
        message: 'Station name registered successfully',
        departures: departures
    });
});


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

app.get('/stations', (req, res) => {
    res.status(200).json({
        stations: Object.keys(stationDepartures)
    });
});


app.listen(port, '0.0.0.0', async () => {
    console.log(`Server is running on http://0.0.0.0:${port}`);
    await updateStaticData(); // Initial fetch of station data
    await fetchRealtimeData();
    setInterval(fetchRealtimeData, 30000); // Fetch realtime data every 30 seconds
});

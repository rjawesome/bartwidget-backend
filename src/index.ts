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

// --- Data Storage ---
let stations: Record<string, any> = {};
let stationDepartures: Record<string, any> = {};

// Load fcm data from file on startup
if (fs.existsSync(dataFile)) {
    const rawData = fs.readFileSync(dataFile, 'utf-8');
    fcmData = JSON.parse(rawData);
}

// --- GTFS Static Data Handling ---
const gtfsStaticUrl = 'https://www.bart.gov/dev/schedules/google_transit.zip';
const stopsFile = 'stops.txt';

async function updateStations() {
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

            const newStations: Record<string, any> = {};
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
    } catch (error) {
        console.error('Error updating stations:', error);
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

        const newDepartures: Record<string, any> = {};

        feed.entity.forEach(entity => {
            if (entity.tripUpdate) {
                entity.tripUpdate.stopTimeUpdate?.forEach(stopUpdate => {
                    const stopId = stopUpdate.stopId;
                    if (stopId && stations[stopId]) { // Ensure it's a station we're tracking
                        const departureTime = stopUpdate.departure?.time;
                        if (departureTime) {
                            const stationName = stations[stopId].name;
                            const directionKey = `${entity.tripUpdate?.trip.routeId}-${(entity.tripUpdate?.trip.tripId || '').includes('N') ? 'N' : 'S'}`;

                            if (!newDepartures[stationName]) {
                                newDepartures[stationName] = {};
                            }
                            if (!newDepartures[stationName][directionKey]) {
                                newDepartures[stationName][directionKey] = [];
                            }
                            
                            const routeId = entity.tripUpdate?.trip.routeId;
                            const tripId = entity.tripUpdate?.trip.tripId;

                            // Simple structure for departure info
                            newDepartures[stationName][directionKey].push({
                                tripId: tripId,
                                time: Number(departureTime)
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
                departures.sort((a: any, b: any) => a.time - b.time);
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

function checkForChangesAndNotify(newDepartures: Record<string, any>) {
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
                    const oldDeparture = oldDepartures.find((d: any) => d.tripId === newDeparture.tripId);
                    if (!oldDeparture || Math.abs(oldDeparture.time - newDeparture.time) > 30) {
                        hasSignificantChange = true;
                        break;
                    }
                }
            }

            if (hasSignificantChange) {
                console.log(`Significant change detected for ${stationName} on line ${lineKey}. Notifying users.`);
                const tokens = Object.keys(fcmData).filter(token => fcmData[token] === stationName);

                if (tokens.length > 0) {
                    const message = {
                        notification: {
                            title: `BART Update for ${stationName}`,
                            body: `Departure times for line ${lineKey} have changed.`
                        },
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


app.listen(port, async () => {
    console.log(`Server is running on http://localhost:${port}`);
    await updateStations(); // Initial fetch of station data
    await fetchRealtimeData();
    setInterval(fetchRealtimeData, 30000); // Fetch realtime data every 30 seconds
});


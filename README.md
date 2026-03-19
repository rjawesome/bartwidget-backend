# Transit Backend

This is the backend service for the transit application. It fetches GTFS and Realtime data, pushes realtime updates to a Turso database, and sends out Firebase Cloud Messaging (FCM) push notifications.

## Prerequisites

- Node.js (v20 or higher recommended)
- A [Turso](https://turso.tech/) database
- A Firebase Project with Cloud Messaging enabled

## Database Setup (Turso)

This project uses [Turso](https://turso.tech/) (built on LibSQL) to store static station lists and realtime departure data.
1. Sign up and install the Turso CLI following their [Quickstart Guide](https://docs.turso.tech/quickstart).
2. Create a new database: `turso db create transit-db`
3. Get the database URL: `turso db show transit-db`
4. Create an authentication token: `turso db tokens create transit-db`

## Environment Variables

Create a `.env` file in the root of the `backend` directory (next to `package.json`) and add the following variables:

```env
# Your Turso Database URL (e.g., libsql://transit-db-username.turso.io)
REALTIME_DB="libsql://your-database-url.turso.io"

# Your Turso Authentication Token
REALTIME_TOKEN="your-turso-auth-token"

# The port the server should listen on (Defaults to 3000 if not set)
PORT=9999
```

## Firebase Service Account Key

To send push notifications, the backend needs admin access to your Firebase project.
1. Go to your Firebase Console.
2. Navigate to **Project settings** > **Service accounts**.
3. Click **Generate new private key** and download the JSON file.
4. Rename the downloaded file to `serviceAccountKey.json`.
5. Place `serviceAccountKey.json` directly in the root of the `backend` directory (at `c:\Users\Rohan\Documents\GitHub\transit\backend\serviceAccountKey.json`). *Do not commit this file to version control.*
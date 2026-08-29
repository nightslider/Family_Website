# Family_Website
This is the basic family website that I am building

## Features

- Private login gate for the family website.
- Photo uploads that appear in a shared gallery.
- Comments and emoji reactions on photos.
- Family events and milestone tracking.

## Run locally

```bash
npm start
```

Open <http://localhost:3000>. The first successful login creates the first family account. After signing in, use **Add family login** to create logins for other family members.

Uploaded photos and family content are stored locally in `data/family-data.json`, which is ignored by git.

## Google Photos import

Administrators can import photos selected from Google Photos. Create a Google Cloud OAuth client for a web application, enable the Google Photos Picker API, and add `http://localhost:3000/api/google-photos/callback` as an authorized redirect URI. Set these environment variables before starting the site:

```powershell
$env:GOOGLE_CLIENT_ID = "your-client-id"
$env:GOOGLE_CLIENT_SECRET = "your-client-secret"
npm.cmd start
```

For a deployed site, set `GOOGLE_REDIRECT_URI` to its registered callback URL.

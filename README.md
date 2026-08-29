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

To use the site on a phone or tablet, connect it to the same local network as this computer and open the local-network URL printed when the server starts. Admins can choose a photo from that device or take a new photo with its camera.

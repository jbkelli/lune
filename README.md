# Lune – MVP

**Needs Node 22.13 or newer** (uses Node’s built-in SQLite, so nothing to compile).

**Run locally:** `npm install` → copy `.env.example` to `.env` → `npm start` → open http://localhost:3000
With `MPESA_ENV=demo` payments auto-confirm after 6 seconds so you can test the whole flow (order email prints in the console unless SMTP is set).

**Order emails:** fill `OWNER_EMAIL` + `SMTP_*` in `.env`. An email goes out when payment is confirmed. For Gmail/Workspace use an App Password.

**Real M-Pesa:** register at developer.safaricom.co.ke, create an app with Lipa Na M-Pesa Online, put the key, secret, shortcode and passkey in `.env`, set `MPESA_ENV=sandbox` (then `live` after Go Live). `BASE_URL` must be a public HTTPS address (Safaricom posts payment results to `/api/mpesa/callback`), so deploy first (Render, Railway or a VPS). For a Till number, change `CustomerPayBillOnline` to `CustomerBuyGoodsOnline` in `server.js`.

**Products and delivery fees:** edit the seed list and `ZONES` at the top of `server.js`. Delete `phel.db` to re-seed. Add an `image` URL to a product row to show a photo.

**Stock:** open `/admin.html`, log in with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`, see orders, and set stock or price per product (or add new ones). Items are held while a customer pays and released if payment fails or isn’t completed within 10 minutes.

**Testing email with a personal Gmail:** turn on 2-Step Verification, create an App Password, then set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=` and `OWNER_EMAIL=` to your Gmail and `SMTP_PASS=` to the 16-character App Password. Restart, place a demo order, and check inbox/spam.

**Outfits and drops:** create them in `/admin.html` under “Outfits and drops”. Pick the pieces, name the drop (e.g. Drop 02), optionally add an inspo photo link, and publish. Customers can add the whole look to their cart in one tap. An outfit costs the sum of its pieces.

**Starter catalog:** a brand-new database starts with the pieces and prices you gave plus three sample outfits for Drop 01. Prices for hoodies, shirts and sandals, and all stock counts, are placeholders. Fix them in `/admin.html`. Existing databases keep their data, and the old beauty demo products are removed once.

**After updating files, always stop the server (Ctrl+C) and start it again with `npm start`.** The catalog and database upgrades only happen at startup. The terminal prints a line like `Catalog: 13 pieces, 3 outfits` so you can confirm the new catalog loaded.

**Testing the cart:** the starter stock is 10 of each piece (placeholders). Every test order permanently uses stock. In demo mode `/admin.html` shows a “Testing tools” card with a **Reset stock** button. Real stock counts (often 1 for a thrifted piece) are set per piece in the admin page.

**Sign-ins:** if you change `JWT_SECRET`, everyone is signed out. The site now notices this on load and shows “Sign in” again.

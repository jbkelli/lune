require("dotenv").config();
const express = require("express"),
  { DatabaseSync } = require("node:sqlite"),
  bcrypt = require("bcryptjs"),
  jwt = require("jsonwebtoken"),
  nodemailer = require("nodemailer");
const {
  PORT = 3000,
  JWT_SECRET = "change-me",
  OWNER_EMAIL,
  SMTP_HOST,
  SMTP_PORT = 465,
  SMTP_USER,
  SMTP_PASS,
  MPESA_ENV = "demo",
  MPESA_KEY,
  MPESA_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  BASE_URL,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
} = process.env;

// Delivery areas and fees (KES). Edit freely.
const ZONES = {
  "Nairobi CBD": 150,
  Westlands: 200,
  Kilimani: 200,
  "Lang’ata": 250,
  Eastlands: 250,
  "Thika Road": 300,
  "Outside Nairobi (courier)": 500,
};

const db = new DatabaseSync("phel.db");
db.exec(`create table if not exists users(id integer primary key, name, phone, email unique, pass);
create table if not exists products(id integer primary key, name, category, price integer, image);
create table if not exists addresses(id integer primary key, user_id integer, label text, zone text, address text);
create table if not exists outfits(id integer primary key, title text, drop_name text, blurb text, image text, items text);
create table if not exists orders(id integer primary key, user_id integer, items text, total integer, zone text,
  address text, phone text, status text default 'pending', checkout_id text, receipt text, created text default current_timestamp);`);
try {
  db.exec("alter table products add column stock integer default 15");
} catch {}
// One-time cleanup of the original beauty demo products
if (db.prepare("pragma user_version").get().user_version < 1) {
  db.prepare(
    "delete from products where name in ('Hydrating Face Serum','Gentle Foaming Cleanser','Shea Body Butter','Liquid Foundation','Argan Hair Oil','Edge Control Gel','Vitamin C Day Cream') or name like 'Matte Lipstick%'",
  ).run();
  db.exec("pragma user_version = 1");
}
// Starter catalog and first drop (only on an empty shop; edit everything in /admin.html)
if (!db.prepare("select count(*) c from products").get().c) {
  const ins = db.prepare(
    "insert into products(name,category,price,stock) values(?,?,?,?)",
  );
  [
    ["Leather Jacket – Black", "Jackets", 2500, 10],
    ["Leather Jacket – Brown", "Jackets", 2500, 10],
    ["Oversized Hoodie", "Hoodies", 1200, 10],
    ["Customised Shirt", "Shirts", 800, 10],
    ["Thrifted Shirt", "Shirts", 400, 10],
    ["Baseball Jersey", "Jerseys", 1000, 10],
    ["Slip Dress", "Dresses", 600, 10],
    ["Handbag", "Bags", 1800, 10],
    ["Samba Sneakers", "Shoes", 350, 10],
    ["Sandals", "Shoes", 400, 10],
    ["Leather Belt", "Accessories", 500, 10],
    ["Sunglasses", "Accessories", 450, 10],
    ["Chunky Bangles", "Accessories", 350, 10],
  ].forEach((p) => ins.run(...p));
  const pid = (n) =>
    db.prepare("select id from products where name=?").get(n)?.id;
  const o = db.prepare(
    "insert into outfits(title,drop_name,blurb,items) values(?,?,?,?)",
  );
  [
    [
      "Sunday Street",
      "Drop 01",
      "Black leather over a jersey, finished with sambas and shades.",
      [
        "Leather Jacket – Black",
        "Baseball Jersey",
        "Samba Sneakers",
        "Sunglasses",
      ],
    ],
    [
      "Brunch Date",
      "Drop 01",
      "A soft slip dress with a bag and bangles that do the talking.",
      ["Slip Dress", "Handbag", "Sandals", "Chunky Bangles"],
    ],
    [
      "Off Duty",
      "Drop 01",
      "Cosy hoodie, clean sneakers, a belt to pull it together.",
      ["Oversized Hoodie", "Samba Sneakers", "Sunglasses", "Leather Belt"],
    ],
  ].forEach(([t, d, b, names]) =>
    o.run(t, d, b, JSON.stringify(names.map(pid).filter(Boolean))),
  );
}

const mail =
  SMTP_HOST &&
  nodemailer.createTransport({
    host: SMTP_HOST,
    port: +SMTP_PORT,
    secure: +SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
function notify(o) {
  const u = db
    .prepare("select name,email from users where id=?")
    .get(o.user_id);
  const lines = JSON.parse(o.items)
    .map((i) => `  ${i.qty} x ${i.name} @ KES ${i.price}`)
    .join("\n");
  const text = `New PAID order #${o.id}\n\nCustomer: ${u.name} (${u.email})\nM-Pesa/phone: ${o.phone}\nReceipt: ${o.receipt}\n\n${lines}\n\nTotal (incl. delivery): KES ${o.total}\nDeliver to: ${o.address}, ${o.zone}`;
  console.log(text);
  if (mail)
    mail
      .sendMail({
        from: SMTP_USER,
        to: OWNER_EMAIL,
        subject: `New order #${o.id} – KES ${o.total}`,
        text,
      })
      .catch((e) => console.error("Email failed", e.message));
}
function restock(o, sign) {
  for (const l of JSON.parse(o.items))
    db.prepare("update products set stock=max(0, stock+?) where id=?").run(
      sign * l.qty,
      l.id,
    );
}
function fail(col, val) {
  // cancel an unpaid order and put its items back on the shelf
  const o = db
    .prepare(`select * from orders where ${col}=? and status='pending'`)
    .get(val);
  if (o) {
    db.prepare("update orders set status='failed' where id=?").run(o.id);
    restock(o, 1);
  }
}
function markPaid(checkoutId, receipt, amount) {
  const o = db
    .prepare("select * from orders where checkout_id=?")
    .get(checkoutId);
  if (!o || o.status === "paid" || (amount !== undefined && amount < o.total))
    return;
  db.prepare("update orders set status='paid', receipt=? where id=?").run(
    receipt ?? "",
    o.id,
  );
  if (o.status === "failed") restock(o, -1); // paid after the hold expired: take the stock again
  try {
    notify({ ...o, receipt });
  } catch (e) {
    console.error("Notify failed", e.message);
  }
}
const phone254 = (p) => {
  p = String(p || "").replace(/\D/g, "");
  p = p.replace(/^0/, "254");
  return /^254[17]\d{8}$/.test(p) ? p : null;
};

async function stk(id, amount, phone) {
  if (MPESA_ENV === "demo") {
    setTimeout(() => markPaid("demo-" + id, "DEMO" + id), 6000);
    return "demo-" + id;
  }
  const host =
    MPESA_ENV === "live"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";
  const t = await (
    await fetch(host + "/oauth/v1/generate?grant_type=client_credentials", {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(MPESA_KEY + ":" + MPESA_SECRET).toString("base64"),
      },
    })
  ).json();
  const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const r = await (
    await fetch(host + "/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + t.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: MPESA_SHORTCODE,
        Password: Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + ts).toString(
          "base64",
        ),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: BASE_URL + "/api/mpesa/callback",
        AccountReference: "LUNE" + id,
        TransactionDesc: "Lune order",
      }),
    })
  ).json();
  if (!r.CheckoutRequestID) throw new Error(JSON.stringify(r));
  return r.CheckoutRequestID;
}

const app = express();
app.use(express.json(), express.static("public"));
const auth = (req, res, next) => {
  let id;
  try {
    id = jwt.verify((req.headers.authorization || "").slice(7), JWT_SECRET).id;
    if (!id) throw 0;
  } catch {
    return res.status(401).json({ error: "Please sign in again" });
  }
  const u = db.prepare("select id, name from users where id=?").get(id); // the account must still exist
  if (!u) return res.status(401).json({ error: "Please sign in again" });
  req.user = u;
  next();
};
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const session = (u) => ({
  token: jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: "30d" }),
  name: u.name,
});

app.get("/api/me", auth, (req, res) => res.json({ name: req.user.name }));
app.get("/api/shop", (_, res) =>
  res.json({
    products: db.prepare("select * from products").all(),
    zones: ZONES,
    outfits: db
      .prepare("select * from outfits order by id desc")
      .all()
      .map((o) => ({ ...o, items: JSON.parse(o.items) })),
  }),
);

app.post("/api/signup", (req, res) => {
  const { name, phone, email, password } = req.body;
  if (!name || !email || !password || password.length < 6)
    return res
      .status(400)
      .json({
        error: "Enter your name, email and a password of at least 6 characters",
      });
  try {
    const id = db
      .prepare("insert into users(name,phone,email,pass) values(?,?,?,?)")
      .run(
        name,
        phone,
        email.toLowerCase(),
        bcrypt.hashSync(password, 10),
      ).lastInsertRowid;
    res.json(session({ id, name }));
  } catch {
    res
      .status(400)
      .json({ error: "That email already has an account. Try signing in." });
  }
});
app.post("/api/login", (req, res) => {
  const u = db
    .prepare("select * from users where email=?")
    .get(String(req.body.email || "").toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || "", u.pass))
    return res.status(400).json({ error: "Wrong email or password" });
  res.json(session(u));
});

app.post(
  "/api/orders",
  auth,
  wrap(async (req, res) => {
    const { items, addressId, phone } = req.body,
      p = phone254(phone);
    const a = db
        .prepare("select * from addresses where id=? and user_id=?")
        .get(+addressId || 0, req.user.id),
      fee = a && ZONES[a.zone];
    if (fee === undefined || !p)
      return res
        .status(400)
        .json({
          error: "Choose a delivery location and enter a valid M-Pesa number",
        });
    let sub = 0;
    const lines = [];
    for (const i of items || []) {
      const pr = db
          .prepare("select * from products where id=?")
          .get(+i.id || 0),
        q = Math.max(1, Math.min(20, +i.qty || 1));
      if (!pr) continue;
      if (q > pr.stock)
        return res
          .status(400)
          .json({
            error:
              pr.stock < 1
                ? `${pr.name} just sold out`
                : `Only ${pr.stock} of ${pr.name} left`,
          });
      sub += pr.price * q;
      lines.push({ id: pr.id, name: pr.name, qty: q, price: pr.price });
    }
    if (!lines.length)
      return res.status(400).json({ error: "Your cart is empty" });
    const total = sub + fee;
    const id = db
      .prepare(
        "insert into orders(user_id,items,total,zone,address,phone) values(?,?,?,?,?,?)",
      )
      .run(
        req.user.id,
        JSON.stringify(lines),
        total,
        a.zone,
        a.address,
        p,
      ).lastInsertRowid;
    restock({ items: JSON.stringify(lines) }, -1); // hold the stock while the customer pays
    try {
      db.prepare("update orders set checkout_id=? where id=?").run(
        await stk(id, total, p),
        id,
      );
      res.json({ id, total });
    } catch (e) {
      console.error("STK failed", e.message);
      fail("id", id);
      res
        .status(502)
        .json({
          error:
            "We couldn’t send the M-Pesa prompt. Check the number and try again.",
        });
    }
  }),
);
app.get("/api/orders/:id", auth, (req, res) => {
  const o = db
    .prepare("select status,receipt from orders where id=? and user_id=?")
    .get(req.params.id, req.user.id);
  o ? res.json(o) : res.status(404).json({ error: "Order not found" });
});

app.get("/api/addresses", auth, (req, res) =>
  res.json(
    db.prepare("select * from addresses where user_id=?").all(req.user.id),
  ),
);
app.post("/api/addresses", auth, (req, res) => {
  const { label, zone, address } = req.body;
  if (!label || !address || ZONES[zone] === undefined)
    return res
      .status(400)
      .json({ error: "Add a name, an area and an address" });
  res.json({
    id: db
      .prepare(
        "insert into addresses(user_id,label,zone,address) values(?,?,?,?)",
      )
      .run(req.user.id, label, zone, address).lastInsertRowid,
  });
});
app.delete("/api/addresses/:id", auth, (req, res) => {
  db.prepare("delete from addresses where id=? and user_id=?").run(
    +req.params.id,
    req.user.id,
  );
  res.json({ ok: true });
});

// Owner dashboard (/admin.html). One admin only: the login comes from .env, there is no signup.
const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")),
    y = Buffer.from(String(b ?? ""));
  return x.length === y.length && require("crypto").timingSafeEqual(x, y);
};
const tries = {};
app.post("/api/admin/login", (req, res) => {
  const t = (tries[req.ip] = (tries[req.ip] || []).filter(
    (x) => Date.now() - x < 900000,
  ));
  if (t.length >= 5)
    return res
      .status(429)
      .json({ error: "Too many attempts. Try again in 15 minutes." });
  const b = req.body || {};
  if (
    !ADMIN_EMAIL ||
    !ADMIN_PASSWORD ||
    !same(
      String(b.email || "")
        .trim()
        .toLowerCase(),
      ADMIN_EMAIL.trim().toLowerCase(),
    ) ||
    !same(b.password, ADMIN_PASSWORD)
  ) {
    t.push(Date.now());
    return res.status(401).json({ error: "Wrong email or password" });
  }
  res.json({
    token: jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: "12h" }),
  });
});
const admin = (req, res, next) => {
  let ok = false;
  try {
    ok =
      jwt.verify((req.headers.authorization || "").slice(7), JWT_SECRET)
        .admin === true;
  } catch {}
  ok ? next() : res.status(401).json({ error: "Please log in as admin" });
};
app.get("/api/admin/orders", admin, (_, res) =>
  res.json(
    db
      .prepare(
        "select o.id, o.created, o.items, o.total, o.zone, o.address, o.phone, o.status, o.receipt, u.name from orders o left join users u on u.id=o.user_id where o.status!='failed' order by o.id desc limit 100",
      )
      .all(),
  ),
);
app.get("/api/admin/products", admin, (_, res) =>
  res.json(db.prepare("select * from products").all()),
);
app.put("/api/admin/products/:id", admin, (req, res) => {
  db.prepare("update products set price=?, stock=? where id=?").run(
    Math.max(0, +req.body.price || 0),
    Math.max(0, +req.body.stock || 0),
    +req.params.id,
  );
  res.json({ ok: true });
});
app.post("/api/admin/products", admin, (req, res) => {
  const b = req.body;
  if (!b.name || !(+b.price > 0))
    return res.status(400).json({ error: "Name and price are required" });
  db.prepare(
    "insert into products(name,category,price,stock,image) values(?,?,?,?,?)",
  ).run(
    b.name,
    b.category || "Other",
    +b.price,
    Math.max(0, +b.stock || 0),
    b.image || null,
  );
  res.json({ ok: true });
});

app.get("/api/admin/outfits", admin, (_, res) =>
  res.json(
    db
      .prepare("select * from outfits order by id desc")
      .all()
      .map((o) => ({ ...o, items: JSON.parse(o.items) })),
  ),
);
app.post("/api/admin/outfits", admin, (req, res) => {
  const b = req.body || {},
    ids = (b.items || []).map(Number).filter(Boolean);
  if (!b.title || ids.length < 2)
    return res
      .status(400)
      .json({ error: "Add an outfit name and pick at least two pieces" });
  db.prepare(
    "insert into outfits(title,drop_name,blurb,image,items) values(?,?,?,?,?)",
  ).run(
    b.title,
    b.drop_name || "",
    b.blurb || "",
    b.image || null,
    JSON.stringify(ids),
  );
  res.json({ ok: true });
});
app.delete("/api/admin/outfits/:id", admin, (req, res) => {
  db.prepare("delete from outfits where id=?").run(+req.params.id);
  res.json({ ok: true });
});

app.get("/api/admin/config", admin, (_, res) =>
  res.json({ demo: MPESA_ENV === "demo" }),
);
// Testing helper, demo mode only: put every piece back to the same stock level
app.post("/api/admin/reset-stock", admin, (req, res) => {
  if (MPESA_ENV !== "demo")
    return res.status(403).json({ error: "Only available in demo mode" });
  db.prepare("update products set stock=?").run(
    Math.max(0, Math.min(1000, Math.floor(+req.body.stock) || 10)),
  );
  res.json({ ok: true });
});

// Safaricom calls this when the customer pays (or cancels)
app.post("/api/mpesa/callback", (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (cb) {
    if (cb.ResultCode === 0) {
      const v = (n) =>
        cb.CallbackMetadata.Item.find((i) => i.Name === n)?.Value;
      markPaid(cb.CheckoutRequestID, v("MpesaReceiptNumber"), v("Amount"));
    } else fail("checkout_id", cb.CheckoutRequestID);
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res
    .status(err.status || 500)
    .json({ error: "Something went wrong on our side. Please try again." });
});
if (JWT_SECRET === "change-me")
  console.warn("WARNING: set a long random JWT_SECRET in .env");
if (!ADMIN_EMAIL || !ADMIN_PASSWORD)
  console.warn(
    "Admin login is disabled: set ADMIN_EMAIL and ADMIN_PASSWORD in .env",
  );
if (MPESA_ENV !== "demo" && !BASE_URL)
  console.warn(
    "WARNING: BASE_URL is needed so Safaricom can reach /api/mpesa/callback",
  );
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));

// Unpaid orders release their stock after 10 minutes
setInterval(() => {
  for (const o of db
    .prepare(
      "select id from orders where status='pending' and created < datetime('now','-10 minutes')",
    )
    .all())
    fail("id", o.id);
}, 60000);

{
  const n = (t) => db.prepare(`select count(*) c from ${t}`).get().c;
  console.log(`Catalog: ${n("products")} pieces, ${n("outfits")} outfits`);
}
app.listen(PORT, () =>
  console.log(
    `Lune running on http://localhost:${PORT} (M-Pesa: ${MPESA_ENV})`,
  ),
);

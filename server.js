const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const sql = require("mssql");

const app = express();

/* Stripe webhook raw body */
app.use("/stripe-webhook", express.raw({ type: "application/json" }));

/* SQL config */
const dbConfig = {
user: process.env.DB_USER,
password: process.env.DB_PASS,
server: process.env.DB_SERVER,
options: {
encrypt: false,
trustServerCertificate: true
}
};

/* STRIPE WEBHOOK */
app.post("/stripe-webhook", async (req, res) => {

const sig = req.headers["stripe-signature"];

let event;

try {

```
event = stripe.webhooks.constructEvent(
  req.body,
  sig,
  process.env.STRIPE_WEBHOOK_SECRET
);
```

} catch (err) {

```
console.log("Webhook signature failed:", err.message);
return res.status(400).send("Webhook Error");
```

}

console.log("Stripe event:", event.type);

if (event.type === "checkout.session.completed") {

```
try {

  const session = await stripe.checkout.sessions.retrieve(
    event.data.object.id,
    { expand: ["line_items"] }
  );

  const amount = session.amount_total / 100;
  const character = session.custom_fields?.[0]?.text?.value;
  const sessionId = session.id;
  const priceId = session.line_items?.data?.[0]?.price?.id;

  console.log("Amount:", amount);
  console.log("Character:", character);
  console.log("PriceID:", priceId);

  let coins = 0;
  let packType = "normal";

  /* NORMAL COIN PACKS */

  if (amount === 10) coins = 10000;
  if (amount === 20) coins = 22000;
  if (amount === 50) coins = 57000;
  if (amount === 100) coins = 125000;
  if (amount === 200) coins = 300000;

  /* STARTER PACK */

  if (priceId === "price_1T8UpUDOoGuwc7PeA7ryumnb") {

    coins = 70000;
    packType = "starter";

  }

  if (!character || coins === 0) {

    console.log("Invalid character or pack");
    return res.sendStatus(200);

  }

  const pool = await sql.connect(dbConfig);

  /* DUPLICATE PAYMENT CHECK */

  const duplicate = await pool.request()
    .input("sessionId", sql.VarChar, sessionId)
    .query(`
      SELECT stripe_session_id
      FROM cash.dbo.donation_log
      WHERE stripe_session_id = @sessionId
    `);

  if (duplicate.recordset.length > 0) {

    console.log("Duplicate payment blocked:", sessionId);
    return res.sendStatus(200);

  }

  /* LIMITED PACK CHECK */

  if (packType === "starter") {

    const limitCheck = await pool.request().query(`
      SELECT sold, max_sold
      FROM cash.dbo.limited_packs
      WHERE pack_name = 'starter_pack'
    `);

    const sold = limitCheck.recordset[0].sold;
    const max = limitCheck.recordset[0].max_sold;

    if (sold >= max) {

      console.log("Starter pack sold out");
      return res.sendStatus(200);

    }

    await pool.request().query(`
      UPDATE cash.dbo.limited_packs
      SET sold = sold + 1
      WHERE pack_name = 'starter_pack'
    `);

  }

  /* GIVE COINS */

  await pool.request()
    .input("coins", sql.Int, coins)
    .input("character", sql.VarChar(50), character)
    .query(`
      UPDATE cash.dbo.user_cash
      SET amount = amount + @coins
      WHERE user_no = (
        SELECT user_no
        FROM character.dbo.USER_CHARACTER
        WHERE character_name = @character
      )
    `);

  /* LOG PAYMENT */

  await pool.request()
    .input("sessionId", sql.VarChar, sessionId)
    .input("character", sql.VarChar(50), character)
    .input("coins", sql.Int, coins)
    .query(`
      INSERT INTO cash.dbo.donation_log
      (stripe_session_id, character_name, coins)
      VALUES (@sessionId, @character, @coins)
    `);

  console.log("Coins sent successfully");

} catch (err) {

  console.log("SQL ERROR:", err);

}
```

}

res.json({ received: true });

});

/* WEBSITE PACK COUNTER API */

app.get("/pack-status", async (req, res) => {

try {

```
const pool = await sql.connect(dbConfig);

const result = await pool.request().query(`
  SELECT sold, max_sold
  FROM cash.dbo.limited_packs
  WHERE pack_name = 'starter_pack'
`);

res.json(result.recordset[0]);
```

} catch (err) {

```
console.log(err);
res.status(500).send("Database error");
```

}

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

console.log("Stripe webhook server running on port", PORT);

});

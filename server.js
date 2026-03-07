const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const sql = require("mssql");

const app = express();

/* Stripe webhook heeft raw body nodig */
app.use(
  "/stripe-webhook",
  express.raw({ type: "application/json" })
);

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_SERVER,
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

app.post("/stripe-webhook", async (req, res) => {

  const sig = req.headers["stripe-signature"];

  let event;

  try {

    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (err) {

    console.log("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);

  }

  console.log("Stripe event:", event.type);

  if (event.type === "checkout.session.completed") {

    const session = event.data.object;

    const amount = session.amount_total / 100;

    const character = session.custom_fields?.[0]?.text?.value;

    const sessionId = session.id;

    console.log("Payment amount:", amount);
    console.log("Character:", character);

    let coins = 0;

    if (amount === 10) coins = 10000;
    if (amount === 20) coins = 22000;
    if (amount === 50) coins = 57000;
    if (amount === 100) coins = 125000;
    if (amount === 200) coins = 300000;

    if (!character || coins === 0) {

      console.log("Invalid character or amount");
      return res.sendStatus(200);

    }

    try {

      const pool = await sql.connect(dbConfig);

      /* Check duplicate payment */

      const check = await pool.request()
        .input("sessionId", sql.VarChar, sessionId)
        .query(`
          SELECT stripe_session_id
          FROM cash.dbo.donation_log
          WHERE stripe_session_id = @sessionId
        `);

      if (check.recordset.length > 0) {

        console.log("Duplicate payment blocked:", sessionId);
        return res.sendStatus(200);

      }

      /* Give coins */

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

      /* Log payment */

      await pool.request()
        .input("sessionId", sql.VarChar, sessionId)
        .input("character", sql.VarChar(50), character)
        .input("coins", sql.Int, coins)
        .query(`
          INSERT INTO cash.dbo.donation_log
          (stripe_session_id, character_name, coins)
          VALUES (@sessionId, @character, @coins)
        `);

      console.log(`SUCCESS: ${coins} coins sent to ${character}`);

    } catch (err) {

      console.log("SQL ERROR:", err);

    }

  }

  res.json({ received: true });

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Stripe webhook server running on port", PORT);
});
app.get("/pack-status", async (req, res) => {

    try {

        const pool = await sql.connect(dbConfig);

        const result = await pool.request().query(`
            SELECT sold, max_sold
            FROM cash.dbo.limited_packs
            WHERE pack_name = 'weekend_pack'
        `);

        res.json(result.recordset[0]);

    } catch (err) {

        console.log(err);
        res.status(500).send("Database error");

    }

});

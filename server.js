const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const sql = require("mssql");

const app = express();

/* Alleen raw body voor Stripe webhook */
app.use("/stripe-webhook", express.raw({ type: "application/json" }));

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
    return res.status(400).send("Webhook Error");
  }

  console.log("Stripe event:", event.type);

  if (event.type === "checkout.session.completed") {
    try {
      const session = await stripe.checkout.sessions.retrieve(
        event.data.object.id,
        { expand: ["line_items"] }
      );

      const amount = session.amount_total / 100;
      const character = session.custom_fields?.[0]?.text?.value?.trim();
      const sessionId = session.id;
      const priceId = session.line_items?.data?.[0]?.price?.id;

      console.log("Amount:", amount);
      console.log("Character:", character);
      console.log("PriceID:", priceId);

      let coins = 0;
      let packType = "normal";

      // Normale packs
      if (amount === 10) coins = 10000;
      if (amount === 20) coins = 22000;
      if (amount === 50) coins = 57000;
      if (amount === 100) coins = 125000;
      if (amount === 200) coins = 300000;

      // Starter pack via Stripe Price ID
      if (priceId === "price_1T8UpUDOoGuwc7PeA7ryumnb") {
        coins = 70000;
        packType = "starter";
      }

      if (!character || coins === 0) {
        console.log("Invalid character or pack");
        return res.sendStatus(200);
      }

      const pool = await sql.connect(dbConfig);

      // Dubbele betaling blokkeren
      const duplicate = await pool
        .request()
        .input("sessionId", sql.VarChar(255), sessionId)
        .query(`
          SELECT stripe_session_id
          FROM cash.dbo.donation_log
          WHERE stripe_session_id = @sessionId
        `);

      if (duplicate.recordset.length > 0) {
        console.log("Duplicate payment blocked:", sessionId);
        return res.sendStatus(200);
      }

      // Starter pack limiet check
      if (packType === "starter") {
        const limitCheck = await pool.request().query(`
          SELECT sold, max_sold
          FROM cash.dbo.limited_packs
          WHERE pack_name = 'starter_pack'
        `);

        if (!limitCheck.recordset.length) {
          console.log("starter_pack row not found in cash.dbo.limited_packs");
          return res.sendStatus(200);
        }

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

      // Coins geven
      const updateResult = await pool
        .request()
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

      if (updateResult.rowsAffected[0] === 0) {
        console.log("Character not found or no user_cash row updated:", character);
        return res.sendStatus(200);
      }

      // Log payment
      await pool
        .request()
        .input("sessionId", sql.VarChar(255), sessionId)
        .input("character", sql.VarChar(50), character)
        .input("coins", sql.Int, coins)
        .query(`
          INSERT INTO cash.dbo.donation_log
          (stripe_session_id, character_name, coins)
          VALUES (@sessionId, @character, @coins)
        `);

      console.log(`SUCCESS: ${coins} coins sent to ${character}`);
    } catch (err) {
      console.log("SQL/PROCESSING ERROR:", err);
    }
  }

  return res.json({ received: true });
});

app.get("/pack-status", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);

    const result = await pool.request().query(`
      SELECT sold, max_sold
      FROM cash.dbo.limited_packs
      WHERE pack_name = 'starter_pack'
    `);

    if (!result.recordset.length) {
      return res.status(404).json({ error: "starter_pack not found" });
    }

    return res.json(result.recordset[0]);
  } catch (err) {
    console.log("PACK STATUS ERROR:", err);
    return res.status(500).send("Database error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Stripe webhook server running on port", PORT);
});

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
      const session = event.data.object;

      const amount = session.amount_total / 100;
      const inputCharacter = session.custom_fields?.[0]?.text?.value?.trim();
      const sessionId = session.id;

      console.log("Amount:", amount);
      console.log("Input Character:", inputCharacter);

      if (!inputCharacter) {
        console.log("Invalid character");
        return res.sendStatus(200);
      }

      const pool = await sql.connect(dbConfig);

      /* DUPLICATE PAYMENT CHECK */
      const duplicate = await pool.request()
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

      let coins = 0;
      let finalCharacter = inputCharacter;

      /* VIP PACK (€99) */
      if (amount === 99) {
        const baseCharacter = inputCharacter.startsWith("{VIP}")
          ? inputCharacter.substring(5)
          : inputCharacter;

        const vipCharacter = `{VIP}${baseCharacter}`;

        const charCheck = await pool.request()
          .input("normalCharacter", sql.VarChar(50), baseCharacter)
          .input("vipCharacter", sql.VarChar(60), vipCharacter)
          .query(`
            SELECT TOP 1 character_name
            FROM character.dbo.USER_CHARACTER
            WHERE character_name = @normalCharacter
               OR character_name = @vipCharacter
          `);

        if (charCheck.recordset.length === 0) {
          console.log("VIP pack character not found:", inputCharacter);
          return res.sendStatus(200);
        }

        const existingCharacter = charCheck.recordset[0].character_name;
        const alreadyVip = existingCharacter.startsWith("{VIP}");

        /* Rename to VIP if not already VIP */
        if (!alreadyVip) {
          const renameResult = await pool.request()
            .input("newName", sql.VarChar(60), vipCharacter)
            .input("oldName", sql.VarChar(50), baseCharacter)
            .query(`
              UPDATE character.dbo.USER_CHARACTER
              SET character_name = @newName
              WHERE character_name = @oldName
            `);

          if (renameResult.rowsAffected[0] === 0) {
            console.log("VIP rename failed for:", baseCharacter);
            return res.sendStatus(200);
          }

          console.log(`VIP tag added: ${baseCharacter} -> ${vipCharacter}`);
        }

        finalCharacter = vipCharacter;
        coins = 182500;
      }

      /* NORMAL DONATIONS */
      if (amount === 10) coins = 10000;
      if (amount === 20) coins = 22000;
      if (amount === 50) coins = 57000;
      if (amount === 100) coins = 125000;
      if (amount === 200) coins = 300000;

      /* VIP BONUS ON NORMAL DONATIONS */
      if (amount !== 99) {
        const charCheck = await pool.request()
          .input("character", sql.VarChar(60), inputCharacter)
          .query(`
            SELECT character_name
            FROM character.dbo.USER_CHARACTER
            WHERE character_name = @character
          `);

        if (charCheck.recordset.length === 0) {
          console.log("Character not found:", inputCharacter);
          return res.sendStatus(200);
        }

        finalCharacter = charCheck.recordset[0].character_name;

        const isVip = finalCharacter.toUpperCase().startsWith("{VIP}");

        if (isVip) {
          coins = Math.floor(coins * 1.5);
          console.log("VIP bonus applied. New coins:", coins);
        }
      }

      if (coins === 0) {
        console.log("Invalid amount:", amount);
        return res.sendStatus(200);
      }

      /* GIVE COINS */
      const updateResult = await pool.request()
        .input("coins", sql.Int, coins)
        .input("character", sql.VarChar(60), finalCharacter)
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
        console.log("No user_cash row updated for:", finalCharacter);
        return res.sendStatus(200);
      }

      /* LOG PAYMENT */
      await pool.request()
        .input("sessionId", sql.VarChar(255), sessionId)
        .input("character", sql.VarChar(60), finalCharacter)
        .input("coins", sql.Int, coins)
        .query(`
          INSERT INTO cash.dbo.donation_log
          (stripe_session_id, character_name, coins)
          VALUES (@sessionId, @character, @coins)
        `);

      console.log(`SUCCESS: ${coins} coins sent to ${finalCharacter}`);

    } catch (err) {
      console.log("SQL/PROCESSING ERROR:", err);
    }
  }

  return res.json({ received: true });
});

/* LIVE CHARACTER RANKING API */
app.get("/rankings/characters", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);

    const result = await pool.request().query(`
      SELECT TOP 100
          uc.character_name AS [character_name],
          CASE uc.byPCClass
              WHEN 0 THEN 'Azure Knight'
              WHEN 1 THEN 'Segita Hunter'
              WHEN 2 THEN 'Incar Magician'
              WHEN 3 THEN 'Vicious Summoner'
              WHEN 4 THEN 'Segnale'
              WHEN 5 THEN 'Bagi Warrior'
              WHEN 6 THEN 'Aloken'
              ELSE 'Unknown'
          END AS [class_name],
          uc.wLevel AS [level],
          ISNULL(gi.guild_name, '-') AS [guild_name],
          uc.wPKCount AS [pk_kills],
          uc.wWinRecord AS [pvp_win],
          uc.wLoseRecord AS [pvp_lose]
      FROM character.dbo.USER_CHARACTER uc
      LEFT JOIN character.dbo.GUILD_CHAR_INFO gci
          ON uc.character_name = gci.character_name
      LEFT JOIN character.dbo.GUILD_INFO gi
          ON gci.guild_code = gi.guild_code
      WHERE LEFT(uc.character_name, 4) <> '[GM]'
        AND LEFT(uc.character_name, 5) <> '[DEV]'
      ORDER BY uc.wLevel DESC, uc.dwExp DESC
    `);

    return res.json(result.recordset);

  } catch (err) {
    console.log("RANKING ERROR:", err);
    return res.status(500).send("Database error");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Stripe webhook server running on port", PORT);
});

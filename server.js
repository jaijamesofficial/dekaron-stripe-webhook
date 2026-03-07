const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const sql = require("mssql");

const app = express();
app.use(express.json());

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_SERVER,
  database: "CHARACTER",
  options: {
    trustServerCertificate: true
  }
};

app.post("/stripe-webhook", async (req, res) => {

  const event = req.body;

  if (event.type === "checkout.session.completed") {

    const session = event.data.object;

    const character = session.custom_fields[0].text.value;

    const coins = 110000;

    await sql.connect(dbConfig);

    await sql.query(`
DECLARE @character_no VARCHAR(50)
SELECT @character_no = CHARACTER.dbo.FN_GetCharacterNo('${character}')

UPDATE cash..user_cash
SET amount = amount + ${coins}
WHERE user_no = dbo.FN_GetUserNo(@character_no)
`);

  }

  res.sendStatus(200);
});

app.listen(3000);

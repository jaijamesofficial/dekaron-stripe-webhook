const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const sql = require("mssql");

const app = express();
app.use(express.json());

/* DATABASE CONFIG */
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

    const event = req.body;

    console.log("Stripe event received:", event.type);

    if (event.type === "checkout.session.completed") {

        const session = event.data.object;

        const amount = session.amount_total / 100;

        const character = session.custom_fields?.[0]?.text?.value;

        console.log("Amount paid:", amount);
        console.log("Character name:", character);

        let coins = 0;

        if (amount === 10) coins = 10000;
        if (amount === 20) coins = 22000;
        if (amount === 50) coins = 57000;
        if (amount === 100) coins = 125000;
        if (amount === 200) coins = 300000;

        if (!character) {
            console.log("ERROR: No character name received from Stripe");
            return res.sendStatus(200);
        }

        if (coins === 0) {
            console.log("ERROR: Invalid amount:", amount);
            return res.sendStatus(200);
        }

        try {

            console.log("Connecting to database...");

            const pool = await sql.connect(dbConfig);

            const query = `
UPDATE cash.dbo.user_cash
SET amount = amount + @coins
WHERE user_no = (
    SELECT user_no
    FROM character.dbo.USER_CHARACTER
    WHERE character_name = @character
)
`;

            await pool.request()
                .input("coins", sql.Int, coins)
                .input("character", sql.VarChar(50), character)
                .query(query);

            console.log(`SUCCESS: ${coins} coins sent to ${character}`);

        } catch (err) {

            console.log("SQL ERROR:", err);

        }

    }

    res.sendStatus(200);

});


/* START SERVER */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Stripe webhook server running on port", PORT);
});

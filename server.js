const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const sql = require("mssql");

const app = express();
app.use(express.json());

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

    const event = req.body;

    if (event.type === "checkout.session.completed") {

        const session = event.data.object;

        const amount = session.amount_total / 100;
        const character = session.metadata.character;

        let coins = 0;

        if (amount === 10) coins = 10000;
        if (amount === 20) coins = 22000;
        if (amount === 50) coins = 57000;
        if (amount === 100) coins = 125000;
        if (amount === 200) coins = 300000;

        if (coins > 0 && character) {

            try {

                const pool = await sql.connect(dbConfig);

                const query = `
UPDATE cash..user_cash
SET amount = amount + @coins
WHERE user_no = (
    SELECT user_no 
    FROM character 
    WHERE character_name = @character
)
`;

                await pool.request()
                    .input("coins", sql.Int, coins)
                    .input("character", sql.VarChar, character)
                    .query(query);

                console.log(`Coins sent to ${character}: ${coins}`);

            } catch (err) {

                console.log("SQL ERROR:", err);

            }

        } else {

            console.log("Invalid amount or character");

        }

    }

    res.sendStatus(200);

});

app.listen(3000, () => {
    console.log("Stripe webhook server running");
});

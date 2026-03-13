const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const sql = require("mssql");
const cors = require("cors");
const itemMap = require("./itemmap");

const app = express();

app.use(cors());

/* BELANGRIJK:
   Stripe webhook moet RAW body krijgen, dus deze route moet vóór express.json() staan
*/
app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

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

function isAdminAuthorized(req) {
  return req.body?.adminSecret === process.env.ADMIN_SECRET;
}

function adminUnauthorized(res) {
  return res.status(401).json({
    success: false,
    message: "Unauthorized"
  });
}

/* ADMIN USERNAME HELPER
   Lovable kan dit meesturen in body, bv:
   "adminUsername": "bellagm"
*/
function getAdminUsername(req) {
  return req.body?.adminUsername?.trim() || "unknown_admin";
}

/* ADMIN ACTION LOG HELPER */
async function logAdminAction(pool, adminUsername, actionType, targetCharacter = null, coinAmount = null, details = null) {
  try {
    await pool.request()
      .input("adminUsername", sql.VarChar(50), adminUsername)
      .input("actionType", sql.VarChar(50), actionType)
      .input("targetCharacter", sql.VarChar(60), targetCharacter)
      .input("coinAmount", sql.Int, coinAmount)
      .input("details", sql.VarChar(255), details)
      .query(`
        INSERT INTO cash.dbo.admin_action_log
        (admin_username, action_type, target_character, coin_amount, details)
        VALUES (@adminUsername, @actionType, @targetCharacter, @coinAmount, @details)
      `);
  } catch (err) {
    console.log("ADMIN ACTION LOG ERROR:", err);
  }
}

/* EQUIPMENT SLOT HELPER */
function getEquipmentSlotType(lineNo) {
  const n = Number(lineNo);

  if ([0, 1, 2, 3].includes(n)) return "Ring";
  if ([4, 5, 13, 14].includes(n)) return "Weapon";
  if ([6, 7].includes(n)) return "Wing / Amulet";
  if ([8, 9, 10, 11, 12].includes(n)) return "Gear";
  if ([15, 16, 17, 18, 19, 20, 21, 22, 23, 24].includes(n)) return "Potion / Candy";

  return "Unknown";
}

function getEquipmentSlotName(lineNo) {
  const n = Number(lineNo);

  const slotNames = {
    0: "Ring Slot 1",
    1: "Ring Slot 2",
    2: "Ring Slot 3",
    3: "Ring Slot 4",
    4: "Weapon Slot 1",
    5: "Weapon Slot 2",
    6: "Wing Slot",
    7: "Amulet Slot",
    8: "Helmet",
    9: "Armor",
    10: "Gloves",
    11: "Boots",
    12: "Pants",
    13: "Weapon Slot 3",
    14: "Weapon Slot 4",
    15: "Potion Slot 1",
    16: "Potion Slot 2",
    17: "Potion Slot 3",
    18: "Potion Slot 4",
    19: "Potion Slot 5",
    20: "Potion Slot 6",
    21: "Potion Slot 7",
    22: "Potion Slot 8",
    23: "Potion Slot 9",
    24: "Potion Slot 10"
  };

  return slotNames[n] || `Slot ${n}`;
}

function getItemNameByIndex(wIndex) {
  const idx = Number(wIndex);
  if (!idx || idx <= 0) return null;
  return itemMap[idx] || `Unknown Item (${idx})`;
}

/* EQUIPMENT FETCH HELPER */
async function fetchCharacterEquipment(pool, characterName) {
  const equipmentResult = await pool.request()
    .input("character", sql.VarChar(60), characterName)
    .query(`
      SELECT
        us.character_no,
        us.line_no,
        us.wIndex
      FROM character.dbo.USER_SUIT us
      INNER JOIN character.dbo.USER_CHARACTER uc
        ON uc.character_no = us.character_no
      WHERE uc.character_name = @character
        AND us.line_no BETWEEN 0 AND 24
      ORDER BY us.line_no ASC
    `);

  const equipment = equipmentResult.recordset.map((row) => ({
    line_no: row.line_no,
    slot_type: getEquipmentSlotType(row.line_no),
    slot_name: getEquipmentSlotName(row.line_no),
    wIndex: row.wIndex,
    item_name: getItemNameByIndex(row.wIndex),
    equipped: Number(row.wIndex) > 0
  }));

  return equipment;
}

/* Rank query helper */
const rankingQuery = `
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
      uc.wLoseRecord AS [pvp_lose],
      CASE
        WHEN (uc.wWinRecord + uc.wLoseRecord) = 0 THEN CAST(0.0 AS DECIMAL(5,1))
        ELSE CAST(ROUND((CAST(uc.wWinRecord AS FLOAT) / (uc.wWinRecord + uc.wLoseRecord)) * 100.0, 1) AS DECIMAL(5,1))
      END AS [score]
  FROM character.dbo.USER_CHARACTER uc
  LEFT JOIN character.dbo.GUILD_CHAR_INFO gci
      ON uc.character_name = gci.character_name
  LEFT JOIN character.dbo.GUILD_INFO gi
      ON gci.guild_code = gi.guild_code
  WHERE LEFT(uc.character_name, 4) <> '[GM]'
    AND LEFT(uc.character_name, 5) <> '[DEV]'
  ORDER BY uc.wLevel DESC, uc.dwExp DESC
`;

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

          await pool.request()
            .input("sessionId", sql.VarChar(255), sessionId)
            .input("oldName", sql.VarChar(50), baseCharacter)
            .input("newName", sql.VarChar(60), vipCharacter)
            .query(`
              INSERT INTO cash.dbo.vip_log
              (stripe_session_id, old_character_name, new_character_name)
              VALUES (@sessionId, @oldName, @newName)
            `);
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

/* ADMIN: SEND COINS */
app.post("/admin/send-coins", async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) return adminUnauthorized(res);

    const { character, coins } = req.body;
    const adminUsername = getAdminUsername(req);

    if (!character || !coins) {
      return res.status(400).json({
        success: false,
        message: "Character and coins are required"
      });
    }

    const coinAmount = parseInt(coins, 10);

    if (isNaN(coinAmount) || coinAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid coin amount"
      });
    }

    const pool = await sql.connect(dbConfig);

    const checkCharacter = await pool.request()
      .input("character", sql.VarChar(60), character.trim())
      .query(`
        SELECT character_name
        FROM character.dbo.USER_CHARACTER
        WHERE character_name = @character
      `);

    if (checkCharacter.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Character not found"
      });
    }

    const updateResult = await pool.request()
      .input("character", sql.VarChar(60), character.trim())
      .input("coins", sql.Int, coinAmount)
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
      return res.status(500).json({
        success: false,
        message: "Coins were not added"
      });
    }

    await logAdminAction(
      pool,
      adminUsername,
      "send_coins",
      character.trim(),
      coinAmount,
      "Manual coin send"
    );

    return res.json({
      success: true,
      message: `${coinAmount} coins sent to ${character.trim()}`
    });

  } catch (err) {
    console.log("ADMIN SEND COINS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ADMIN: ADD VIP TAG */
app.post("/admin/add-vip", async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) return adminUnauthorized(res);

    const { character } = req.body;
    const adminUsername = getAdminUsername(req);

    if (!character || !character.trim()) {
      return res.status(400).json({
        success: false,
        message: "Character is required"
      });
    }

    const inputCharacter = character.trim();
    const pool = await sql.connect(dbConfig);

    const charCheck = await pool.request()
      .input("character", sql.VarChar(60), inputCharacter)
      .query(`
        SELECT character_name
        FROM character.dbo.USER_CHARACTER
        WHERE character_name = @character
      `);

    if (charCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Character not found"
      });
    }

    const existingCharacter = charCheck.recordset[0].character_name;

    if (existingCharacter.toUpperCase().startsWith("{VIP}")) {
      return res.status(400).json({
        success: false,
        message: "Character already has VIP tag"
      });
    }

    const vipCharacter = `{VIP}${existingCharacter}`;

    const duplicateVipCheck = await pool.request()
      .input("vipCharacter", sql.VarChar(60), vipCharacter)
      .query(`
        SELECT character_name
        FROM character.dbo.USER_CHARACTER
        WHERE character_name = @vipCharacter
      `);

    if (duplicateVipCheck.recordset.length > 0) {
      return res.status(400).json({
        success: false,
        message: "VIP character name already exists"
      });
    }

    const renameResult = await pool.request()
      .input("oldName", sql.VarChar(60), existingCharacter)
      .input("newName", sql.VarChar(60), vipCharacter)
      .query(`
        UPDATE character.dbo.USER_CHARACTER
        SET character_name = @newName
        WHERE character_name = @oldName
      `);

    if (renameResult.rowsAffected[0] === 0) {
      return res.status(500).json({
        success: false,
        message: "VIP tag could not be added"
      });
    }

    await pool.request()
      .input("sessionId", sql.VarChar(255), `admin_add_vip_${Date.now()}`)
      .input("oldName", sql.VarChar(60), existingCharacter)
      .input("newName", sql.VarChar(60), vipCharacter)
      .query(`
        INSERT INTO cash.dbo.vip_log
        (stripe_session_id, old_character_name, new_character_name)
        VALUES (@sessionId, @oldName, @newName)
      `);

    await logAdminAction(
      pool,
      adminUsername,
      "add_vip",
      existingCharacter,
      null,
      `Renamed to ${vipCharacter}`
    );

    return res.json({
      success: true,
      message: `VIP tag added: ${existingCharacter} -> ${vipCharacter}`
    });

  } catch (err) {
    console.log("ADMIN ADD VIP ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ADMIN: REMOVE VIP TAG */
app.post("/admin/remove-vip", async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) return adminUnauthorized(res);

    const { character } = req.body;
    const adminUsername = getAdminUsername(req);

    if (!character || !character.trim()) {
      return res.status(400).json({
        success: false,
        message: "Character is required"
      });
    }

    const inputCharacter = character.trim();
    const vipCharacter = inputCharacter.startsWith("{VIP}")
      ? inputCharacter
      : `{VIP}${inputCharacter}`;

    const pool = await sql.connect(dbConfig);

    const vipCheck = await pool.request()
      .input("vipCharacter", sql.VarChar(60), vipCharacter)
      .query(`
        SELECT character_name
        FROM character.dbo.USER_CHARACTER
        WHERE character_name = @vipCharacter
      `);

    if (vipCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "VIP character not found"
      });
    }

    const existingVipCharacter = vipCheck.recordset[0].character_name;
    const normalCharacter = existingVipCharacter.substring(5);

    const normalExists = await pool.request()
      .input("normalCharacter", sql.VarChar(60), normalCharacter)
      .query(`
        SELECT character_name
        FROM character.dbo.USER_CHARACTER
        WHERE character_name = @normalCharacter
      `);

    if (normalExists.recordset.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Normal character name already exists"
      });
    }

    const renameResult = await pool.request()
      .input("oldName", sql.VarChar(60), existingVipCharacter)
      .input("newName", sql.VarChar(60), normalCharacter)
      .query(`
        UPDATE character.dbo.USER_CHARACTER
        SET character_name = @newName
        WHERE character_name = @oldName
      `);

    if (renameResult.rowsAffected[0] === 0) {
      return res.status(500).json({
        success: false,
        message: "VIP tag could not be removed"
      });
    }

    await pool.request()
      .input("sessionId", sql.VarChar(255), `admin_remove_vip_${Date.now()}`)
      .input("oldName", sql.VarChar(60), existingVipCharacter)
      .input("newName", sql.VarChar(60), normalCharacter)
      .query(`
        INSERT INTO cash.dbo.vip_log
        (stripe_session_id, old_character_name, new_character_name)
        VALUES (@sessionId, @oldName, @newName)
      `);

    await logAdminAction(
      pool,
      adminUsername,
      "remove_vip",
      existingVipCharacter,
      null,
      `Renamed to ${normalCharacter}`
    );

    return res.json({
      success: true,
      message: `VIP tag removed: ${existingVipCharacter} -> ${normalCharacter}`
    });

  } catch (err) {
    console.log("ADMIN REMOVE VIP ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ADMIN: CHARACTER SEARCH */
app.post("/admin/character-search", async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) return adminUnauthorized(res);

    const { character, includeEquipment } = req.body;
    const adminUsername = getAdminUsername(req);

    if (!character || !character.trim()) {
      return res.status(400).json({
        success: false,
        message: "Character is required"
      });
    }

    const inputCharacter = character.trim();
    const normalCharacter = inputCharacter.startsWith("{VIP}")
      ? inputCharacter.substring(5)
      : inputCharacter;
    const vipCharacter = `{VIP}${normalCharacter}`;

    const pool = await sql.connect(dbConfig);

    const result = await pool.request()
      .input("inputCharacter", sql.VarChar(60), inputCharacter)
      .input("normalCharacter", sql.VarChar(60), normalCharacter)
      .input("vipCharacter", sql.VarChar(60), vipCharacter)
      .query(`
        SELECT TOP 1
          uc.character_name AS character_name,
          CASE uc.byPCClass
            WHEN 0 THEN 'Azure Knight'
            WHEN 1 THEN 'Segita Hunter'
            WHEN 2 THEN 'Incar Magician'
            WHEN 3 THEN 'Vicious Summoner'
            WHEN 4 THEN 'Segnale'
            WHEN 5 THEN 'Bagi Warrior'
            WHEN 6 THEN 'Aloken'
            ELSE 'Unknown'
          END AS class_name,
          uc.wLevel AS level,
          ISNULL(gi.guild_name, '-') AS guild_name,
          uc.wPKCount AS pk_kills,
          uc.wWinRecord AS pvp_win,
          uc.wLoseRecord AS pvp_lose,
          uc.user_no AS user_no,
          uc.character_no AS character_no,
          CASE
            WHEN UPPER(uc.character_name) LIKE '{VIP}%'
            THEN 1
            ELSE 0
          END AS is_vip,
          ISNULL(ucash.amount, 0) AS current_coins
        FROM character.dbo.USER_CHARACTER uc
        LEFT JOIN character.dbo.GUILD_CHAR_INFO gci
          ON uc.character_name = gci.character_name
        LEFT JOIN character.dbo.GUILD_INFO gi
          ON gci.guild_code = gi.guild_code
        LEFT JOIN cash.dbo.user_cash ucash
          ON uc.user_no = ucash.user_no
        WHERE uc.character_name = @inputCharacter
           OR uc.character_name = @normalCharacter
           OR uc.character_name = @vipCharacter
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Character not found"
      });
    }

    const foundCharacter = result.recordset[0];
    let equipment = [];

    if (includeEquipment === true) {
      equipment = await fetchCharacterEquipment(pool, foundCharacter.character_name);
    }

    await logAdminAction(
      pool,
      adminUsername,
      "character_search",
      inputCharacter,
      null,
      includeEquipment === true
        ? "Character search opened with equipment"
        : "Character search opened"
    );

    return res.json({
      success: true,
      character: foundCharacter,
      equipment
    });

  } catch (err) {
    console.log("ADMIN CHARACTER SEARCH ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ADMIN: CHARACTER EQUIPMENT CHECKER */
app.post("/admin/character-equipment", async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) return adminUnauthorized(res);

    const { character } = req.body;
    const adminUsername = getAdminUsername(req);

    if (!character || !character.trim()) {
      return res.status(400).json({
        success: false,
        message: "Character is required"
      });
    }

    const inputCharacter = character.trim();
    const normalCharacter = inputCharacter.startsWith("{VIP}")
      ? inputCharacter.substring(5)
      : inputCharacter;
    const vipCharacter = `{VIP}${normalCharacter}`;

    const pool = await sql.connect(dbConfig);

    const charResult = await pool.request()
      .input("inputCharacter", sql.VarChar(60), inputCharacter)
      .input("normalCharacter", sql.VarChar(60), normalCharacter)
      .input("vipCharacter", sql.VarChar(60), vipCharacter)
      .query(`
        SELECT TOP 1
          uc.character_name,
          uc.character_no,
          CASE uc.byPCClass
            WHEN 0 THEN 'Azure Knight'
            WHEN 1 THEN 'Segita Hunter'
            WHEN 2 THEN 'Incar Magician'
            WHEN 3 THEN 'Vicious Summoner'
            WHEN 4 THEN 'Segnale'
            WHEN 5 THEN 'Bagi Warrior'
            WHEN 6 THEN 'Aloken'
            ELSE 'Unknown'
          END AS class_name,
          uc.wLevel AS level
        FROM character.dbo.USER_CHARACTER uc
        WHERE uc.character_name = @inputCharacter
           OR uc.character_name = @normalCharacter
           OR uc.character_name = @vipCharacter
      `);

    if (charResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Character not found"
      });
    }

    const foundCharacter = charResult.recordset[0];
    const equipment = await fetchCharacterEquipment(pool, foundCharacter.character_name);

    await logAdminAction(
      pool,
      adminUsername,
      "view_equipment",
      foundCharacter.character_name,
      null,
      "Opened equipment checker"
    );

    return res.json({
      success: true,
      character: foundCharacter,
      equipment
    });

  } catch (err) {
    console.log("ADMIN CHARACTER EQUIPMENT ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ADMIN: DONATION LOGS */
app.post("/admin/donation-logs", async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) return adminUnauthorized(res);

    const limit = Math.min(parseInt(req.body.limit || 50, 10), 200);
    const adminUsername = getAdminUsername(req);

    const pool = await sql.connect(dbConfig);

    const result = await pool.request()
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          id,
          stripe_session_id,
          character_name,
          coins,
          created_at
        FROM cash.dbo.donation_log
        ORDER BY created_at DESC, id DESC
      `);

    await logAdminAction(
      pool,
      adminUsername,
      "view_donation_logs",
      null,
      null,
      `Opened donation logs with limit ${limit}`
    );

    return res.json({
      success: true,
      logs: result.recordset
    });

  } catch (err) {
    console.log("ADMIN DONATION LOGS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ADMIN: RANKINGS */
app.post("/admin/rankings/characters", async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) return adminUnauthorized(res);

    const adminUsername = getAdminUsername(req);
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query(rankingQuery);

    await logAdminAction(
      pool,
      adminUsername,
      "view_rankings",
      null,
      null,
      "Opened character rankings"
    );

    return res.json({
      success: true,
      rankings: result.recordset
    });

  } catch (err) {
    console.log("ADMIN RANKINGS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ADMIN: ACTIVITY LOG */
app.post("/admin/activity-log", async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) return adminUnauthorized(res);

    const limit = Math.min(parseInt(req.body.limit || 100, 10), 300);
    const pool = await sql.connect(dbConfig);

    const result = await pool.request()
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          id,
          admin_username,
          action_type,
          target_character,
          coin_amount,
          details,
          created_at
        FROM cash.dbo.admin_action_log
        ORDER BY created_at DESC, id DESC
      `);

    return res.json({
      success: true,
      logs: result.recordset
    });

  } catch (err) {
    console.log("ADMIN ACTIVITY LOG ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* PUBLIC RANKINGS */
app.get("/rankings/characters", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query(rankingQuery);
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

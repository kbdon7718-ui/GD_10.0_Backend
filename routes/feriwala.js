// backend/routes/feriwala.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* --------------------------------------------------------
   1️⃣ ADD NEW FERIWALA PURCHASE
-------------------------------------------------------- */
router.post("/add", async (req, res) => {
  const client = await pool.connect();

  try {
    const { company_id, godown_id, vendor_id, scraps, account_id } = req.body;

    if (!company_id || !godown_id || !vendor_id || !scraps?.length) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!account_id) {
      return res.status(400).json({ error: "Account ID is required" });
    }

    await client.query("BEGIN");

    /* 🔥 FIX — your DB uses "name", not vendor_name */
    const vendorRes = await client.query(
      `SELECT name AS vendor_name FROM vendors WHERE id = $1`,
      [vendor_id]
    );

    if (vendorRes.rowCount === 0)
      return res.status(404).json({ error: "Vendor not found" });

    const vendor_name = vendorRes.rows[0].vendor_name;

    let totalAmount = 0;

    /* CREATE MAIN FERIWALA RECORD */
    const mainRecord = await client.query(
      `
      INSERT INTO feriwala_records 
      (id, company_id, godown_id, vendor_id, date, total_amount, created_at)
      VALUES (uuid_generate_v4(), $1, $2, $3, CURRENT_DATE, 0, NOW())
      RETURNING id;
    `,
      [company_id, godown_id, vendor_id]
    );

    const feriwala_id = mainRecord.rows[0].id;

    /* PROCESS SCRAPS */
    for (const s of scraps) {
      const scrapTypeId = s.scrap_type_id || s.material || s.material_id;

      const rateQuery = await client.query(
        `
        SELECT vr.vendor_rate, st.material_type 
        FROM vendor_rates vr
        JOIN scrap_types st ON st.id = vr.scrap_type_id
        WHERE vr.vendor_id = $1 AND vr.scrap_type_id = $2
      `,
        [vendor_id, scrapTypeId]
      );

      if (rateQuery.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Vendor has no rate for scrap_type_id: ${scrapTypeId}`,
        });
      }

      const vendor_rate = Number(rateQuery.rows[0].vendor_rate);
      const material = rateQuery.rows[0].material_type;
      const weight = Number(s.weight  || 0);
      const amount = vendor_rate * weight;

      totalAmount += amount;

      /* INSERT SCRAP ENTRY */
      await client.query(
        `
        INSERT INTO feriwala_scraps 
        (id, feriwala_id, material, weight, rate, amount)
        VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5)
      `,
        [feriwala_id, material, weight, vendor_rate, amount]
      );
    }

    /* UPDATE TOTAL AMOUNT */
    await client.query(
      `
      UPDATE feriwala_records 
      SET total_amount = $1 
      WHERE id = $2
    `,
      [totalAmount, feriwala_id]
    );

    /* =====================================================
   🔻 AUTO DEBIT ROKADI FOR FERIWALA PURCHASE
===================================================== */

// decide source (cash / bank)
const rokadiAccountType =
  req.body.payment_mode &&
  req.body.payment_mode.toLowerCase() === "cash"
    ? "cash"
    : "bank";

// get rokadi account

// insert rokadi transaction (DEBIT)
await client.query(
  `
  INSERT INTO rokadi_transactions
  (id, company_id, godown_id, account_id,
   type, amount, category, reference, created_at)
  VALUES
  (uuid_generate_v4(), $1, $2, $3,
   'debit', $4, 'feriwala', $5, NOW())
  `,
  [
    company_id,
    godown_id,
    rokadiAccountId,
    totalAmount,
    `Feriwala purchase: ${vendor_name}`,
  ]
);

// update rokadi balance
await client.query(
  `
  UPDATE rokadi_accounts
  SET balance = balance - $1
  WHERE id = $2
  `,
  [totalAmount, rokadiAccountId]
);


    await client.query("COMMIT");

    res.json({
      success: true,
      feriwala_id,
      totalAmount,
      vendor: vendor_name,
      message: "Feriwala purchase added successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Feriwala ADD Error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/* --------------------------------------------------------
   2️⃣ LIST PURCHASES (OWNER DASHBOARD)
-------------------------------------------------------- */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({ error: "company_id and godown_id required" });
    }

    const mainQuery = await pool.query(
      `
      SELECT 
        fr.id,
        fr.date,
        fr.company_id,
        fr.godown_id,
        fr.vendor_id,
        fr.total_amount,
        v.name AS vendor_name      -- ✅ FIXED
      FROM feriwala_records fr
      LEFT JOIN vendors v ON v.id = fr.vendor_id
      WHERE fr.company_id = $1
        AND fr.godown_id = $2
      ORDER BY fr.date DESC
    `,
      [company_id, godown_id]
    );

    const feriwalaRecords = mainQuery.rows;

    for (const r of feriwalaRecords) {
      const scrapQuery = await pool.query(
        `
        SELECT 
          fs.material AS material_name,
          fs.weight,
          fs.rate,
          fs.amount
        FROM feriwala_scraps fs
        WHERE fs.feriwala_id = $1
      `,
        [r.id]
      );

      r.scraps = scrapQuery.rows;
    }

    res.json({
      success: true,
      records: feriwalaRecords,
    });
  } catch (err) {
    console.error("❌ Feriwala LIST Error:", err);
    res.status(500).json({ error: "Failed to load records" });
  }
});

/* --------------------------------------------------------
   COMMON BALANCE HELPER
-------------------------------------------------------- */
async function computeBalance(poolClient, company_id, godown_id, vendor_id, date) {
  const maalRes = await poolClient.query(
    `
      SELECT COALESCE(SUM(total_amount),0) AS maal 
      FROM feriwala_records 
      WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3
      AND ($4::date IS NULL OR date <= $4::date)
    `,
    [company_id, godown_id, vendor_id, date || null]
  );

  const wdRes = await poolClient.query(
    `
      SELECT COALESCE(SUM(amount),0) AS withdrawal 
      FROM feriwala_withdrawals 
      WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3
      AND ($4::date IS NULL OR date <= $4::date)
    `,
    [company_id, godown_id, vendor_id, date || null]
  );

  return Number(wdRes.rows[0].withdrawal) - Number(maalRes.rows[0].maal);
}

/* --------------------------------------------------------
   3️⃣ WITHDRAWAL ENTRY
-------------------------------------------------------- */
router.post("/withdrawal", async (req, res) => {
  const client = await pool.connect();

  try {
    const { company_id, godown_id, vendor_id, amount, date, note } = req.body;

    if (!company_id || !godown_id || !vendor_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    try {
      await client.query(
        `
        INSERT INTO feriwala_withdrawals 
        (id, company_id, godown_id, vendor_id, amount, date, note, created_at)
        VALUES (uuid_generate_v4(), $1,$2,$3,$4,$5,$6,NOW())
      `,
        [company_id, godown_id, vendor_id, amount, date, note || ""]
      );
    } catch {
      await client.query(
        `
        INSERT INTO feriwala_withdrawals 
        (id, company_id, godown_id, vendor_id, amount, date, created_at)
        VALUES (uuid_generate_v4(), $1,$2,$3,$4,$5,NOW())
      `,
        [company_id, godown_id, vendor_id, amount, date]
      );
    }

    await client.query("COMMIT");

    res.json({ success: true, message: "Withdrawal recorded" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Withdrawal Error:", err);
    res.status(500).json({ error: "Internal error" });
  } finally {
    client.release();
  }
});

/* --------------------------------------------------------
   4️⃣ BALANCE OF ONE FERIWALA
-------------------------------------------------------- */
router.get("/balance", async (req, res) => {
  try {
    const { company_id, godown_id, vendor_id, date } = req.query;

    const balance = await computeBalance(pool, company_id, godown_id, vendor_id, date);

    res.json({ success: true, balance });
  } catch (err) {
    res.status(500).json({ error: "Failed to compute balance" });
  }
});

/* --------------------------------------------------------
   5️⃣ BALANCES OF ALL FERIWALAS
-------------------------------------------------------- */
router.get("/balances", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    const vendors = await pool.query(`
      SELECT DISTINCT v.id, v.name AS vendor_name   -- ✅ FIXED
      FROM vendors v
      JOIN vendor_rates vr ON vr.vendor_id = v.id
      ORDER BY v.name ASC
    `);

    const results = [];

    for (const v of vendors.rows) {
      const balance = await computeBalance(pool, company_id, godown_id, v.id, date);
      results.push({
        vendor_id: v.id,
        vendor_name: v.vendor_name,
        balance,
      });
    }

    res.json({ success: true, balances: results });
  } catch (err) {
    console.error("❌ Balances Error:", err);
    res.status(500).json({ error: "Failed to load balances" });
  }
});
/* --------------------------------------------------------
   6️⃣ OWNER — FERIWALA LEDGER (NOTEBOOK VIEW)
-------------------------------------------------------- */
/* --------------------------------------------------------
   6️⃣ OWNER — FERIWALA LEDGER (NOTEBOOK VIEW)
-------------------------------------------------------- */
router.get("/ledger", async (req, res) => {
  try {
    const { company_id, godown_id, vendor_id } = req.query;

    if (!company_id || !godown_id || !vendor_id) {
      return res.status(400).json({ error: "Missing required params" });
    }

    /* =========================
       FETCH PURCHASES (CREDIT)
       material + weight + rate
    ========================= */
    const purchases = await pool.query(
      `
      SELECT 
        fr.date,
        'purchase' AS type,
        string_agg(
          fs.material || ' (' || fs.weight || 'kg × ₹' || fs.rate || ')',
          E'\n'
        ) AS description,
        fr.total_amount AS amount
      FROM feriwala_records fr
      JOIN feriwala_scraps fs ON fs.feriwala_id = fr.id
      WHERE fr.company_id = $1
        AND fr.godown_id = $2
        AND fr.vendor_id = $3
      GROUP BY fr.id, fr.date, fr.total_amount
      `,
      [company_id, godown_id, vendor_id]
    );

    /* =========================
       FETCH PAYMENTS (DEBIT)
    ========================= */
    const payments = await pool.query(
      `
      SELECT 
        fw.date,
        'payment' AS type,
        COALESCE(fw.note, 'Payment') AS description,
        fw.amount
      FROM feriwala_withdrawals fw
      WHERE fw.company_id = $1
        AND fw.godown_id = $2
        AND fw.vendor_id = $3
      `,
      [company_id, godown_id, vendor_id]
    );

    /* =========================
       MERGE + SORT
    ========================= */
    const ledger = [...purchases.rows, ...payments.rows].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    /* =========================
       RUNNING BALANCE
    ========================= */
    let runningBalance = 0;

    const ledgerWithBalance = ledger.map((row) => {
      if (row.type === "purchase") {
        runningBalance += Number(row.amount);
      } else {
        runningBalance -= Number(row.amount);
      }

      return {
        ...row,
        balance: runningBalance,
      };
    });

    res.json({
      success: true,
      ledger: ledgerWithBalance,
      outstanding: runningBalance,
    });
  } catch (err) {
    console.error("❌ Feriwala Ledger Error:", err);
    res.status(500).json({ error: "Failed to load ledger" });
  }
});


export default router;

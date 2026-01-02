// backend/routes/feriwala.js
import express from "express";
import { pool } from "../config/db.js";
import { randomUUID } from "crypto";

const router = express.Router();

/* --------------------------------------------------------
   Helper: upsertDailyBalance (feriwala)
-------------------------------------------------------- */
async function upsertDailyBalance(client, company_id, godown_id, vendor_id, date) {
  const prevPurchRes = await client.query(
    `SELECT COALESCE(SUM(total_amount),0) AS prev_purchase
     FROM feriwala_records
     WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3 AND date < $4::date`,
    [company_id, godown_id, vendor_id, date]
  );

  const prevPaidRes = await client.query(
    `SELECT COALESCE(SUM(amount),0) AS prev_paid
     FROM feriwala_withdrawals
     WHERE company_id=$1
       AND godown_id=$2
       AND vendor_id=$3
       AND date < $4::date`,
    [company_id, godown_id, vendor_id, date]
  );

  const todayPurchaseRes = await client.query(
    `SELECT COALESCE(SUM(total_amount),0) AS today_purchase
     FROM feriwala_records
     WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3 AND date = $4::date`,
    [company_id, godown_id, vendor_id, date]
  );

  const todayPaidRes = await client.query(
    `SELECT COALESCE(SUM(amount),0) AS today_paid
     FROM feriwala_withdrawals
     WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3 AND date = $4::date`,
    [company_id, godown_id, vendor_id, date]
  );

  const previous_balance =
    Number(prevPurchRes.rows[0].prev_purchase) -
    Number(prevPaidRes.rows[0].prev_paid);

  const current_balance =
    previous_balance +
    Number(todayPurchaseRes.rows[0].today_purchase) -
    Number(todayPaidRes.rows[0].today_paid);

  const todayPurchase = Number(todayPurchaseRes.rows[0].today_purchase);
  const todayPaid = Number(todayPaidRes.rows[0].today_paid);

  const existing = await client.query(
    `
    SELECT id
    FROM feriwala_daily_balances
    WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3 AND date=$4::date
    LIMIT 1
    `,
    [company_id, godown_id, vendor_id, date]
  );

  if (existing.rowCount) {
    await client.query(
      `
      UPDATE feriwala_daily_balances
      SET
        previous_balance = $1,
        purchase_amount = $2,
        paid_amount = $3,
        current_balance = $4,
        balance = $4
      WHERE id = $5
      `,
      [previous_balance, todayPurchase, todayPaid, current_balance, existing.rows[0].id]
    );
  } else {
    await client.query(
      `
      INSERT INTO feriwala_daily_balances
      (
        id, company_id, godown_id, vendor_id, date,
        previous_balance, purchase_amount, paid_amount, current_balance, balance,
        created_at
      )
      VALUES
      ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$9,NOW())
      `,
      [
        randomUUID(),
        company_id,
        godown_id,
        vendor_id,
        date,
        previous_balance,
        todayPurchase,
        todayPaid,
        current_balance,
      ]
    );
  }
}

/* --------------------------------------------------------
   1️⃣ ADD NEW FERIWALA PURCHASE
-------------------------------------------------------- */
router.post("/add", async (req, res) => {
  const client = await pool.connect();

  try {
    const { company_id, godown_id, vendor_id, scraps, account_id } = req.body;

    if (!company_id || !godown_id || !vendor_id || !scraps?.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!account_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Account ID is required" });
    }

    await client.query("BEGIN");

    /* 🔥 FIX — your DB uses "name", not vendor_name */
    const vendorRes = await client.query(
      `SELECT name AS vendor_name FROM vendors WHERE id = $1`,
      [vendor_id]
    );

    if (vendorRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Vendor not found" });
    }

    const vendor_name = vendorRes.rows[0].vendor_name;

    let totalAmount = 0;

    /* CREATE MAIN FERIWALA RECORD */
    const feriwala_id = randomUUID();

    await client.query(
      `
      INSERT INTO feriwala_records 
      (id, company_id, godown_id, vendor_id, date, total_amount, created_at)
      VALUES ($1, $2, $3, $4, CURRENT_DATE, 0, NOW())
    `,
      [feriwala_id, company_id, godown_id, vendor_id]
    );

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
      const weight = Number(s.weight);
      const amount = vendor_rate * weight;

      totalAmount += amount;

      /* INSERT SCRAP ENTRY */
      const scrapId = randomUUID();
      await client.query(
        `
        INSERT INTO feriwala_scraps 
        (id, feriwala_id, material, weight, rate, amount)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
        [scrapId, feriwala_id, material, weight, vendor_rate, amount]
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
    /* Update daily balances (upsert) to avoid unique-constraint on repeat adds */
    await upsertDailyBalance(client, company_id, godown_id, vendor_id, new Date().toISOString().slice(0, 10));
    await client.query("COMMIT");

    res.json({
      success: true,
      feriwala_id,
      totalAmount,
      vendor: vendor_name,
      message: "Feriwala purchase added successfully",
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (e) {}
    console.error("❌ Feriwala ADD Error:", err);
    const payload = { error: "Internal server error" };
    if (process.env.NODE_ENV !== "production") {
      payload.detail = err.message;
      payload.stack = err.stack;
    }
    res.status(500).json(payload);
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

    const withdrawalId = randomUUID();
    await client.query(
      `
      INSERT INTO feriwala_withdrawals 
      (id, company_id, godown_id, vendor_id, amount, date, note, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `,
      [withdrawalId, company_id, godown_id, vendor_id, amount, date, note || ""]
    );

    /* keep daily balances in sync */
    await upsertDailyBalance(client, company_id, godown_id, vendor_id, date || new Date().toISOString().slice(0,10));

    /* Insert corresponding ROKADI transaction and update rokadi account balance */
    const rokadiType = (req.body.mode || 'cash') === 'cash' ? 'cash' : 'bank';

    const rAccRes = await client.query(
      `SELECT id FROM rokadi_accounts WHERE company_id=$1 AND godown_id=$2 AND account_type=$3 LIMIT 1`,
      [company_id, godown_id, rokadiType]
    );

    if (rAccRes.rowCount) {
      const rokadiAccountId = rAccRes.rows[0].id;
      const vendorName = (await client.query(`SELECT name FROM vendors WHERE id=$1`, [vendor_id])).rows[0]?.name;
      const displayRef = vendorName ? `Payment to ${vendorName}` : null;
      const internalRef = `feriwala_withdrawal:${withdrawalId}`;
      const metadata = {
        source: "feriwala",
        vendor_id,
        withdrawal_id: withdrawalId,
        note: displayRef,
      };

      await client.query(
        `
        INSERT INTO rokadi_transactions
          (id, company_id, godown_id, account_id, type, amount, category, reference, metadata, created_at)
        VALUES ($1,$2,$3,$4,'debit',$5,'feriwala',$6,$7::jsonb,NOW())
        `,
        [randomUUID(), company_id, godown_id, rokadiAccountId, amount, internalRef, JSON.stringify(metadata)]
      );

      await client.query(
        `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id=$2`,
        [amount, rokadiAccountId]
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
       FETCH PURCHASES
       material + weight + rate
       NOTE: purchase makes balance more NEGATIVE (payable)
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
       FETCH PAYMENTS
       NOTE: payment makes balance more POSITIVE (advance)
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
        runningBalance -= Number(row.amount);
      } else {
        runningBalance += Number(row.amount);
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

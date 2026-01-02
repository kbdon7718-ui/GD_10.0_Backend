import express from "express";
import { pool } from "../config/db.js";
import { randomUUID } from "crypto";

const router = express.Router();

/* --------------------------------------------------------
   Helper: upsertDailyBalance
-------------------------------------------------------- */
async function upsertDailyBalance(client, company_id, godown_id, vendor_id, date) {
  const prevPurchRes = await client.query(
    `SELECT COALESCE(SUM(total_amount),0) AS prev_purchase
     FROM kabadiwala_records
     WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3 AND date < $4::date`,
    [company_id, godown_id, vendor_id, date]
  );

  const prevPaidRes = await client.query(
    `SELECT COALESCE(SUM(p.amount),0) AS prev_paid
     FROM kabadiwala_records kr
     JOIN kabadiwala_payments p ON p.kabadiwala_id = kr.id
     WHERE kr.company_id=$1 AND kr.godown_id=$2 AND kr.vendor_id=$3 AND p.date < $4::date`,
    [company_id, godown_id, vendor_id, date]
  );

  const todayPurchaseRes = await client.query(
    `SELECT COALESCE(SUM(total_amount),0) AS today_purchase
     FROM kabadiwala_records
     WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3 AND date = $4::date`,
    [company_id, godown_id, vendor_id, date]
  );

  const todayPaidRes = await client.query(
    `SELECT COALESCE(SUM(p.amount),0) AS today_paid
     FROM kabadiwala_records kr
     JOIN kabadiwala_payments p ON p.kabadiwala_id = kr.id
     WHERE kr.company_id=$1 AND kr.godown_id=$2 AND kr.vendor_id=$3 AND p.date = $4::date`,
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
    FROM kabadiwala_daily_balance
    WHERE company_id=$1 AND godown_id=$2 AND vendor_id=$3 AND date=$4::date
    LIMIT 1
    `,
    [company_id, godown_id, vendor_id, date]
  );

  if (existing.rowCount) {
    await client.query(
      `
      UPDATE kabadiwala_daily_balance
      SET
        previous_balance = $1,
        purchase_amount = $2,
        paid_amount = $3,
        current_balance = $4,
        updated_at = NOW()
      WHERE id = $5
      `,
      [previous_balance, todayPurchase, todayPaid, current_balance, existing.rows[0].id]
    );
  } else {
    await client.query(
      `
      INSERT INTO kabadiwala_daily_balance
      (
        id, company_id, godown_id, vendor_id, date,
        previous_balance, purchase_amount, paid_amount, current_balance,
        created_at, updated_at
      )
      VALUES
      (uuid_generate_v4(), $1,$2,$3,$4::date,$5,$6,$7,$8,NOW(),NOW())
      `,
      [company_id, godown_id, vendor_id, date, previous_balance, todayPurchase, todayPaid, current_balance]
    );
  }
}

/* ============================================================
   ADD NEW KABADIWALA PURCHASE
============================================================ */
router.post("/add", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      vendor_id,
      scraps,
      payment_amount = 0,
      payment_mode = "cash",
      note = "",
      date = new Date().toISOString().split("T")[0],
    } = req.body;

    if (!company_id || !godown_id || !vendor_id || !scraps?.length) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    const vRes = await client.query(`SELECT name FROM vendors WHERE id=$1`, [vendor_id]);
    const kabadiwala_name = vRes.rows[0].name;

    let totalAmount = 0;

    const mainRes = await client.query(
      `INSERT INTO kabadiwala_records
       (id, company_id, godown_id, vendor_id, kabadiwala_name,
        date, total_amount, payment_mode, payment_status, created_at)
       VALUES (uuid_generate_v4(),$1,$2,$3,$4,$5,0,$6,'pending',NOW())
       RETURNING id`,
      [company_id, godown_id, vendor_id, kabadiwala_name, date, payment_mode]
    );

    const kabadi_id = mainRes.rows[0].id;

    for (const s of scraps) {
      const rateRes = await client.query(
        `SELECT vr.vendor_rate, st.material_type
         FROM vendor_rates vr
         JOIN scrap_types st ON st.id = vr.scrap_type_id
         WHERE vr.vendor_id=$1 AND vr.scrap_type_id=$2`,
        [vendor_id, s.scrap_type_id]
      );

      const rate = Number(rateRes.rows[0].vendor_rate);
      const weight = Number(s.weight);
      const amount = rate * weight;
      totalAmount += amount;

      await client.query(
        `INSERT INTO kabadiwala_scraps
         (id, kabadiwala_id, scrap_type_id, material, weight, rate, amount)
         VALUES (uuid_generate_v4(),$1,$2,$3,$4,$5,$6)`,
        [kabadi_id, s.scrap_type_id, rateRes.rows[0].material_type, weight, rate, amount]
      );
    }

    await client.query(
      `UPDATE kabadiwala_records SET total_amount=$1 WHERE id=$2`,
      [totalAmount, kabadi_id]
    );

    const paid = Number(payment_amount);

    if (paid > 0) {
      const payInsert = await client.query(
        `INSERT INTO kabadiwala_payments
         (id, kabadiwala_id, amount, mode, note, date, created_at)
         VALUES (uuid_generate_v4(),$1,$2,$3,$4,$5,NOW())
         RETURNING id`,
        [kabadi_id, paid, payment_mode, note, date]
      );

      const paymentId = payInsert.rows[0].id;

      /* 🔻 ROKADI DEBIT */
      const rokadiType =
        payment_mode.toLowerCase() === "cash" ? "cash" : "bank";

      const rRes = await client.query(
        `SELECT id FROM rokadi_accounts
         WHERE company_id=$1 AND godown_id=$2 AND account_type=$3
         LIMIT 1`,
        [company_id, godown_id, rokadiType]
      );

      const rokadiAccountId = rRes.rows[0].id;

      const displayRef = `Payment to ${kabadiwala_name}`;
      const displayRefVal = displayRef && String(displayRef).trim() ? String(displayRef).trim() : null;
      const txnId = randomUUID();
      const internalRef = `kabadiwala_payment:${paymentId}`;
      const metadata = {
        source: "kabadiwala",
        kabadiwala_id: kabadi_id,
        payment_id: paymentId,
        vendor_id,
        note: displayRefVal,
      };

      await client.query(
        `
        INSERT INTO rokadi_transactions
          (id, company_id, godown_id, account_id, type, amount, category, reference, metadata, created_at)
        VALUES ($1,$2,$3,$4,'debit',$5,'kabadiwala',$6,$7::jsonb,NOW())
        `,
        [txnId, company_id, godown_id, rokadiAccountId, paid, internalRef, JSON.stringify(metadata)]
      );

      await client.query(
        `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id=$2`,
        [paid, rokadiAccountId]
      );
    }

    await upsertDailyBalance(client, company_id, godown_id, vendor_id, date);

    await client.query("COMMIT");
    res.json({ success: true, kabadi_id });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ============================================================
   WITHDRAWAL / PAYMENT
============================================================ */
router.post("/withdrawal", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      vendor_id,
      amount,
      mode = "cash",
      note = "",
      date = new Date().toISOString().split("T")[0],
    } = req.body;

    await client.query("BEGIN");

    const vRes = await client.query(`SELECT name FROM vendors WHERE id=$1`, [vendor_id]);
    const vendor_name = vRes.rows[0].name;

    const placeholder = await client.query(
      `INSERT INTO kabadiwala_records
       (id, company_id, godown_id, vendor_id, kabadiwala_name,
        date, total_amount, payment_mode, payment_status, created_at)
       VALUES (uuid_generate_v4(),$1,$2,$3,$4,$5,0,$6,'paid',NOW())
       RETURNING id`,
      [company_id, godown_id, vendor_id, vendor_name, date, mode]
    );

    const payInsert = await client.query(
      `INSERT INTO kabadiwala_payments
       (id, kabadiwala_id, amount, mode, note, date, created_at)
       VALUES (uuid_generate_v4(),$1,$2,$3,$4,$5,NOW())
       RETURNING id`,
      [placeholder.rows[0].id, amount, mode, note, date]
    );

    const paymentId = payInsert.rows[0].id;

    const rokadiType = mode === "cash" ? "cash" : "bank";

    const rRes = await client.query(
      `SELECT id FROM rokadi_accounts
       WHERE company_id=$1 AND godown_id=$2 AND account_type=$3 LIMIT 1`,
      [company_id, godown_id, rokadiType]
    );

    const rokadiAccountId = rRes.rows[0].id;

    const payDisplayRef = `Payment to ${vendor_name}`;
    const payDisplayRefVal = payDisplayRef && String(payDisplayRef).trim() ? String(payDisplayRef).trim() : null;
    const internalRef = paymentId ? `kabadiwala_payment:${paymentId}` : `kabadiwala_payment:${randomUUID()}`;
    const metadata = {
      source: "kabadiwala",
      kabadiwala_id: placeholder.rows[0].id,
      payment_id: paymentId || null,
      vendor_id,
      note: payDisplayRefVal,
    };
    await client.query(
      `INSERT INTO rokadi_transactions
       (id, company_id, godown_id, account_id,
        type, amount, category, reference, metadata, created_at)
       VALUES ($1,$2,$3,$4,'debit',$5,'kabadiwala',$6,$7::jsonb,NOW())`,
      [
        randomUUID(),
        company_id,
        godown_id,
        rokadiAccountId,
        amount,
        internalRef,
        JSON.stringify(metadata),
      ]
    );

    await client.query(
      `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id=$2`,
      [amount, rokadiAccountId]
    );

    await upsertDailyBalance(client, company_id, godown_id, vendor_id, date);

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
/* ============================================================
   OWNER — KABADIWALA BALANCES
============================================================ */
router.get("/balances", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    const result = await pool.query(
      `
     SELECT
  d.vendor_id,
  v.name AS vendor_name,
  d.current_balance AS balance
FROM kabadiwala_daily_balance d
JOIN vendors v ON v.id = d.vendor_id
WHERE d.company_id = $1
  AND d.godown_id = $2
  AND d.date = $3::date
ORDER BY v.name;

      `,
      [
        company_id,
        godown_id,
        date || new Date().toISOString().split("T")[0],
      ]
    );

    res.json({ success: true, balances: result.rows });
  } catch (err) {
    console.error("❌ KABADIWALA BALANCES:", err.message);
    res.status(500).json({ error: err.message });
  }
});
/* ============================================================
   OWNER — KABADIWALA LEDGER (FULL HISTORY)
============================================================ */
router.get("/owner-list", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    const result = await pool.query(
      `
      SELECT
  kr.date,
  v.name AS kabadi_name,
  ks.material,
  ks.weight,
  ks.rate,
  ks.amount
FROM kabadiwala_records kr
JOIN kabadiwala_scraps ks ON ks.kabadiwala_id = kr.id
JOIN vendors v ON v.id = kr.vendor_id
WHERE kr.company_id = $1
  AND kr.godown_id = $2
ORDER BY kr.date ASC;
   `,
      [company_id, godown_id]
    );

    res.json({ success: true, entries: result.rows });
  } catch (err) {
    console.error("❌ KABADIWALA OWNER LIST:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------------
   2️⃣ LIST PURCHASES (MANAGER)
-------------------------------------------------------- */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({ error: "company_id and godown_id required" });
    }

    const mainQ = await pool.query(
      `
      SELECT
        kr.id,
        kr.date,
        kr.company_id,
        kr.godown_id,
        kr.vendor_id,
        kr.kabadiwala_name,
        kr.total_amount,
        kr.payment_status,
        v.name AS vendor_name
      FROM kabadiwala_records kr
      LEFT JOIN vendors v ON v.id = kr.vendor_id
      WHERE kr.company_id = $1
        AND kr.godown_id = $2
      ORDER BY kr.date DESC
    `,
      [company_id, godown_id]
    );

    const records = mainQ.rows;

    for (const r of records) {
      const scrapsQ = await pool.query(
        `
        SELECT material, weight, rate, amount
        FROM kabadiwala_scraps
        WHERE kabadiwala_id = $1
      `,
        [r.id]
      );
      r.scraps = scrapsQ.rows;
    }

    res.json({ success: true, kabadiwala: records });
  } catch (err) {
    console.error("❌ KABADIWALA LIST ERROR:", err.message);
    res.status(500).json({ error: "Failed to load records" });
  }
});



export default router;


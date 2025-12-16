import express from "express";
import { pool } from "../config/db.js";

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

  await client.query(
    `INSERT INTO kabadiwala_daily_balance
     (id, company_id, godown_id, vendor_id, date,
      previous_balance, purchase_amount, paid_amount, current_balance, created_at)
     VALUES (uuid_generate_v4(), $1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (company_id, godown_id, vendor_id, date)
     DO UPDATE SET
       previous_balance = EXCLUDED.previous_balance,
       purchase_amount = EXCLUDED.purchase_amount,
       paid_amount = EXCLUDED.paid_amount,
       current_balance = EXCLUDED.current_balance,
       updated_at = NOW()`,
    [
      company_id,
      godown_id,
      vendor_id,
      date,
      previous_balance,
      todayPurchaseRes.rows[0].today_purchase,
      todayPaidRes.rows[0].today_paid,
      current_balance,
    ]
  );
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
      await client.query(
        `INSERT INTO kabadiwala_payments
         (id, kabadiwala_id, amount, mode, note, date, created_at)
         VALUES (uuid_generate_v4(),$1,$2,$3,$4,$5,NOW())`,
        [kabadi_id, paid, payment_mode, note, date]
      );

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

      await client.query(
        `INSERT INTO rokadi_transactions
         (id, company_id, godown_id, account_id,
          type, amount, category, reference, created_at)
         VALUES (uuid_generate_v4(),$1,$2,$3,'debit',$4,'kabadiwala',$5,NOW())`,
        [
          company_id,
          godown_id,
          rokadiAccountId,
          paid,
          `Payment to ${kabadiwala_name}`,
        ]
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

    await client.query(
      `INSERT INTO kabadiwala_payments
       (id, kabadiwala_id, amount, mode, note, date, created_at)
       VALUES (uuid_generate_v4(),$1,$2,$3,$4,$5,NOW())`,
      [placeholder.rows[0].id, amount, mode, note, date]
    );

    const rokadiType = mode === "cash" ? "cash" : "bank";

    const rRes = await client.query(
      `SELECT id FROM rokadi_accounts
       WHERE company_id=$1 AND godown_id=$2 AND account_type=$3 LIMIT 1`,
      [company_id, godown_id, rokadiType]
    );

    const rokadiAccountId = rRes.rows[0].id;

    await client.query(
      `INSERT INTO rokadi_transactions
       (id, company_id, godown_id, account_id,
        type, amount, category, reference, created_at)
       VALUES (uuid_generate_v4(),$1,$2,$3,'debit',$4,'kabadiwala',$5,NOW())`,
      [
        company_id,
        godown_id,
        rokadiAccountId,
        amount,
        `Payment to ${vendor_name}`,
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



export default router;

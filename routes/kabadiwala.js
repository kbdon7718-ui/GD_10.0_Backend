// backend/routes/kabadiwala.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* --------------------------------------------------------
   Helper: upsertDailyBalance
   - company_id, godown_id, vendor_id, date (string YYYY-MM-DD)
   - Recomputes previous_balance, purchase_amount (on date), paid_amount (on date)
   - Upserts row into kabadiwala_daily_balance with current_balance = previous + purchase - paid
-------------------------------------------------------- */
async function upsertDailyBalance(client, company_id, godown_id, vendor_id, date) {
  // previous purchases before date
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

  const prev_purchase = Number(prevPurchRes.rows[0].prev_purchase || 0);
  const prev_paid = Number(prevPaidRes.rows[0].prev_paid || 0);
  const previous_balance = prev_purchase - prev_paid;

  const today_purchase = Number(todayPurchaseRes.rows[0].today_purchase || 0);
  const today_paid = Number(todayPaidRes.rows[0].today_paid || 0);

  const current_balance = Number((previous_balance + today_purchase - today_paid).toFixed(2));

  // Upsert into kabadiwala_daily_balance
  await client.query(
    `INSERT INTO kabadiwala_daily_balance
      (id, company_id, godown_id, vendor_id, date, previous_balance, purchase_amount, paid_amount, current_balance, created_at)
     VALUES (uuid_generate_v4(), $1,$2,$3,$4,$5,$6,$7,$8, NOW())
     ON CONFLICT (company_id, godown_id, vendor_id, date)
     DO UPDATE SET previous_balance = EXCLUDED.previous_balance,
                   purchase_amount = EXCLUDED.purchase_amount,
                   paid_amount = EXCLUDED.paid_amount,
                   current_balance = EXCLUDED.current_balance,
                   updated_at = NOW()
    `,
    [company_id, godown_id, vendor_id, date, previous_balance, today_purchase, today_paid, current_balance]
  );

  return { previous_balance, today_purchase, today_paid, current_balance };
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
      account_id,
      note = "",
      date = new Date().toISOString().split("T")[0]
    } = req.body;

    if (!company_id || !godown_id || !vendor_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!scraps?.length) {
      return res.status(400).json({ error: "Scrap items required" });
    }

    await client.query("BEGIN");

    // vendor name
    const vRes = await client.query(`SELECT name FROM vendors WHERE id=$1`, [vendor_id]);
    if (vRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Vendor not found" });
    }
    const kabadiwala_name = vRes.rows[0].name;

    let totalAmount = 0;
    const mainRes = await client.query(
      `INSERT INTO kabadiwala_records
       (id, company_id, godown_id, vendor_id, kabadiwala_name, date, total_amount, payment_mode, payment_status, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, 0, $6, 'pending', NOW())
       RETURNING id`,
      [company_id, godown_id, vendor_id, kabadiwala_name, date, payment_mode]
    );
    const kabadi_id = mainRes.rows[0].id;

    for (const s of scraps) {
      const rateRes = await client.query(
        `SELECT vr.vendor_rate, st.material_type
         FROM vendor_rates vr
         JOIN scrap_types st ON st.id = vr.scrap_type_id
         WHERE vr.vendor_id = $1 AND vr.scrap_type_id = $2`,
        [vendor_id, s.scrap_type_id]
      );
      if (rateRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Vendor rate missing for scrap_type_id ${s.scrap_type_id}` });
      }
      const rate = Number(rateRes.rows[0].vendor_rate);
      const material = rateRes.rows[0].material_type;
      const weight = Number(s.weight);
      const amount = Number((rate * weight).toFixed(2));
      totalAmount += amount;

      await client.query(
        `INSERT INTO kabadiwala_scraps
         (id, kabadiwala_id, scrap_type_id, material, weight, rate, amount)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6)`,
        [kabadi_id, s.scrap_type_id, material, weight, rate, amount]
      );
    }

    // update total
    await client.query(`UPDATE kabadiwala_records SET total_amount=$1 WHERE id=$2`, [totalAmount, kabadi_id]);

    // payment handling
    let payment_status = "pending";
    const paid = Number(payment_amount);
    if (paid >= totalAmount) payment_status = "paid";
    else if (paid > 0) payment_status = "partial";

    await client.query(`UPDATE kabadiwala_records SET payment_status=$1 WHERE id=$2`, [payment_status, kabadi_id]);

    if (paid > 0) {
      // record payment against this kabadiwala record
      await client.query(
        `INSERT INTO kabadiwala_payments
         (id, kabadiwala_id, amount, mode, note, date, created_at)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, NOW())`,
        [kabadi_id, paid, payment_mode, note, date]
      );

      if (account_id) {
        await client.query(
          `INSERT INTO account_transactions
           (id, company_id, godown_id, account_id, type, amount, category, reference, created_at)
           VALUES (uuid_generate_v4(), $1, $2, $3, 'debit', $4, 'kabadiwala payment', $5, NOW())`,
          [company_id, godown_id, account_id, paid, `Payment to ${kabadiwala_name}`]
        );
        await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id=$2`, [paid, account_id]);
      }
    }

    // recompute & upsert daily balance for this vendor & date
    await upsertDailyBalance(client, company_id, godown_id, vendor_id, date);

    await client.query("COMMIT");
    res.json({ success: true, kabadi_id, message: "Kabadiwala purchase recorded successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ KABADIWALA ADD ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ============================================================
   LIST RECORDS (MANAGER)
============================================================ */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;
    const q = `
      SELECT
        kr.*,
        COUNT(ks.id) AS items_count,
        COALESCE(SUM(ks.weight),0) AS total_weight,
        COALESCE(SUM(ks.amount),0) AS total_amount,
        COALESCE((SELECT SUM(amount) FROM kabadiwala_payments WHERE kabadiwala_id=kr.id),0) AS total_paid
      FROM kabadiwala_records kr
      LEFT JOIN kabadiwala_scraps ks ON ks.kabadiwala_id = kr.id
      WHERE kr.company_id=$1 AND kr.godown_id=$2
      GROUP BY kr.id
      ORDER BY kr.date DESC
    `;
    const r = await pool.query(q, [company_id, godown_id]);
    res.json({ success: true, kabadiwala: r.rows });
  } catch (err) {
    console.error("❌ LIST ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   OWNER VIEW (Flat List by Date)
============================================================ */
router.get("/owner-list", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;
    const q = `
      SELECT
        kr.date,
        kr.kabadiwala_name AS kabadi_name,
        ks.material,
        ks.weight,
        ks.rate,
        ks.amount,
        kr.payment_status
      FROM kabadiwala_records kr
      JOIN kabadiwala_scraps ks ON ks.kabadiwala_id = kr.id
      WHERE kr.company_id=$1
        AND kr.godown_id=$2
        AND ($3::date IS NULL OR kr.date = $3::date)
      ORDER BY kr.date DESC
    `;
    const r = await pool.query(q, [company_id, godown_id, date || null]);
    res.json({ success: true, entries: r.rows });
  } catch (err) {
    console.error("❌ OWNER LIST ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   DAILY BALANCES (Owner summary)
   Returns vendor list with prev_purchase, prev_paid, today_purchase, today_paid, and computed balance
============================================================ */
router.get("/balances", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;
    if (!date) return res.status(400).json({ error: "date is required" });

    const q = `
      SELECT 
        v.id AS vendor_id,
        v.name AS vendor_name,

        COALESCE((
          SELECT SUM(total_amount)
          FROM kabadiwala_records
          WHERE vendor_id = v.id
            AND godown_id = $2
            AND company_id = $1
            AND date < $3::date
        ), 0) AS prev_purchase,

        COALESCE((
          SELECT SUM(p.amount)
          FROM kabadiwala_records kr
          JOIN kabadiwala_payments p ON p.kabadiwala_id = kr.id
          WHERE kr.vendor_id = v.id
            AND kr.godown_id = $2
            AND kr.company_id = $1
            AND p.date < $3::date
        ), 0) AS prev_paid,

        COALESCE((
          SELECT SUM(total_amount)
          FROM kabadiwala_records
          WHERE vendor_id = v.id
            AND godown_id = $2
            AND company_id = $1
            AND date = $3::date
        ), 0) AS today_purchase,

        COALESCE((
          SELECT SUM(p.amount)
          FROM kabadiwala_records kr
          JOIN kabadiwala_payments p ON p.kabadiwala_id = kr.id
          WHERE kr.vendor_id = v.id
            AND kr.godown_id = $2
            AND kr.company_id = $1
            AND p.date = $3::date
        ), 0) AS today_paid

      FROM vendors v
      WHERE v.vendor_type = 'kabadiwala'
      ORDER BY v.name ASC
    `;

    const r = await pool.query(q, [company_id, godown_id, date]);

    const balances = r.rows.map((row) => {
      const previous_balance = Number(row.prev_purchase) - Number(row.prev_paid);
      const today_purchase = Number(row.today_purchase);
      const today_paid = Number(row.today_paid);
      const balance = Number((previous_balance +  today_paid - today_purchase).toFixed(2));
      return {
        vendor_id: row.vendor_id,
        vendor_name: row.vendor_name,
        previous_balance,
        today_purchase,
        today_paid,
        balance,
      };
    });

    res.json({ success: true, balances });
  } catch (err) {
    console.error("❌ BALANCE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   RECORD WITHDRAWAL / PAYMENT (Manager calls this when paying vendor)
   This inserts a kabadiwala_payments record and recomputes daily balance.
   Body: company_id, godown_id, vendor_id, kabadiwala_id (optional), amount, mode, note, date
============================================================ */
router.post("/withdrawal", async (req, res) => {
  const client = await pool.connect();
  try {
    const { company_id, godown_id, vendor_id, kabadiwala_id = null, amount, mode = "cash", note = "", date = new Date().toISOString().split("T")[0] } = req.body;

    if (!company_id || !godown_id || !vendor_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    // If kabadiwala_id is null, we must create a lightweight placeholder kabadiwala_records
    // row so that kabadiwala_payments.kabadiwala_id (NOT NULL FK) can point to a valid record.
    let paymentParentId = kabadiwala_id;

    if (!paymentParentId) {
      // Get vendor name for the placeholder record
      const vendorNameRes = await client.query(`SELECT name FROM vendors WHERE id=$1`, [vendor_id]);
      const vendor_name = vendorNameRes.rowCount ? vendorNameRes.rows[0].name : "Vendor";

      const placeholderRes = await client.query(
        `INSERT INTO kabadiwala_records
         (id, company_id, godown_id, vendor_id, kabadiwala_name, date, total_amount, payment_mode, payment_status, created_at)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, 0, $6, 'paid', NOW())
         RETURNING id`,
        [company_id, godown_id, vendor_id, vendor_name, date, mode]
      );

      paymentParentId = placeholderRes.rows[0].id;
    }

    // Insert payment using a valid kabadiwala_id (either provided or placeholder)
    await client.query(
      `INSERT INTO kabadiwala_payments (id, kabadiwala_id, amount, mode, note, date, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, NOW())`,
      [paymentParentId, amount, mode, note, date]
    );

    // If an account is provided in request and you want ledger entries, caller can pass account_id and we can log it (optional)
    if (req.body.account_id) {
      const account_id = req.body.account_id;
      const vendorNameRes = await client.query(`SELECT name FROM vendors WHERE id=$1`, [vendor_id]);
      const vendor_name = vendorNameRes.rowCount ? vendorNameRes.rows[0].name : "Vendor";
      await client.query(
        `INSERT INTO account_transactions
         (id, company_id, godown_id, account_id, type, amount, category, reference, created_at)
         VALUES (uuid_generate_v4(), $1, $2, $3, 'debit', $4, 'kabadiwala payment', $5, NOW())`,
        [company_id, godown_id, account_id, amount, `Payment to ${vendor_name}`]
      );
      await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id=$2`, [amount, account_id]);
    }

    // recompute daily balance for this vendor/date
    await upsertDailyBalance(client, company_id, godown_id, vendor_id, date);

    await client.query("COMMIT");
    res.json({ success: true, message: "Payment recorded and balance updated" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ KABADIWALA WITHDRAWAL ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;

// FieldLink-Mpesa :: B2C payment service (Node.js + Express)
// Flutter calls this server. This server calls Safaricom.
// Secrets stay here — never in the mobile app.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '1mb' }));


// ---- CORS for Flutter Web (Chrome / Edge) ----
const cors = require('cors');
app.use(cors({
  origin: '*',
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'ngrok-skip-browser-warning',
  ],
}));


// ---- Supabase clients ----
const supabaseUrl = process.env.SUPABASE_URL;
const serviceClient = createClient(
  supabaseUrl,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const anonClient = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY);

// ---- Daraja base URL ----
function darajaBase() {
  return process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

// ---- Auth middleware: verify the Flutter caller's Supabase JWT ----
async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!jwt) return res.status(401).json({ error: 'missing_token' });

    const { data, error } = await anonClient.auth.getUser(jwt);
    if (error || !data.user) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    req.user = data.user;
    next();
  } catch (e) {
    res.status(500).json({ error: 'auth_error', detail: String(e) });
  }
}

// =====================================================================
// POST /api/b2c/initiate
// Body: { payment_id, phone, amount }
// =====================================================================
app.post('/api/b2c/initiate', requireUser, async (req, res) => {
  try {
    const { payment_id, phone, amount } = req.body || {};
    if (!payment_id || !phone || !amount || amount <= 0) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (!/^254\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'invalid_phone' });
    }

    // Load the payment (RLS applies because we use the anon client with user's JWT)
    const userClient = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${req.headers.authorization.slice(7)}` } },
    });

    const { data: payment, error: payErr } = await userClient
      .from('payments')
      .select('id, status, method, worker_id, project_id')
      .eq('id', payment_id)
      .maybeSingle();

    if (payErr || !payment) {
      return res.status(404).json({ error: 'payment_not_found' });
    }
    if (payment.method !== 'mpesa') {
      return res.status(400).json({ error: 'not_mpesa' });
    }
    if (payment.status === 'paid') {
      return res.status(409).json({ error: 'already_paid' });
    }

    // ---- 1. Get Daraja OAuth token ----
    const basic = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
    ).toString('base64');

    const authRes = await axios.get(
      `${darajaBase()}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${basic}` } },
    );
    const accessToken = authRes.data.access_token;
    if (!accessToken) {
      return res.status(502).json({ error: 'daraja_auth_failed', detail: authRes.data });
    }

    // ---- 2. Call B2C payment request ----
    const callbackUrl = `${process.env.PUBLIC_BASE_URL}/api/b2c/callback`;

    const payload = {
      InitiatorName: process.env.MPESA_INITIATOR_NAME,
      SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
      CommandID: 'BusinessPayment',
      Amount: Math.round(amount),
      PartyA: process.env.MPESA_B2C_SHORTCODE,
      PartyB: phone,
      Remarks: `FieldLink payment ${payment_id.slice(0, 8)}`,
      QueueTimeOutURL: callbackUrl,
      ResultURL: callbackUrl,
      Occassion: 'FieldLink',
    };

    const b2cRes = await axios.post(
      `${darajaBase()}/mpesa/b2c/v1/paymentrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const b2cData = b2cRes.data;

    // ---- 3. Mark processing + store Conversation IDs ----
    await serviceClient
      .from('payments')
      .update({
        status: 'processing',
        mpesa_conversation_id: b2cData.ConversationID || null,
        mpesa_originator_conversation_id:
          b2cData.OriginatorConversationID || null,
        mpesa_result_code: b2cData.ResponseCode || null,
        mpesa_result_desc: b2cData.ResponseDescription || null,
      })
      .eq('id', payment_id);

    res.json(b2cData);
  } catch (e) {
    const detail = e.response?.data || e.message;
    console.error('B2C initiate error:', detail);
    res.status(500).json({ error: 'server_error', detail });
  }
});

// =====================================================================
// POST /api/b2c/callback
// Called by Safaricom. No auth — must be public.
// =====================================================================
app.post('/api/b2c/callback', async (req, res) => {
  try {
    const result = req.body?.Result;
    if (!result) {
      return res.status(200).json({ ok: false });
    }

    const conversationId = result.ConversationID;
    const originatorId = result.OriginatorConversationID;
    const resultCode = result.ResultCode;
    const resultDesc = result.ResultDesc;

    let receipt = null;
    let receiverName = null;
    const params = result.ResultParameters?.ResultParameter || [];
    for (const p of params) {
      if (p.Key === 'TransactionReceipt') receipt = p.Value;
      if (p.Key === 'ReceiverPartyPublicName') receiverName = p.Value;
    }

    const newStatus = resultCode === 0 ? 'paid' : 'failed';
    const update = {
      status: newStatus,
      mpesa_result_code: resultCode ?? null,
      mpesa_result_desc: resultDesc || null,
    };
    if (receipt) {
      update.mpesa_receipt = receipt;
      update.mpesa_transaction_id = receipt;
    }
    if (receiverName) update.mpesa_receiver_name = receiverName;
    if (newStatus === 'paid') {
      update.payment_date = new Date().toISOString().slice(0, 10);
    }

    // Match by conversation ID (Daraja usually sends this)
    if (conversationId) {
      await serviceClient
        .from('payments')
        .update(update)
        .eq('mpesa_conversation_id', conversationId);
    } else if (originatorId) {
      await serviceClient
        .from('payments')
        .update(update)
        .eq('mpesa_originator_conversation_id', originatorId);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Callback error:', e.message);
    // Always 200 — Safaricom retries on non-2xx
    res.status(200).json({ ok: false });
  }
});

// Health check
app.get('/', (_req, res) => res.json({ ok: true, service: 'fieldlink-mpesa' }));

// ---- Start ----
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`FieldLink-Mpesa listening on http://localhost:${port}`);
  console.log(`Callback URL: ${process.env.PUBLIC_BASE_URL}/api/b2c/callback`);
});
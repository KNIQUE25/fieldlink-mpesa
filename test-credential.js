// Standalone credential test. Run: node test-credential.js
require('dotenv').config();
const axios = require('axios');

const DARAJA = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

(async () => {
  console.log('--- FieldLink-Mpesa credential test ---');
  console.log('Daraja base:', DARAJA);
  console.log('Shortcode :', process.env.MPESA_B2C_SHORTCODE);
  console.log('Initiator :', process.env.MPESA_INITIATOR_NAME);
  console.log('Credential length:', (process.env.MPESA_SECURITY_CREDENTIAL || '').length);
  console.log('');

  // 1. OAuth
  const basic = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
  ).toString('base64');

  const auth = await axios.get(
    `${DARAJA}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${basic}` } },
  );
  console.log('✓ OAuth OK. Token length:', auth.data.access_token.length);

  // 2. B2C
  const payload = {
    InitiatorName: process.env.MPESA_INITIATOR_NAME,
    SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
    CommandID: 'BusinessPayment',
    Amount: 1,
    PartyA: process.env.MPESA_B2C_SHORTCODE,
    PartyB: '254708374149',
    Remarks: 'FieldLink credential test',
    QueueTimeOutURL: 'https://example.com/timeout',
    ResultURL: 'https://example.com/result',
    Occassion: 'Test',
  };

  const b2c = await axios.post(
    `${DARAJA}/mpesa/b2c/v1/paymentrequest`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${auth.data.access_token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  console.log('✓ B2C response:');
  console.log(JSON.stringify(b2c.data, null, 2));
  console.log('');

  if (b2c.data.ResponseCode === '0') {
    console.log('✅ Credential works. ResponseCode = 0.');
  } else {
    console.log('❌ ResponseCode =', b2c.data.ResponseCode);
    console.log('   Description:', b2c.data.ResponseDescription);
    console.log('   See the table in the docs to fix.');
  }
})().catch((e) => {
  console.error('❌ Error:', e.response?.data || e.message);
  process.exit(1);
});
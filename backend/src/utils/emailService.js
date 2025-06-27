const axios = require('axios');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function sendInvoiceEmail(to, subject, html) {
    try {
        const response = await axios.post(
            'https://api.resend.com/emails',
            {
                from: 'ERP <onboarding@resend.dev>',
                to: [to],
                subject,
                html
            },
            {
                headers: {
                    Authorization: `Bearer ${RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log(`Email sent: ${response.status}`);
        return response.data;
    } catch (error) {
        console.error('Email send error:', error.response?.data || error.message);
        throw error;
    }
}

module.exports = { sendInvoiceEmail };

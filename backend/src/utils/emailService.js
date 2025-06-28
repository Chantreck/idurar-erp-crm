const axios = require('axios');
const pRetry = require("p-retry");
const CircuitBreaker = require('opossum');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const BREAKER_OPTIONS = {
    timeout: 10000, // Если выполнение функции занимает более 10 секунд, считаем её тайм-аутом
    errorThresholdPercentage: 50, // Если 50% запросов завершаются ошибкой
    resetTimeout: 30000, // Через 30 секунд после "размыкания" Circuit Breaker переходит в "полуоткрытое" состояние
    rollingCountTimeout: 10000, // Окно для подсчета ошибок (10 секунд)
    rollingCountBuckets: 10, // Количество интервалов в окне
    name: 'ResendEmailService',
};

const breaker = new CircuitBreaker(async (to, subject, html) => {
    const sendEmailTask = async (attempt) => {
        console.log(`[EmailService] [Attempt ${attempt}] Sending email to: ${to}, Subject: "${subject}"`);
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
                    },
                    timeout: 5000 // !! Таймаут axios
                }
            );

            if (response.status >= 200 && response.status < 300) {
                console.log(`[EmailService] SUCCESS: Email sent to ${to}, Status: ${response.status}`);
                return response.data;
            } else {
                const apiError = new Error(`Resend API returned status ${response.status}: ${JSON.stringify(response.data)}`);
                apiError.isAxiosError = true;
                apiError.response = response;
                console.error(`[EmailService] API_ERROR: Failed to send email to ${to}. Status: ${response.status}, Details: ${JSON.stringify(response.data)}`);
                throw apiError;
            }
        } catch (error) {
            let errorDetails = '';
            if (axios.isAxiosError(error) && error.response) {
                errorDetails = `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
            } else if (axios.isAxiosError(error) && error.code) {
                errorDetails = `Code: ${error.code}, Message: ${error.message}`;
            } else {
                errorDetails = `Message: ${error.message}`;
            }
            console.error(`[EmailService] REQUEST_FAILED: Attempt ${attempt} failed for ${to}. Error: ${errorDetails}`);
            throw error;
        }
    }

    const RETRY_OPTIONS = {
        retries: 10,
        minTimeout: 1000,
        factor: 2,
        maxTimeout: 10000,
        onFailedAttempt: error => {
            console.warn(`[EmailService] RETRY: Attempt ${error.attemptNumber} of ${error.retriesLeft + error.attemptNumber} failed. Retrying for: ${error.message}`);
        },
        shouldRetry: error => {
            if (axios.isAxiosError(error) && error.response) {
                const statusCode = error.response.status;
                if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
                    console.error(`[EmailService] NON_RETRYABLE: HTTP ${statusCode} for ${error.response.config.url}. Not retrying.`);
                    return false;  //! Не повторяем клиентские ошибки
                }
            }
            return true;
        }
    };

    return pRetry(sendEmailTask, RETRY_OPTIONS);
}, BREAKER_OPTIONS);

// Обработчики событий Circuit Breaker
breaker.on('open', () => console.warn('[CircuitBreaker] OPEN: Resend email service is now unavailable.'));
breaker.on('halfOpen', () => console.log('[CircuitBreaker] HALF_OPEN: Testing Resend email service...'));
breaker.on('close', () => console.log('[CircuitBreaker] CLOSE: Resend email service is now available.'));
breaker.on('fallback', (err) => console.error(`[CircuitBreaker] FALLBACK: Circuit Breaker triggered fallback. Error: ${err.message}`));

async function sendInvoiceEmail(to, subject, html) {
    try {
        const result = await breaker.fire(to, subject, html);
        console.log(`[EmailService] FINAL_STATUS: Email process finished for ${to}. Result: SUCCESS`);
        return result;
    } catch (error) {
        console.error(`[EmailService] FINAL_STATUS: Email process failed for ${to}. Error: ${error.message}`);
        throw error;
    }
}

module.exports = {sendInvoiceEmail};

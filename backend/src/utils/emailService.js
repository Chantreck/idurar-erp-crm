const axios = require('axios');
const pRetry = require("p-retry");
const CircuitBreaker = require('opossum');
const client = require('prom-client');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const BREAKER_OPTIONS = {
    timeout: 10000, // Если выполнение функции занимает более 10 секунд, считаем её тайм-аутом
    errorThresholdPercentage: 50, // Если 50% запросов завершаются ошибкой
    resetTimeout: 30000, // Через 30 секунд после "размыкания" Circuit Breaker переходит в "полуоткрытое" состояние
    rollingCountTimeout: 10000, // Окно для подсчета ошибок (10 секунд)
    rollingCountBuckets: 10, // Количество интервалов в окне
    name: 'ResendEmailService',
};

//region Metrics

const register = new client.Registry();
client.collectDefaultMetrics({register});

const emailSendSuccessCounter = new client.Counter({
    name: 'email_send_success_total',
    help: 'Total number of successfully sent emails',
    labelNames: ['to_domain', 'subject_prefix'],
});
register.registerMetric(emailSendSuccessCounter);

const emailSendFailureCounter = new client.Counter({
    name: 'email_send_failure_total',
    help: 'Total number of failed email sends',
    labelNames: ['error_type', 'status_code', 'to_domain'],
});
register.registerMetric(emailSendFailureCounter);

const resendResponseTimeHistogram = new client.Histogram({
    name: 'resend_api_response_time_seconds',
    help: 'Response time of Resend API in seconds',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
register.registerMetric(resendResponseTimeHistogram);

const circuitBreakerStateGauge = new client.Gauge({
    name: 'email_circuit_breaker_state',
    help: 'Current state of the email sending circuit breaker (0=closed, 1=half-open, 2=open)',
    labelNames: ['breaker_name'],
});
register.registerMetric(circuitBreakerStateGauge);

circuitBreakerStateGauge.set({breaker_name: BREAKER_OPTIONS.name}, 0); // 0 = Closed

//endregion

const breaker = new CircuitBreaker(async (to, subject, html) => {
    const endTimer = resendResponseTimeHistogram.startTimer();

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
                endTimer();

                //! Метрика
                const toDomain = to.split('@')[1] || 'unknown';
                const subjectPrefix = subject.substring(0, 20);
                emailSendSuccessCounter.inc({to_domain: toDomain, subject_prefix: subjectPrefix});

                return response.data;
            } else {
                const apiError = new Error(`Resend API returned status ${response.status}: ${JSON.stringify(response.data)}`);
                apiError.isAxiosError = true;
                apiError.response = response;
                console.error(`[EmailService] API_ERROR: Failed to send email to ${to}. Status: ${response.status}, Details: ${JSON.stringify(response.data)}`);

                //! Метрика
                endTimer(); // Остановка таймера даже при ошибке
                const toDomain = to.split('@')[1] || 'unknown';
                emailSendFailureCounter.inc({
                    error_type: 'resend_api_error',
                    status_code: response.status,
                    to_domain: toDomain
                });

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

            //! Метрика
            endTimer(); // Остановка таймера даже при сетевой ошибке
            const toDomain = to.split('@')[1] || 'unknown';
            let errorType = 'network_error';
            let statusCode = 'N/A';
            if (axios.isAxiosError(error) && error.response) {
                errorType = 'resend_api_error';
                statusCode = error.response.status;
            } else if (axios.isAxiosError(error) && error.code) {
                errorType = `axios_code_${error.code}`;
            }
            emailSendFailureCounter.inc({error_type: errorType, status_code: statusCode, to_domain: toDomain});

            throw error;
        }
    }

    const RETRY_OPTIONS = {
        retries: 5,
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
breaker.on('open', () => {
    console.warn('[CircuitBreaker] OPEN: Resend email service is now unavailable.');
    circuitBreakerStateGauge.set({breaker_name: BREAKER_OPTIONS.name}, 2);
});
breaker.on('halfOpen', () => {
    console.log('[CircuitBreaker] HALF_OPEN: Testing Resend email service...');
    circuitBreakerStateGauge.set({breaker_name: BREAKER_OPTIONS.name}, 1);
});
breaker.on('close', () => {
    console.log('[CircuitBreaker] CLOSE: Resend email service is now available.');
    circuitBreakerStateGauge.set({breaker_name: BREAKER_OPTIONS.name}, 0);
});
breaker.on('fallback', (err) => {
    console.error(`[CircuitBreaker] FALLBACK: Circuit Breaker triggered fallback. Error: ${err.message}`);
    emailSendFailureCounter.inc({error_type: 'circuit_breaker_fallback', status_code: 'N/A', to_domain: 'N/A'});
});

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

module.exports = {sendInvoiceEmail, register};

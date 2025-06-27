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
                console.log(`Email успешно отправлен: ${response.status}`);
                return response.data;
            } else {
                // Если Resend вернул ошибку, но не бросил исключение axios,
                // бросаем её, чтобы Circuit Breaker и p-retry могли её обработать
                const apiError = new Error(`Resend API вернул статус ${response.status}: ${JSON.stringify(response.data)}`);
                apiError.isAxiosError = true; // Добавляем флаг для isAxiosError
                apiError.response = response; // Добавляем ответ для доступа к статусу
                throw apiError;
            }
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                const statusCode = error.response.status;
                if (statusCode >= 400 && statusCode < 500) {
                    console.error(`Неповторяемая ошибка Resend API (${statusCode}):`, error.response.data);
                }
            }
            throw error;
        }
    }

    const RETRY_OPTIONS = {
        retries: 10,
        minTimeout: 1000,
        factor: 2,
        maxTimeout: 10000,
        onFailedAttempt: error => {
            console.warn(`Попытка отправки письма не удалась. Повторная попытка ${error.attemptNumber} из ${error.retriesLeft + error.attemptNumber}. Ошибка: ${error.message}`);
        },
        shouldRetry: error => {
            // Если это ошибка axios и код 4xx (кроме 429), не повторяем
            if (axios.isAxiosError(error) && error.response) {
                const statusCode = error.response.status;
                // Не повторяем для 4xx ошибок, кроме 429 (Too Many Requests - часто временная)
                if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
                    console.error(`Обнаружена неповторяемая ошибка HTTP ${statusCode}. Не будет повторной попытки.`);
                    return false; // Не повторять
                }
            }
            // Повторяем для всех остальных ошибок (сетевые, 5xx, тайм-ауты и т.д.)
            return true;
        }
    };

    return pRetry(sendEmailTask, RETRY_OPTIONS);
}, BREAKER_OPTIONS);

// Обработчики событий Circuit Breaker (для логирования)
breaker.on('open', () => console.warn('Circuit Breaker для Resend открыт! Отправка писем временно приостановлена.'));
breaker.on('halfOpen', () => console.log('Circuit Breaker для Resend полуоткрыт. Пробная попытка...'));
breaker.on('close', () => console.log('Circuit Breaker для Resend закрыт. Отправка писем возобновлена.'));
breaker.on('fallback', (err) => console.error('Circuit Breaker сработал на fallback:', err.message));

async function sendInvoiceEmail(to, subject, html) {
    try {
        return await breaker.fire(to, subject, html);
    } catch (error) {
        // Здесь мы ловим окончательную ошибку, которая произошла после всех ретраев
        // или если Circuit Breaker был открыт.
        // Если ошибка 403, она дойдет сюда напрямую без повторных попыток.
        console.error('Окончательная ошибка при отправке письма (через Circuit Breaker):', error.message);
        throw error;
    }
}

module.exports = {sendInvoiceEmail};

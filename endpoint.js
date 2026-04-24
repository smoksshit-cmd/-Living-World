// ============================================================
//  Living World — Модуль отдельного AI эндпоинта
//  Все запросы для НПС идут через этот модуль,
//  НЕ трогая основной эндпоинт таверны
// ============================================================

/**
 * Делает запрос к кастомному эндпоинту (или дефолтному OpenAI-совместимому)
 */
export async function callCustomEndpoint(settings, prompt, systemPrompt = '') {
    const url    = settings.customEndpointUrl.replace(/\/$/, '') + '/chat/completions';
    const apiKey = settings.customApiKey;
    const model  = settings.customModel || 'gpt-3.5-turbo';

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens:  400,
            temperature: 0.9,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Endpoint error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * Получает список моделей с эндпоинта
 */
export async function fetchModelsFromEndpoint(endpointUrl, apiKey) {
    const url = endpointUrl.replace(/\/$/, '') + '/models';
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) throw new Error(`Не удалось получить модели: ${response.status}`);

    const data = await response.json();
    // Поддержка OpenAI-формата и простого массива
    if (Array.isArray(data)) return data.map(m => typeof m === 'string' ? m : m.id);
    if (data.data)           return data.data.map(m => m.id);
    return [];
}

/**
 * Проверяет соединение с эндпоинтом
 */
export async function testEndpointConnection(endpointUrl, apiKey, model) {
    const url = endpointUrl.replace(/\/$/, '') + '/chat/completions';
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: model || 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`${response.status}: ${err}`);
    }
    return true;
}

/**
 * Роутер: если кастомный эндпоинт включён — использует его,
 * иначе делает запрос через SillyTavern generateRaw
 */
export async function generateNpcText(settings, prompt, generateRawFn) {
    if (settings.useCustomEndpoint && settings.customEndpointUrl && settings.customApiKey) {
        return await callCustomEndpoint(settings, prompt);
    }

    // Фолбэк на основной эндпоинт таверны
    if (typeof generateRawFn === 'function') {
        return await generateRawFn(prompt, {
            max_new_tokens: 400,
            temperature:    0.9,
        });
    }

    throw new Error('Нет доступного AI эндпоинта');
}

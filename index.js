// index.js — Living World (NPC & Context Names)
// Исправленные пути для SillyTavern
import { 
    getContext, 
    extension_settings, 
    saveSettingsDebounced, 
    renderExtensionTemplateAsync 
} from '../../../extensions.js';

import { 
    generateQuietPrompt, 
    printMessages 
} from '../../../script.js';

const EXT_NAME = 'living-world';

// Стандартные настройки
const defaultSettings = {
    enabled: true,
    encounter_chance: 30,
    encounter_interval: 5,
    name_mode: 'context',
    gender_default: 'random',
    alt_api_enabled: false,
    alt_api_url: 'https://api.openrouter.ai/v1/chat/completions',
    alt_api_key: '',
    alt_api_model: 'openai/gpt-3.5-turbo',
    _message_counter: 0,
    _last_chat_len: 0,
    _npc_registry: [],
};

// Банк имен (упрощенный для стабильности)
const NAME_BANKS = {
    russian: {
        male: ['Алексей', 'Дмитрий', 'Артем', 'Николай', 'Михаил'],
        female: ['Анна', 'Мария', 'Елена', 'Дарья', 'Ольга']
    },
    english: {
        male: ['Arthur', 'James', 'Edward', 'Robert'],
        female: ['Emma', 'Alice', 'Sarah', 'Olivia']
    }
};

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = Object.assign({}, defaultSettings);
    }
    return extension_settings[EXT_NAME];
}

/**
 * Отправка сообщения в чат от имени системы
 */
async function injectToChat(text) {
    const ctx = getContext();
    if (!ctx.chat) return;

    ctx.chat.push({
        name: 'Мир',
        is_system: true,
        is_user: false,
        mes: `*${text}*`,
        extra: { living_world: true },
    });
    
    await ctx.saveChat();
    await printMessages();
}

/**
 * Генерация события с NPC
 */
async function triggerEncounter() {
    const settings = getSettings();
    const ctx = getContext();
    
    const gender = settings.gender_default === 'random' 
        ? (Math.random() > 0.5 ? 'male' : 'female') 
        : settings.gender_default;
    
    // Выбираем случайное имя из банка
    const lang = (ctx.chat && ctx.chat.length > 0 && /[а-яё]/i.test(ctx.chat[ctx.chat.length-1].mes)) ? 'russian' : 'english';
    const name = NAME_BANKS[lang][gender][Math.floor(Math.random() * NAME_BANKS[lang][gender].length)];

    const prompt = `Кратко (1-2 предложения) опиши появление случайного персонажа по имени ${name}. Он просто проходит мимо или занимается своим делом. Не обращайся к игроку напрямую.`;

    try {
        let description = "";
        if (settings.alt_api_enabled && settings.alt_api_key) {
            // Логика для внешнего API
            const response = await fetch(settings.alt_api_url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.alt_api_key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: settings.alt_api_model,
                    messages: [{ role: 'user', content: prompt }]
                })
            });
            const data = await response.json();
            description = data.choices[0].message.content;
        } else {
            // Логика через встроенный генератор SillyTavern
            description = await generateQuietPrompt(prompt, false);
        }

        if (description) {
            await injectToChat(description.trim());
        }
    } catch (err) {
        console.error('[Living World] Ошибка генерации:', err);
    }
}

/**
 * Инициализация
 */
(async function init() {
    console.log('[Living World] Запуск инициализации...');

    try {
        // Попытка загрузить UI (файл settings.html должен быть в той же папке)
        await renderExtensionTemplateAsync(EXT_NAME, 'settings.html');
    } catch (e) {
        console.warn('[Living World] Настройки (settings.html) не найдены, работаем без UI');
    }

    // Слушатель сообщений
    setInterval(async () => {
        const ctx = getContext();
        const settings = getSettings();

        if (ctx.chat && ctx.chat.length !== settings._last_chat_len) {
            settings._last_chat_len = ctx.chat.length;
            
            // Проверка шанса появления
            if (Math.random() * 100 < settings.encounter_chance) {
                console.log('[Living World] Событие сработало!');
                await triggerEncounter();
            }
            saveSettingsDebounced();
        }
    }, 2000);

    console.log('[Living World] Расширение успешно загружено');
})();

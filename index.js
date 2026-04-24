// index.js — Living World (NPC + Context Names)
import { getContext, extension_settings, saveSettingsDebounced, renderExtensionTemplateAsync } from '../extensions.js';
import { generateQuietPrompt, printMessages } from '../script.js';

const EXT_NAME = 'living-world';

// Дефолтные настройки
const defaultSettings = {
    enabled: true,
    encounter_enabled: true,
    encounter_trigger_messages: true,
    encounter_trigger_movement: true,
    encounter_interval: 5,
    encounter_chance: 30,
    name_mode: 'context',
    name_russian: true,
    name_english: true,
    gender_default: 'random',
    alt_api_enabled: false,
    alt_api_url: 'https://api.openrouter.ai/v1/chat/completions',
    alt_api_key: '',
    alt_api_model: '',
    alt_api_temperature: 0.9,
    alt_api_use_for_names: false,
    _message_counter: 0,
    _npc_registry: [],
    _last_chat_len: 0,
    _models_cache: [],
};

const NAME_BANKS = {
    russian: {
        male: ['Алексей','Дмитрий','Иван','Михаил','Николай','Сергей','Павел','Владимир'],
        female: ['Анастасия','Екатерина','Мария','Ольга','Наталья','Анна','Елена','Татьяна'],
    },
    english: {
        male: ['Arthur','Henry','William','George','Robert','James','Edward','Alexander'],
        female: ['Eleanor','Margaret','Catherine','Elizabeth','Charlotte','Mary','Alice','Sarah'],
    }
};

const MOVEMENT_WORDS = ['иду','выхожу','захожу','направляюсь','walk','enter','leave','approach'];

function getSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = JSON.parse(JSON.stringify(defaultSettings));
    return extension_settings[EXT_NAME];
}

// Поиск имен через Alt API
async function altApiChatCompletion({ url, apiKey, model, temperature, messages }) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = JSON.stringify({ model, temperature, messages, max_tokens: 150 });
    const resp = await fetch(url, { method: 'POST', headers, body });
    
    if (!resp.ok) throw new Error(`API Error: ${resp.status}`);
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim();
}

// Основная логика генерации NPC
async function generateNPCEncounter() {
    const settings = getSettings();
    const ctx = getContext();
    if (!ctx.chat) return;

    const recent = ctx.chat.slice(-5).map(m => m.mes).join(' ');
    const gender = settings.gender_default === 'random' ? (Math.random() > 0.5 ? 'male' : 'female') : settings.gender_default;
    
    // Выбор имени (упрощено для примера)
    const nameList = NAME_BANKS.russian[gender];
    const name = nameList[Math.floor(Math.random() * nameList.length)];

    const prompt = `Опиши появление NPC: ${name} (${gender}). Контекст: ${recent.slice(0, 300)}. Пиши 2 предложения.`;

    try {
        let description = "";
        if (settings.alt_api_enabled && settings.alt_api_key) {
            description = await altApiChatCompletion({
                url: settings.alt_api_url,
                apiKey: settings.alt_api_key,
                model: settings.alt_api_model,
                messages: [{ role: 'user', content: prompt }]
            });
        } else {
            description = await generateQuietPrompt(prompt);
        }

        if (description) {
            await injectMessageIntoChat(description, name);
        }
    } catch (e) {
        console.error('[Living World] Ошибка генерации:', e);
    }
}

async function injectMessageIntoChat(text, npcName) {
    const ctx = getContext();
    ctx.chat.push({
        name: 'Мир',
        is_system: true,
        mes: `*${text}*`,
        extra: { living_world: true }
    });
    await ctx.saveChat();
    await printMessages();
}

// Инициализация
(async function init() {
    try {
        // Убедись, что settings.html лежит в той же папке
        await renderExtensionTemplateAsync(EXT_NAME, 'settings.html');
        console.log('[Living World] UI загружен');
    } catch (e) {
        console.warn('[Living World] Ошибка загрузки UI:', e);
    }
    
    // Следим за новыми сообщениями
    setInterval(async () => {
        const ctx = getContext();
        const settings = getSettings();
        if (ctx.chat && ctx.chat.length !== settings._last_chat_len) {
            settings._last_chat_len = ctx.chat.length;
            if (Math.random() * 100 < settings.encounter_chance) {
                await generateNPCEncounter();
            }
        }
    }, 3000);
})();

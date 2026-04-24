// index.js — Living World (контекстный рандом имён + внешний API для энкаунтеров)
// Работает без правок settings.html, но умеет читать доп. поля, если они есть.
//
// Требуемые пути зависят от версии ST. В актуальных билдах эти импорты валидны.
import { getContext, extension_settings, saveSettingsDebounced, renderExtensionTemplateAsync } from '../../../extensions.js';
import { generateQuietPrompt, printMessages } from '../../../script.js';

const EXT_NAME = 'living-world';

// ====== SETTINGS (c дефолтами) ======
const defaultSettings = {
    enabled: true,

    // Encounters
    encounter_enabled: true,
    encounter_trigger_messages: true,
    encounter_trigger_movement: true,
    encounter_interval: 5,
    encounter_chance: 30,

    // Name generation
    // name_mode: 'context' — попытка определить культуру имени по контексту (кириллица -> RU, латиница -> EN)
    // name_mode: 'checkbox' — использовать отмеченные чекбоксы
    name_mode: 'context',
    name_russian: true,
    name_english: true,
    name_japanese: false,
    name_fantasy: false,
    gender_default: 'random', // random | male | female | more_male | more_female

    // Alt API (OpenAI-compatible) для генерации NPC/имён — чтобы не есть токены основного
    alt_api_enabled: false,
    alt_api_url: 'https://api.openrouter.ai/v1/chat/completions', // или свой совместимый endpoint
    alt_api_key: '',
    alt_api_model: 'openrouter/auto',
    alt_api_temperature: 0.9,
    alt_api_use_for_names: false, // true => имя тоже просим у внешнего API, иначе — локальный банк

    // Служебное
    _message_counter: 0,
    _npc_registry: [],
    _last_chat_len: 0,
};

// ====== БАНКИ ИМЁН (локальные, для фоллбека и оффлайн режима) ======
const NAME_BANKS = {
    russian: {
        male: ['Алексей','Дмитрий','Иван','Михаил','Николай','Сергей','Павел','Владимир','Григорий','Егор','Руслан','Олег','Кирилл','Артём','Александр','Тимофей'],
        female: ['Анастасия','Екатерина','Мария','Ольга','Наталья','Анна','Елена','Татьяна','Виктория','Дарья','Полина','София','Юлия','Алиса','Вероника','Ксения'],
    },
    english: {
        male: ['Arthur','Henry','William','George','Robert','James','Edward','Alexander','Victor','Julian','Michael','Andrew','Thomas','Charles','Daniel','Samuel'],
        female: ['Eleanor','Margaret','Catherine','Elizabeth','Charlotte','Mary','Alice','Sarah','Emily','Victoria','Julia','Olivia','Emma','Sophia','Grace','Amelia'],
    },
    japanese: {
        male: ['Kenji','Hiroshi','Takeshi','Ryu','Makoto','Satoshi','Daichi','Haruto','Yuta','Kaito','Ren','Takumi'],
        female: ['Yuki','Hana','Sakura','Aoi','Rin','Mei','Sora','Emi','Kaori','Miyu','Asuka','Nao'],
    },
    fantasy: {
        male: ['Aldric','Thorn','Caelum','Voss','Mordecai','Zephyr','Gareth','Eldan','Theron','Kael'],
        female: ['Lyria','Nyx','Ellara','Vashti','Isolde','Elara','Zara','Seraphine','Maera','Sylph'],
    },
};

// ====== ТРИГГЕР-СЛОВА ДВИЖЕНИЯ ======
const MOVEMENT_WORDS = [
    'иду','выхожу','захожу','направляюсь','отправляюсь','прихожу','подхожу','приближаюсь',
    'walk','enter','leave','head to','arrive','approach','go to','step in','step out'
];

function getSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = structuredClone(defaultSettings);
    // Подстрахуем версии без новых ключей
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extension_settings[EXT_NAME], k)) {
            extension_settings[EXT_NAME][k] = defaultSettings[k];
        }
    }
    return extension_settings[EXT_NAME];
}

// ====== УТИЛИТЫ ======
function roll(pct) { return Math.random() * 100 < pct; }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)] || null; }

// Простейшее определение "культура контекста": кириллица vs латиница
function detectLocaleByContextText(text) {
    const cyr = (text.match(/[а-яё]/gi) || []).length;
    const lat = (text.match(/[a-z]/gi) || []).length;
    if (cyr === 0 && lat === 0) return 'english';
    if (cyr >= lat * 1.2) return 'russian';
    if (lat >= cyr * 1.2) return 'english';
    // Нечётко — вернём обе
    return 'mixed';
}

function genderFromSetting(genderSetting) {
    if (genderSetting === 'male' || genderSetting === 'female') return genderSetting;
    if (genderSetting === 'more_male') return roll(70) ? 'male' : 'female';
    if (genderSetting === 'more_female') return roll(70) ? 'female' : 'male';
    // random
    return roll(50) ? 'male' : 'female';
}

// ====== ALT API (OpenAI-compatible chat/completions) ======
async function altApiChatCompletion({ url, apiKey, model, temperature, messages, max_tokens = 300 }) {
    const headers = {
        'Content-Type': 'application/json',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = {
        model,
        temperature,
        max_tokens,
        messages,
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Alt API error: ${resp.status} ${resp.statusText} ${text ? '- ' + text : ''}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Alt API: empty content');
    return content.trim();
}

// ====== ИМЕНА: ПО КОНТЕКСТУ ИЛИ ЧЕКБОКСАМ ======
async function getNPCName({ contextText, gender, settings }) {
    // 1) Если включён внешний API для имён — попробуем взять имя оттуда
    if (settings.alt_api_enabled && settings.alt_api_use_for_names && settings.alt_api_key) {
        try {
            const sys = 'Ты помощник, который подбирает реалистичные имена для NPC в ролевой сцене. Отвечай только именем, без дополнительных слов.';
            // Подсказываем предпочтительный "культурный" стиль имён по контексту или чекбоксам
            let hint = '';
            if (settings.name_mode === 'context') {
                const locale = detectLocaleByContextText(contextText || '');
                if (locale === 'russian') hint = 'Подбери имя, типичное для русскоязычной среды.';
                else if (locale === 'english') hint = 'Pick a name suitable for an English-speaking setting.';
                else hint = 'If the context seems Slavic use a Russian name, otherwise use a common English name.';
            } else {
                const prefs = [];
                if (settings.name_russian) prefs.push('Russian');
                if (settings.name_english) prefs.push('English');
                if (settings.name_japanese) prefs.push('Japanese');
                if (settings.name_fantasy) prefs.push('Fantasy');
                hint = `Prefer these styles: ${prefs.join(', ')}.`;
            }

            const genderHint = gender === 'male' ? 'мужское' : 'женское';
            const prompt = `Сцена: ${contextText?.slice(0, 400) || ''}\nТребуется ${genderHint} имя для NPC. ${hint}\nОтветь одним именем без пояснений.`;

            const name = await altApiChatCompletion({
                url: settings.alt_api_url,
                apiKey: settings.alt_api_key,
                model: settings.alt_api_model,
                temperature: 0.7,
                max_tokens: 10,
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: prompt },
                ],
            });

            // Санитизация — выдрать первое слово/имя
            const sanitized = String(name).split(/[\s,./;:!?\-]/).filter(Boolean)[0];
            if (sanitized && sanitized.length <= 32) return sanitized;
        } catch (e) {
            console.warn('Alt API name generation failed, fallback to local bank:', e);
        }
    }

    // 2) Локальный выбор: по контексту
    let pools = [];
    if (settings.name_mode === 'context') {
        const locale = detectLocaleByContextText(contextText || '');
        if (locale === 'russian') pools = [NAME_BANKS.russian];
        else if (locale === 'english') pools = [NAME_BANKS.english];
        else pools = [NAME_BANKS.russian, NAME_BANKS.english]; // mixed
    } else {
        // 3) Локальный выбор: по галочкам
        if (settings.name_russian) pools.push(NAME_BANKS.russian);
        if (settings.name_english) pools.push(NAME_BANKS.english);
        if (settings.name_japanese) pools.push(NAME_BANKS.japanese);
        if (settings.name_fantasy) pools.push(NAME_BANKS.fantasy);
        if (pools.length === 0) pools.push(NAME_BANKS.english);
    }

    const bank = pickRandom(pools);
    const list = bank?.[gender] || [];
    return pickRandom(list) || (gender === 'male' ? 'Alex' : 'Anna');
}

// ====== ГЕНЕРАЦИЯ СЛУЧАЙНОГО НПС ======
async function generateNPCEncounter() {
    const settings = getSettings();
    const ctx = getContext();

    // Берем немного контекста сцены (последние 6 сообщений)
    const recent = (ctx.chat || []).slice(-6).map(m => m.mes).join(' ') || '';
    const gender = genderFromSetting(settings.gender_default);
    const name = await getNPCName({ contextText: recent, gender, settings });
    const genderRU = gender === 'male' ? 'мужчина' : 'женщина';

    const sys = 'Ты краткий нарратор ролевой сцены. Стиль лаконичный, живой, без мета-комментариев.';
    const userPrompt = [
        `Опиши внезапное появление нового случайного NPC.`,
        `Имя: ${name}, Пол: ${genderRU}.`,
        `NPC не связан с игроком напрямую — он тут по своим делам (прохожий, торговец, курьер, мелкий вор, стражник, гонец и т.п.).`,
        `Контекст сцены: "${recent.slice(0, 500)}"`,
        `Дай 2-3 предложения: 1) внешность/атмосфера; 2) действие/причина появления.`,
        `Пиши от третьего лица, на том же языке, на котором идёт сцена.`,
    ].join('\n');

    let description = '';
    try {
        if (settings.alt_api_enabled && settings.alt_api_key) {
            description = await altApiChatCompletion({
                url: settings.alt_api_url,
                apiKey: settings.alt_api_key,
                model: settings.alt_api_model,
                temperature: settings.alt_api_temperature,
                max_tokens: 180,
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: userPrompt },
                ],
            });
        } else {
            // Фоллбек на основной провайдер ST (тратит токены основного подключения)
            description = await generateQuietPrompt(`${sys}\n\n${userPrompt}`, false, false);
        }
    } catch (e) {
        console.error('NPC generation failed:', e);
        return null;
    }

    const npc = { id: Date.now(), name, gender, description: (description || '').trim() };
    settings._npc_registry.push(npc);
    if (settings._npc_registry.length > 50) settings._npc_registry.shift();
    saveSettingsDebounced();

    // Инъекция в чат как мировое событие
    await injectMessageIntoChat(`Мировое событие: появляется ${name}. ${npc.description}`, 'Мир');
    renderNpcRegistry(); // обновим список в настройках, если открыт

    return npc;
}

async function injectMessageIntoChat(text, senderName = 'Мир') {
    const ctx = getContext();
    ctx.chat.push({
        name: senderName,
        is_system: true,
        is_user: false,
        mes: `*${text}*`,
        extra: { living_world: true },
    });
    await ctx.saveChat();
    await printMessages();
}

// ====== ENCOUNTER ТРИГГЕР ======
async function maybeTriggerEncounter(latestMessageText) {
    const settings = getSettings();
    if (!settings.enabled || !settings.encounter_enabled) return;

    let shouldCheck = false;

    if (settings.encounter_trigger_messages) {
        settings._message_counter++;
        if (settings._message_counter >= settings.encounter_interval) {
            shouldCheck = true;
            settings._message_counter = 0;
        }
    }

    if (!shouldCheck && settings.encounter_trigger_movement) {
        const s = (latestMessageText || '').toLowerCase();
        if (MOVEMENT_WORDS.some(w => s.includes(w))) {
            shouldCheck = true;
        }
    }

    if (shouldCheck && roll(settings.encounter_chance)) {
        await generateNPCEncounter();
    }
    saveSettingsDebounced();
}

// ====== WATCHER новых сообщений (без завязки на внутренние события) ======
// Наблюдаем за ростом длины чата чтобы не зависеть от внутренних event_types
let _watcherStarted = false;
function startChatWatcher() {
    if (_watcherStarted) return;
    _watcherStarted = true;

    setInterval(async () => {
        try {
            const ctx = getContext();
            const len = (ctx.chat || []).length;
            const settings = getSettings();
            if (len !== settings._last_chat_len) {
                // Поймали новое сообщение
                const lastMsg = (ctx.chat || [])[len - 1];
                settings._last_chat_len = len;
                saveSettingsDebounced();

                if (lastMsg && typeof lastMsg.mes === 'string') {
                    await maybeTriggerEncounter(lastMsg.mes);
                }
            }
        } catch (e) {
            console.warn('Living World watcher tick error:', e);
        }
    }, 1200);
}

// ====== UI BINDINGS (опционально, если в settings.html есть элементы) ======
function bindUI() {
    const byId = (id) => document.getElementById(id);

    const fields = {
        enabled: byId('lw-enabled'),

        encounter_enabled: byId('lw-encounter-enabled'),
        encounter_trigger_messages: byId('lw-trigger-messages'),
        encounter_trigger_movement: byId('lw-trigger-movement'),
        encounter_interval: byId('lw-encounter-interval'),
        encounter_chance: byId('lw-encounter-chance'),

        // Имёна
        name_mode_context: byId('lw-name-mode-context'),
        name_russian: byId('lw-name-russian'),
        name_english: byId('lw-name-english'),
        name_japanese: byId('lw-name-japanese'),
        name_fantasy: byId('lw-name-fantasy'),
        gender_default: byId('lw-gender-default'),

        // Alt API
        alt_api_enabled: byId('lw-altapi-enabled'),
        alt_api_url: byId('lw-altapi-url'),
        alt_api_key: byId('lw-altapi-key'),
        alt_api_model: byId('lw-altapi-model'),
        alt_api_temperature: byId('lw-altapi-temperature'),
        alt_api_use_for_names: byId('lw-altapi-use-for-names'),

        manual_encounter_btn: byId('lw-manual-encounter-btn'),
        clear_registry_btn: byId('lw-clear-registry'),
        npc_list: byId('lw-npc-list'),
    };

    const s = getSettings();

    function setIf(el, v) { if (el) el.type === 'checkbox' ? el.checked = !!v : el.value = v; }
    function read(el, type = 'text') {
        if (!el) return null;
        if (el.type === 'checkbox') return !!el.checked;
        if (type === 'number') return Number(el.value) || 0;
        return el.value;
    }

    // Инициализация значений
    setIf(fields.enabled, s.enabled);

    setIf(fields.encounter_enabled, s.encounter_enabled);
    setIf(fields.encounter_trigger_messages, s.encounter_trigger_messages);
    setIf(fields.encounter_trigger_movement, s.encounter_trigger_movement);
    setIf(fields.encounter_interval, s.encounter_interval);
    setIf(fields.encounter_chance, s.encounter_chance);

    if (fields.name_mode_context) fields.name_mode_context.checked = (s.name_mode === 'context');
    setIf(fields.name_russian, s.name_russian);
    setIf(fields.name_english, s.name_english);
    setIf(fields.name_japanese, s.name_japanese);
    setIf(fields.name_fantasy, s.name_fantasy);
    setIf(fields.gender_default, s.gender_default);

    setIf(fields.alt_api_enabled, s.alt_api_enabled);
    setIf(fields.alt_api_url, s.alt_api_url);
    setIf(fields.alt_api_key, s.alt_api_key);
    setIf(fields.alt_api_model, s.alt_api_model);
    setIf(fields.alt_api_temperature, s.alt_api_temperature);
    setIf(fields.alt_api_use_for_names, s.alt_api_use_for_names);

    // Сохранители
    const save = () => {
        const st = getSettings();
        if (fields.enabled) st.enabled = read(fields.enabled);

        if (fields.encounter_enabled) st.encounter_enabled = read(fields.encounter_enabled);
        if (fields.encounter_trigger_messages) st.encounter_trigger_messages = read(fields.encounter_trigger_messages);
        if (fields.encounter_trigger_movement) st.encounter_trigger_movement = read(fields.encounter_trigger_movement);
        if (fields.encounter_interval) st.encounter_interval = Math.max(1, read(fields.encounter_interval, 'number'));
        if (fields.encounter_chance) st.encounter_chance = Math.min(100, Math.max(1, read(fields.encounter_chance, 'number')));

        if (fields.name_mode_context) st.name_mode = fields.name_mode_context.checked ? 'context' : 'checkbox';
        if (fields.name_russian) st.name_russian = read(fields.name_russian);
        if (fields.name_english) st.name_english = read(fields.name_english);
        if (fields.name_japanese) st.name_japanese = read(fields.name_japanese);
        if (fields.name_fantasy) st.name_fantasy = read(fields.name_fantasy);
        if (fields.gender_default) st.gender_default = read(fields.gender_default);

        if (fields.alt_api_enabled) st.alt_api_enabled = read(fields.alt_api_enabled);
        if (fields.alt_api_url) st.alt_api_url = read(fields.alt_api_url);
        if (fields.alt_api_key) st.alt_api_key = read(fields.alt_api_key);
        if (fields.alt_api_model) st.alt_api_model = read(fields.alt_api_model);
        if (fields.alt_api_temperature) st.alt_api_temperature = Number(read(fields.alt_api_temperature, 'number')) || 0.9;
        if (fields.alt_api_use_for_names) st.alt_api_use_for_names = read(fields.alt_api_use_for_names);

        saveSettingsDebounced();
    };

    for (const el of Object.values(fields)) {
        if (!el) continue;
        el.addEventListener('change', save);
        el.addEventListener('input', save);
    }

    if (fields.manual_encounter_btn) {
        fields.manual_encounter_btn.addEventListener('click', async () => {
            await generateNPCEncounter();
        });
    }

    if (fields.clear_registry_btn) {
        fields.clear_registry_btn.addEventListener('click', () => {
            const st = getSettings();
            st._npc_registry = [];
            saveSettingsDebounced();
            renderNpcRegistry();
        });
    }

    renderNpcRegistry();
}

function renderNpcRegistry() {
    const list = document.getElementById('lw-npc-list');
    if (!list) return;
    const st = getSettings();
    list.innerHTML = '';
    for (const npc of (st._npc_registry || []).slice().reverse()) {
        const div = document.createElement('div');
        div.className = 'lw-npc-card';
        div.innerHTML = `<strong>${escapeHtml(npc.name)}</strong> <span class="lw-npc-type">(${npc.gender})</span><p>${escapeHtml(npc.description)}</p>`;
        list.appendChild(div);
    }
}

function escapeHtml(s) {
    return String(s || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

// ====== ИНИЦ ======
(async function init() {
    try {
        // Рендерим шаблон (если settings.html присутствует)
        await renderExtensionTemplateAsync(EXT_NAME, 'settings.html');
    } catch (e) {
        // Ок, без UI тоже работаем
        console.warn('Living World: settings UI not rendered (no settings.html?)', e);
    }

    // Привяжем UI, если есть
    try { bindUI(); } catch (e) { console.warn('Living World UI bind error:', e); }

    // Стартуем наблюдатель чата
    startChatWatcher();

    console.log('[Living World] loaded');
})();

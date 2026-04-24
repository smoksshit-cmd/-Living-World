/**
 * Living World — SillyTavern Extension
 * Всё в одном файле, без ES import/export
 */

(function () {
    'use strict';

    const EXT_NAME = 'living-world';

    // ============================================================
    //  Дефолтные настройки
    // ============================================================

    const DEFAULT_SETTINGS = {
        enabled: true,

        // Имена
        nameStyle: 'auto',     // 'auto' | 'russian' | 'foreign' | 'mixed'
        nameGender: 'mixed',   // 'male' | 'female' | 'mixed'

        // Энкаунтеры
        encounterEnabled: true,
        encounterEveryN: 5,
        encounterChance: 25,
        wPasserby: 60,
        wHook: 30,
        wImportant: 10,
        autoDetectLocation: true,
        manualLocation: '',
        saveNpcToLorebook: true,

        // Автономия
        autonomyEnabled: true,
        autonomyEveryN: 8,
        knowledgeSeparation: true,
        timelineEnabled: true,

        // Кастомный эндпоинт
        useCustomEndpoint: false,
        customEndpointUrl: '',
        customApiKey: '',
        customModel: '',
    };

    // ============================================================
    //  Пулы имён
    // ============================================================

    const NAMES = {
        russian: {
            male:   ['Алексей','Дмитрий','Иван','Михаил','Сергей','Николай','Андрей','Егор','Артём','Роман','Павел','Тимур','Глеб','Лев','Кирилл','Фёдор','Матвей','Борис','Захар','Владислав'],
            female: ['Анна','Мария','Екатерина','Ольга','Наташа','Вера','Полина','Дарья','Юлия','Ирина','Алина','Ксения','Надежда','Варвара','Злата','Мила','Лада','Зоя','Тамара','Светлана'],
        },
        foreign: {
            male:   ['Alex','Ethan','Liam','Noah','James','Oliver','Sebastian','Finn','Dorian','Caspian','Marcus','Leon','Adrian','Elias','Victor','Theo','Jasper','Cole','Reid','Archer'],
            female: ['Chloe','Emma','Aria','Luna','Isla','Nora','Elara','Vivienne','Ivy','Scarlett','Zoe','Mira','Lyra','Faye','Wren','Celeste','Hazel','Aurora','Violet','Seraphina'],
        },
    };

    function detectNameStyle(chatMessages) {
        if (!chatMessages || chatMessages.length === 0) return 'foreign';
        const recent = chatMessages.slice(-20).map(function(m) { return m.mes || ''; }).join(' ');
        const foreignRe = /\b(Alex|Chloe|Emma|Liam|Ethan|Aria|Luna|Nora|James|Oliver|Victor|Leon|Dorian|Ivy|Scarlett)\b/gi;
        const russianRe = /\b(Алексей|Дмитрий|Иван|Михаил|Анна|Мария|Екатерина|Ольга|Наташа|Полина|Дарья|Артём|Роман|Кирилл)\b/gi;
        const f = (recent.match(foreignRe) || []).length;
        const r = (recent.match(russianRe) || []).length;
        if (r > f) return 'russian';
        if (f > r) return 'foreign';
        return 'foreign';
    }

    function pickName(style, gender) {
        const pool = NAMES[style] || NAMES.foreign;
        if (gender === 'male')   return pool.male[Math.floor(Math.random() * pool.male.length)];
        if (gender === 'female') return pool.female[Math.floor(Math.random() * pool.female.length)];
        const all = pool.male.concat(pool.female);
        return all[Math.floor(Math.random() * all.length)];
    }

    function resolveName(settings, chat) {
        let style = settings.nameStyle;
        if (style === 'auto') style = detectNameStyle(chat);
        const gender = settings.nameGender === 'mixed'
            ? (Math.random() < 0.5 ? 'male' : 'female')
            : settings.nameGender;
        return { name: pickName(style, gender), gender: gender, style: style };
    }

    // ============================================================
    //  Энкаунтеры
    // ============================================================

    function rollEncounterType(s) {
        const r = Math.random() * 100;
        if (r < s.wPasserby) return 'passerby';
        if (r < s.wPasserby + s.wHook) return 'hook';
        return 'important';
    }

    function shouldTrigger(chance) {
        return Math.random() * 100 < chance;
    }

    function detectLocation(chat, settings) {
        if (!settings.autoDetectLocation) return settings.manualLocation || '';
        const recent = chat.slice(-8).map(function(m) { return m.mes || ''; }).join(' ');
        const patterns = [
            { re: /таверн[аеу]|трактир/i,         label: 'таверна' },
            { re: /рынок|базар/i,                  label: 'рынок' },
            { re: /лес|роща|чаща/i,                label: 'лес' },
            { re: /замок|дворец|тронный зал/i,     label: 'замок' },
            { re: /улиц[аеу]|переулок|площадь/i,  label: 'улица' },
            { re: /порт|пристань|корабль/i,        label: 'порт' },
            { re: /tavern|inn/i,                   label: 'tavern' },
            { re: /forest|woods/i,                 label: 'forest' },
            { re: /castle|palace/i,                label: 'castle' },
            { re: /market|bazaar/i,                label: 'market' },
            { re: /street|alley/i,                 label: 'street' },
        ];
        for (var i = 0; i < patterns.length; i++) {
            if (patterns[i].re.test(recent)) return patterns[i].label;
        }
        return settings.manualLocation || 'текущая локация';
    }

    // ============================================================
    //  Промпты
    // ============================================================

    function buildEncounterPrompt(npcName, location, type, context) {
        var typeHint = {
            passerby:  'Проходной персонаж — здесь по своим делам, не связанным с главным героем.',
            hook:      'Персонаж с зацепкой — несёт информацию, просьбу, слух или конфликт.',
            important: 'Потенциально важный персонаж — у него своя история, мотивация и тайна.',
        }[type];
        return 'Ты нарратор живого мира. Опиши появление персонажа в сцене.\n\n'
            + 'Имя НПС: ' + npcName + '\n'
            + 'Локация: ' + (location || 'текущая сцена') + '\n'
            + 'Тип: ' + typeHint + '\n\n'
            + 'Контекст:\n' + context + '\n\n'
            + 'Напиши 2-4 предложения от третьего лица. НПС приходит по СВОИМ делам. '
            + 'Не упоминай главного героя по имени напрямую. Создай интригу или атмосферу. '
            + 'Отвечай только текстом появления.';
    }

    function buildAutonomyPrompt(charName, location, context) {
        return 'Ты нарратор. Персонаж ' + charName + ' провёл время без главного героя.\n\n'
            + 'Последнее известное место: ' + (location || 'неизвестно') + '\n'
            + 'Контекст до разлуки:\n' + context + '\n\n'
            + 'Придумай 2-3 коротких события из жизни ' + charName + ' за это время. '
            + 'Он НЕ знает что делал главный герой. '
            + 'События про его собственную жизнь: дела, встречи, мысли. '
            + 'Отвечай кратко, от третьего лица.';
    }

    function buildKnowledgeInject(charName) {
        return '[ПРАВИЛО МИРА: ' + charName + ' не знает о событиях, при которых не присутствовал лично. '
            + 'Информацию об отсутствующих сценах он получает только если ему сообщили напрямую. '
            + 'Он живёт своей жизнью независимо от главного героя.]';
    }

    // ============================================================
    //  Память НПС (localStorage)
    // ============================================================

    var NPC_KEY      = 'lw_npcs';
    var TIMELINE_KEY = 'lw_timeline';

    function loadNpcs() {
        try { return JSON.parse(localStorage.getItem(NPC_KEY) || '{}'); } catch(e) { return {}; }
    }

    function saveNpc(npc) {
        var reg = loadNpcs();
        reg[npc.name] = npc;
        try { localStorage.setItem(NPC_KEY, JSON.stringify(reg)); } catch(e) {}
    }

    function saveTimelineEvent(event, chatId) {
        try {
            var all = JSON.parse(localStorage.getItem(TIMELINE_KEY) || '{}');
            if (!all[chatId]) all[chatId] = [];
            all[chatId].push({ event: event, ts: Date.now() });
            if (all[chatId].length > 20) all[chatId].shift();
            localStorage.setItem(TIMELINE_KEY, JSON.stringify(all));
        } catch(e) {}
    }

    function loadTimeline(chatId) {
        try {
            var all = JSON.parse(localStorage.getItem(TIMELINE_KEY) || '{}');
            return all[chatId] || [];
        } catch(e) { return []; }
    }

    function buildNpcInject(chatId) {
        var reg = loadNpcs();
        var npcs = Object.values(reg).filter(function(n) { return !n.chatId || n.chatId === chatId; }).slice(-5);
        if (npcs.length === 0) return '';
        var lines = npcs.map(function(n) {
            return '[НПС: ' + n.name + ' | ' + n.location + ' | ' + n.description.substring(0, 80) + '...]';
        });
        return '[ИЗВЕСТНЫЕ НПС МИРА:\n' + lines.join('\n') + ']';
    }

    function buildTimelineInject(chatId) {
        var events = loadTimeline(chatId).slice(-3);
        if (events.length === 0) return '';
        return '[ХРОНИКА МИРА:\n' + events.map(function(e) { return '• ' + e.event; }).join('\n') + ']';
    }

    // ============================================================
    //  AI запросы
    // ============================================================

    async function callCustomEndpoint(settings, prompt) {
        const url = settings.customEndpointUrl.replace(/\/$/, '') + '/chat/completions';
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': 'Bearer ' + settings.customApiKey,
            },
            body: JSON.stringify({
                model:       settings.customModel || 'gpt-3.5-turbo',
                messages:    [{ role: 'user', content: prompt }],
                max_tokens:  400,
                temperature: 0.9,
            }),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error('Endpoint ' + response.status + ': ' + err);
        }
        const data = await response.json();
        return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    }

    async function generateText(settings, prompt) {
        if (settings.useCustomEndpoint && settings.customEndpointUrl && settings.customApiKey) {
            return await callCustomEndpoint(settings, prompt);
        }
        // Фолбэк на ST generateRaw
        if (typeof window.generateRaw === 'function') {
            return await window.generateRaw(prompt, '', false, false, prompt, { max_new_tokens: 400 });
        }
        throw new Error('Нет доступного AI эндпоинта. Включи кастомный эндпоинт в настройках Living World.');
    }

    // ============================================================
    //  Получение настроек через ST context
    // ============================================================

    function getSettings() {
        if (!window.extension_settings) window.extension_settings = {};
        if (!window.extension_settings[EXT_NAME]) {
            window.extension_settings[EXT_NAME] = Object.assign({}, DEFAULT_SETTINGS);
        }
        // Заполняем недостающие ключи при обновлении
        var s = window.extension_settings[EXT_NAME];
        Object.keys(DEFAULT_SETTINGS).forEach(function(k) {
            if (s[k] === undefined) s[k] = DEFAULT_SETTINGS[k];
        });
        return s;
    }

    function saveSettings() {
        if (typeof window.saveSettingsDebounced === 'function') {
            window.saveSettingsDebounced();
        }
    }

    // ============================================================
    //  Счётчики
    // ============================================================

    var msgSinceEncounter = 0;
    var msgSinceAutonomy  = 0;

    // ============================================================
    //  Основная логика
    // ============================================================

    async function onMessageReceived() {
        const s = getSettings();
        if (!s.enabled) return;

        const context  = window.SillyTavern ? window.SillyTavern.getContext() : null;
        const chat     = (context && context.chat) || window.chat || [];
        const charName = (context && context.name2) || window.name2 || 'Персонаж';
        const chatId   = (context && context.chatId) || 'default';

        msgSinceEncounter++;
        msgSinceAutonomy++;

        // Автономные события
        if (s.autonomyEnabled && msgSinceAutonomy >= s.autonomyEveryN) {
            msgSinceAutonomy = 0;
            try {
                const ctx = chat.slice(-6).map(function(m) { return (m.name || '?') + ': ' + m.mes; }).join('\n');
                const result = await generateText(s, buildAutonomyPrompt(charName, s.manualLocation, ctx));
                if (result) saveTimelineEvent(result, chatId);
            } catch(e) {
                console.warn('[LivingWorld] Автономия:', e.message);
            }
        }

        // Случайный энкаунтер
        if (s.encounterEnabled && msgSinceEncounter >= s.encounterEveryN && shouldTrigger(s.encounterChance)) {
            msgSinceEncounter = 0;
            await doEncounter(s, chat, chatId);
        }
    }

    async function doEncounter(s, chat, chatId) {
        const context  = window.SillyTavern ? window.SillyTavern.getContext() : null;
        const charName = (context && context.name2) || window.name2 || 'Персонаж';

        const { name, gender, style } = resolveName(s, chat);
        const type     = rollEncounterType(s);
        const location = detectLocation(chat, s);
        const ctx      = chat.slice(-4).map(function(m) { return (m.name || '?') + ': ' + m.mes; }).join('\n');

        try {
            const description = await generateText(s, buildEncounterPrompt(name, location, type, ctx));
            if (!description) return;

            // Сохраняем НПС
            saveNpc({ name: name, gender: gender, style: style, type: type, location: location, description: description, chatId: chatId, ts: Date.now() });

            // Инжектим в чат
            injectNarratorMsg(description, name, type);

        } catch(e) {
            console.warn('[LivingWorld] Энкаунтер:', e.message);
            if (typeof window.toastr !== 'undefined') {
                window.toastr.error(e.message, 'Living World');
            }
        }
    }

    function injectNarratorMsg(text, npcName, type) {
        const emoji = { passerby: '👤', hook: '🔍', important: '⭐' }[type] || '👤';
        const header = emoji + ' *[Living World — ' + npcName + ']*';
        const full   = header + '\n\n' + text;

        // Попытка добавить через ST API
        const context = window.SillyTavern ? window.SillyTavern.getContext() : null;
        if (context && typeof context.addOneMessage === 'function') {
            context.addOneMessage({ name: 'Нарратор', is_user: false, is_system: true, mes: full });
            return;
        }

        // Фолбэк: показываем тостом
        if (typeof window.toastr !== 'undefined') {
            window.toastr.info(text.substring(0, 160) + '...', emoji + ' ' + npcName, { timeOut: 8000 });
        }
    }

    // ============================================================
    //  Хук на промпт — инжект разделения знаний
    // ============================================================

    function onPromptReady(event, promptData) {
        const s = getSettings();
        if (!s.enabled) return;

        const context  = window.SillyTavern ? window.SillyTavern.getContext() : null;
        const charName = (context && context.name2) || window.name2 || 'Персонаж';
        const chatId   = (context && context.chatId) || 'default';

        var injections = [];
        if (s.knowledgeSeparation) injections.push(buildKnowledgeInject(charName));
        if (s.timelineEnabled) {
            var tl = buildTimelineInject(chatId);
            if (tl) injections.push(tl);
        }
        var npcInj = buildNpcInject(chatId);
        if (npcInj) injections.push(npcInj);

        if (injections.length > 0 && promptData && promptData.systemPrompt !== undefined) {
            promptData.systemPrompt += '\n\n' + injections.join('\n\n');
        }
    }

    // ============================================================
    //  UI
    // ============================================================

    function buildSettingsHTML() {
        return `
<div id="lw_settings_panel" class="lw-panel">

    <div class="lw-header">
        <span>🌍</span>
        <b>Living World</b>
        <small>живой мир · нпс · энкаунтеры</small>
        <label class="lw-toggle">
            <input type="checkbox" id="lw_enabled" />
            <span class="lw-sw"></span>
        </label>
    </div>

    <!-- Имена -->
    <div class="lw-section">
        <div class="lw-stitle">👤 Стиль имён НПС</div>
        <div class="lw-row">
            <span class="lw-lbl">Имена:</span>
            <div class="lw-radios">
                <label><input type="radio" name="lw_namestyle" value="auto"/> 🔍 Авто</label>
                <label><input type="radio" name="lw_namestyle" value="russian"/> 🇷🇺 Русские</label>
                <label><input type="radio" name="lw_namestyle" value="foreign"/> 🌐 Иностр.</label>
                <label><input type="radio" name="lw_namestyle" value="mixed"/> 🎲 Микс</label>
            </div>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Пол:</span>
            <div class="lw-radios">
                <label><input type="radio" name="lw_gender" value="mixed"/> ⚥ Любой</label>
                <label><input type="radio" name="lw_gender" value="male"/> ♂ Мужской</label>
                <label><input type="radio" name="lw_gender" value="female"/> ♀ Женский</label>
            </div>
        </div>
    </div>

    <!-- Энкаунтеры -->
    <div class="lw-section">
        <div class="lw-stitle">🎲 Случайные энкаунтеры
            <label class="lw-toggle lw-toggle-sm"><input type="checkbox" id="lw_enc_on"/><span class="lw-sw"></span></label>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Каждые N сообщений:</span>
            <input type="number" id="lw_enc_every" class="lw-num" min="1" max="99"/>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Шанс: <b id="lw_chance_val">25</b>%</span>
            <input type="range" id="lw_enc_chance" class="lw-range" min="1" max="100"/>
        </div>
        <div class="lw-sub">
            <div class="lw-sublbl">Веса типов НПС (сумма ≈ 100):</div>
            <div class="lw-wrow"><span>👤 Проходной</span><input type="number" id="lw_w_pass" class="lw-num" min="0" max="100"/></div>
            <div class="lw-wrow"><span>🔍 С зацепкой</span><input type="number" id="lw_w_hook" class="lw-num" min="0" max="100"/></div>
            <div class="lw-wrow"><span>⭐ Важный</span><input type="number" id="lw_w_imp" class="lw-num" min="0" max="100"/></div>
        </div>
        <div class="lw-row">
            <label class="lw-chklbl"><input type="checkbox" id="lw_auto_loc"/> 🗺️ Авто-определение локации</label>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Локация вручную:</span>
            <input type="text" id="lw_manual_loc" class="lw-txt" placeholder="таверна, лес, замок…"/>
        </div>
        <div class="lw-row">
            <label class="lw-chklbl"><input type="checkbox" id="lw_save_lore"/> 📖 Сохранять НПС в Lorebook</label>
        </div>
        <button id="lw_trigger_now" class="lw-btn lw-btn-accent">⚡ Вызвать НПС прямо сейчас</button>
    </div>

    <!-- Автономия -->
    <div class="lw-section">
        <div class="lw-stitle">🧠 Автономия персонажа
            <label class="lw-toggle lw-toggle-sm"><input type="checkbox" id="lw_auto_on"/><span class="lw-sw"></span></label>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Каждые N сообщений:</span>
            <input type="number" id="lw_auto_every" class="lw-num" min="1" max="99"/>
        </div>
        <div class="lw-row">
            <label class="lw-chklbl"><input type="checkbox" id="lw_know_sep"/> 🔒 Разделение знаний</label>
        </div>
        <div class="lw-row">
            <label class="lw-chklbl"><input type="checkbox" id="lw_timeline"/> 📜 Хроника мира в промпте</label>
        </div>
    </div>

    <!-- Эндпоинт -->
    <div class="lw-section">
        <div class="lw-stitle">🔌 Отдельный AI эндпоинт
            <label class="lw-toggle lw-toggle-sm"><input type="checkbox" id="lw_ep_on"/><span class="lw-sw"></span></label>
        </div>
        <div class="lw-hint">НПС генерируются отдельно — токены основного чата не тратятся</div>
        <div id="lw_ep_panel">
            <div class="lw-row">
                <span class="lw-lbl">URL:</span>
                <input type="text" id="lw_ep_url" class="lw-txt" placeholder="https://api.openai.com/v1"/>
            </div>
            <div class="lw-row">
                <span class="lw-lbl">API ключ:</span>
                <input type="password" id="lw_ep_key" class="lw-txt" placeholder="sk-…"/>
            </div>
            <div class="lw-row">
                <span class="lw-lbl">Модель:</span>
                <select id="lw_model_sel" class="lw-sel"></select>
                <button id="lw_load_models" class="lw-btn">🔄</button>
            </div>
            <div class="lw-row">
                <button id="lw_test_conn" class="lw-btn lw-btn-outline">🔗 Тест соединения</button>
            </div>
        </div>
    </div>

</div>`;
    }

    function bindUI() {
        const s = getSettings();

        $('#lw_enabled').prop('checked', s.enabled).on('change', function() { getSettings().enabled = this.checked; saveSettings(); });

        $('input[name="lw_namestyle"][value="' + s.nameStyle + '"]').prop('checked', true);
        $('input[name="lw_namestyle"]').on('change', function() { getSettings().nameStyle = this.value; saveSettings(); });

        $('input[name="lw_gender"][value="' + s.nameGender + '"]').prop('checked', true);
        $('input[name="lw_gender"]').on('change', function() { getSettings().nameGender = this.value; saveSettings(); });

        $('#lw_enc_on').prop('checked', s.encounterEnabled).on('change', function() { getSettings().encounterEnabled = this.checked; saveSettings(); });
        $('#lw_enc_every').val(s.encounterEveryN).on('input', function() { getSettings().encounterEveryN = parseInt(this.value)||5; saveSettings(); });
        $('#lw_enc_chance').val(s.encounterChance).on('input', function() { getSettings().encounterChance = parseInt(this.value)||25; $('#lw_chance_val').text(this.value); saveSettings(); });
        $('#lw_chance_val').text(s.encounterChance);

        $('#lw_w_pass').val(s.wPasserby).on('input', function() { getSettings().wPasserby = parseInt(this.value)||60; saveSettings(); });
        $('#lw_w_hook').val(s.wHook).on('input', function() { getSettings().wHook = parseInt(this.value)||30; saveSettings(); });
        $('#lw_w_imp').val(s.wImportant).on('input', function() { getSettings().wImportant = parseInt(this.value)||10; saveSettings(); });

        $('#lw_auto_loc').prop('checked', s.autoDetectLocation).on('change', function() { getSettings().autoDetectLocation = this.checked; saveSettings(); });
        $('#lw_manual_loc').val(s.manualLocation).on('input', function() { getSettings().manualLocation = this.value; saveSettings(); });
        $('#lw_save_lore').prop('checked', s.saveNpcToLorebook).on('change', function() { getSettings().saveNpcToLorebook = this.checked; saveSettings(); });

        $('#lw_auto_on').prop('checked', s.autonomyEnabled).on('change', function() { getSettings().autonomyEnabled = this.checked; saveSettings(); });
        $('#lw_auto_every').val(s.autonomyEveryN).on('input', function() { getSettings().autonomyEveryN = parseInt(this.value)||8; saveSettings(); });
        $('#lw_know_sep').prop('checked', s.knowledgeSeparation).on('change', function() { getSettings().knowledgeSeparation = this.checked; saveSettings(); });
        $('#lw_timeline').prop('checked', s.timelineEnabled).on('change', function() { getSettings().timelineEnabled = this.checked; saveSettings(); });

        $('#lw_ep_on').prop('checked', s.useCustomEndpoint).on('change', function() {
            getSettings().useCustomEndpoint = this.checked;
            $('#lw_ep_panel').toggle(this.checked);
            saveSettings();
        });
        $('#lw_ep_panel').toggle(s.useCustomEndpoint);
        $('#lw_ep_url').val(s.customEndpointUrl).on('input', function() { getSettings().customEndpointUrl = this.value; saveSettings(); });
        $('#lw_ep_key').val(s.customApiKey).on('input', function() { getSettings().customApiKey = this.value; saveSettings(); });

        // Загрузка моделей
        $('#lw_load_models').on('click', async function() {
            const cfg = getSettings();
            const btn = $(this).text('…').prop('disabled', true);
            try {
                const url = cfg.customEndpointUrl.replace(/\/$/, '') + '/models';
                const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + cfg.customApiKey } });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const data = await r.json();
                const models = data.data ? data.data.map(function(m) { return m.id; }) : (Array.isArray(data) ? data : []);
                const sel = $('#lw_model_sel').empty();
                models.forEach(function(m) { sel.append('<option value="' + m + '">' + m + '</option>'); });
                if (cfg.customModel) sel.val(cfg.customModel);
                sel.on('change', function() { getSettings().customModel = this.value; saveSettings(); });
                btn.text('✓ (' + models.length + ')');
            } catch(e) {
                btn.text('✗');
                window.toastr && window.toastr.error(e.message, 'Living World');
            }
            btn.prop('disabled', false);
        });

        // Тест соединения
        $('#lw_test_conn').on('click', async function() {
            const cfg = getSettings();
            const btn = $(this).text('Проверка…').prop('disabled', true);
            try {
                const url = cfg.customEndpointUrl.replace(/\/$/, '') + '/chat/completions';
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.customApiKey },
                    body: JSON.stringify({ model: cfg.customModel || 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
                });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                btn.text('✓ Подключено!');
                window.toastr && window.toastr.success('Эндпоинт работает!', 'Living World');
            } catch(e) {
                btn.text('✗ Ошибка');
                window.toastr && window.toastr.error(e.message, 'Living World');
            }
            setTimeout(function() { btn.text('🔗 Тест соединения').prop('disabled', false); }, 3000);
        });

        // Ручной энкаунтер
        $('#lw_trigger_now').on('click', async function() {
            const context = window.SillyTavern ? window.SillyTavern.getContext() : null;
            const chat    = (context && context.chat) || window.chat || [];
            const chatId  = (context && context.chatId) || 'default';
            window.toastr && window.toastr.info('Генерация НПС…', 'Living World');
            await doEncounter(getSettings(), chat, chatId);
        });
    }

    // ============================================================
    //  Инициализация
    // ============================================================

    jQuery(async function() {
        // Добавляем HTML панели настроек
        const settingsContainer = document.getElementById('extensions_settings');
        if (settingsContainer) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = buildSettingsHTML();
            settingsContainer.appendChild(wrapper.firstElementChild);
            bindUI();
        }

        // Подписываемся на события ST
        if (window.eventSource && window.event_types) {
            window.eventSource.on(window.event_types.MESSAGE_RECEIVED, onMessageReceived);
            window.eventSource.on(window.event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        }

        console.log('[LivingWorld] ✓ Загружено');
    });

})();

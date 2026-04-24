/**
 * Living World — SillyTavern Extension
 * Всё в одном файле, без ES import/export
 * v2 — исправлены: триггер, метка в чате, лорбук, разделение знаний, COT
 */

(function () {
    'use strict';

    const EXT_NAME = 'living-world';

    // ============================================================
    //  Дефолтные настройки
    // ============================================================

    const DEFAULT_SETTINGS = {
        enabled: true,

        nameStyle: 'auto',
        nameGender: 'mixed',

        encounterEnabled: true,
        encounterEveryN: 5,
        encounterChance: 25,
        wPasserby: 60,
        wHook: 30,
        wImportant: 10,
        autoDetectLocation: true,
        manualLocation: '',
        saveNpcToLorebook: true,
        targetLorebook: '',       // имя лорбука для записи НПС

        autonomyEnabled: true,
        autonomyEveryN: 8,
        knowledgeSeparation: true,
        timelineEnabled: true,

        useCustomEndpoint: false,
        customEndpointUrl: '',
        customApiKey: '',
        customModel: '',

        // Внутренний флаг — ждём ли следующего триггера для ручного энкаунтера
        _pendingManualEncounter: false,
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
            + 'ВАЖНО: Отвечай ТОЛЬКО текстом появления, без каких-либо размышлений, пояснений или метакомментариев. '
            + 'Не пиши <think> блоки. Только художественный текст.';
    }

    function buildAutonomyPrompt(charName, location, context) {
        return 'Ты нарратор. Персонаж ' + charName + ' провёл время без главного героя.\n\n'
            + 'Последнее известное место: ' + (location || 'неизвестно') + '\n'
            + 'Контекст до разлуки:\n' + context + '\n\n'
            + 'Придумай 2-3 коротких события из жизни ' + charName + ' за это время. '
            + 'Он НЕ знает что делал главный герой. '
            + 'События про его собственную жизнь: дела, встречи, мысли. '
            + 'Отвечай кратко, от третьего лица. '
            + 'Никаких <think> блоков — только результат.';
    }

    // Усиленный инжект разделения знаний — запрет мета-знания и COT в ответах
    function buildKnowledgeInject(charName) {
        return '[СИСТЕМНОЕ ПРАВИЛО — ОБЯЗАТЕЛЬНО:\n'
            + charName + ' живёт независимой жизнью и НЕ обладает метазнанием.\n'
            + '• ' + charName + ' знает ТОЛЬКО то, при чём присутствовал лично или что ему сообщили напрямую.\n'
            + '• ' + charName + ' НЕ знает о событиях, произошедших в его отсутствие.\n'
            + '• ' + charName + ' НЕ знает мыслей, планов и слов главного героя, сказанных без него.\n'
            + '• Запрещено показывать размышления об НПС в формате <think> или любом другом.\n'
            + '• НПС появляются органично, без предупреждения и без метакомментариев.\n'
            + 'Нарушение этих правил разрушает иммерсию.]';
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
    //  Лорбук
    // ============================================================

    async function getAvailableLorebooks() {
        try {
            // ST API: worldInfoData — объект с именами лорбуков
            if (window.worldInfoData) {
                return Object.keys(window.worldInfoData);
            }
            // Альтернатива через context
            const context = window.SillyTavern ? window.SillyTavern.getContext() : null;
            if (context && context.worldInfo) {
                return Object.keys(context.worldInfo);
            }
            // Попытка fetch списка через ST endpoint
            const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (r.ok) {
                const data = await r.json();
                if (Array.isArray(data)) return data;
                if (data && Array.isArray(data.entries)) return data.entries.map(function(e) { return e.name; });
            }
        } catch(e) {}
        return [];
    }

    async function saveNpcToLorebook(npc, lorebookName) {
        if (!lorebookName) return;
        try {
            // Формируем запись лорбука
            const entry = {
                key: [npc.name],
                content: npc.description,
                comment: 'Living World НПС | ' + npc.type + ' | ' + npc.location,
                enabled: true,
                selective: false,
            };
            // Пробуем через ST API
            if (window.createWorldInfoEntry && typeof window.createWorldInfoEntry === 'function') {
                await window.createWorldInfoEntry(lorebookName, entry);
                return;
            }
            // Через fetch endpoint
            await fetch('/api/worldinfo/create-entry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: lorebookName, entry: entry }),
            });
        } catch(e) {
            console.warn('[LivingWorld] Лорбук save:', e.message);
        }
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

        // Попытка через ST generateRaw
        if (typeof window.generateRaw === 'function') {
            try {
                return await window.generateRaw(prompt, '', false, false, prompt, { max_new_tokens: 400 });
            } catch(e) {
                console.warn('[LivingWorld] generateRaw failed:', e.message);
            }
        }

        // Попытка через ST generate (альтернативная функция)
        if (typeof window.Generate === 'function') {
            try {
                return await window.Generate('quiet', { quietToLoud: false, force_name2: true });
            } catch(e) {
                console.warn('[LivingWorld] Generate failed:', e.message);
            }
        }

        throw new Error('Нет доступного AI эндпоинта. Включи кастомный эндпоинт в настройках Living World.');
    }

    // ============================================================
    //  Настройки
    // ============================================================

    function getSettings() {
        if (!window.extension_settings) window.extension_settings = {};
        if (!window.extension_settings[EXT_NAME]) {
            window.extension_settings[EXT_NAME] = Object.assign({}, DEFAULT_SETTINGS);
        }
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
    //  Визуальная метка в сообщении нарратора
    // ============================================================

    /**
     * Добавляет цветную полоску слева у последнего сообщения нарратора.
     * Не тост, не иконка — тонкая акцентная черта как у Arc Catalyst.
     */
    function markLastNarratorMessage(type) {
        try {
            // Ищем последнее сообщение с именем "Нарратор"
            setTimeout(function() {
                var allMes = document.querySelectorAll('.mes');
                var target = null;
                for (var i = allMes.length - 1; i >= 0; i--) {
                    var nameEl = allMes[i].querySelector('.name_text');
                    if (nameEl && nameEl.textContent.trim() === 'Нарратор') {
                        target = allMes[i];
                        break;
                    }
                }
                if (!target) return;
                if (target.querySelector('.lw-msg-mark')) return; // уже есть

                var colors = {
                    passerby:  '#6a9fd8',
                    hook:      '#c49a2a',
                    important: '#d06060',
                };
                var icons = {
                    passerby:  '👤',
                    hook:      '🔍',
                    important: '⭐',
                };

                var color = colors[type] || '#6a9fd8';
                var icon  = icons[type] || '👤';

                // Полоска слева
                var bar = document.createElement('div');
                bar.className = 'lw-msg-mark';
                bar.title = 'Living World · ' + type;
                bar.style.cssText = [
                    'position:absolute',
                    'left:0',
                    'top:0',
                    'bottom:0',
                    'width:3px',
                    'border-radius:3px 0 0 3px',
                    'background:' + color,
                    'opacity:0',
                    'transition:opacity 0.4s ease',
                    'pointer-events:none',
                ].join(';');

                // Иконка-бейдж рядом с именем
                var badge = document.createElement('span');
                badge.className = 'lw-msg-badge';
                badge.textContent = icon;
                badge.title = 'Living World НПС';
                badge.style.cssText = [
                    'font-size:11px',
                    'margin-left:5px',
                    'opacity:0.7',
                    'vertical-align:middle',
                    'cursor:default',
                ].join(';');

                // Позиционирование — обёртка сообщения должна быть relative
                var mesBlock = target.querySelector('.mes_block') || target;
                mesBlock.style.position = 'relative';
                mesBlock.appendChild(bar);

                var nameEl2 = target.querySelector('.name_text');
                if (nameEl2) nameEl2.after(badge);

                // Анимация появления
                requestAnimationFrame(function() {
                    requestAnimationFrame(function() {
                        bar.style.opacity = '1';
                    });
                });
            }, 500);
        } catch(e) {
            console.warn('[LivingWorld] markLastNarratorMessage:', e);
        }
    }

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

        // Проверяем: ждём ли ручного энкаунтера?
        const isPendingManual = s._pendingManualEncounter;
        if (isPendingManual) {
            s._pendingManualEncounter = false;
            saveSettings();
            msgSinceEncounter = 0;
            await doEncounter(s, chat, chatId);
            return;
        }

        // Случайный энкаунтер
        if (s.encounterEnabled && msgSinceEncounter >= s.encounterEveryN && shouldTrigger(s.encounterChance)) {
            msgSinceEncounter = 0;
            await doEncounter(s, chat, chatId);
        }
    }

    async function doEncounter(s, chat, chatId) {
        const { name, gender, style } = resolveName(s, chat);
        const type     = rollEncounterType(s);
        const location = detectLocation(chat, s);
        const ctx      = chat.slice(-4).map(function(m) { return (m.name || '?') + ': ' + m.mes; }).join('\n');

        try {
            const description = await generateText(s, buildEncounterPrompt(name, location, type, ctx));
            if (!description) return;

            // Убираем возможные <think>...</think> блоки из ответа
            const cleanDesc = description.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            if (!cleanDesc) return;

            // Сохраняем НПС в память
            const npc = { name: name, gender: gender, style: style, type: type, location: location, description: cleanDesc, chatId: chatId, ts: Date.now() };
            saveNpc(npc);

            // Сохраняем в лорбук если нужно
            if (s.saveNpcToLorebook && s.targetLorebook) {
                await saveNpcToLorebook(npc, s.targetLorebook);
            }

            // Добавляем в чат
            injectNarratorMsg(cleanDesc, name, type, chatId);

        } catch(e) {
            console.warn('[LivingWorld] Энкаунтер:', e.message);
            if (typeof window.toastr !== 'undefined') {
                window.toastr.error(e.message, 'Living World');
            }
        }
    }

    function injectNarratorMsg(text, npcName, type, chatId) {
        const emoji = { passerby: '👤', hook: '🔍', important: '⭐' }[type] || '👤';
        const full   = emoji + ' *[' + npcName + ']*\n\n' + text;

        const context = window.SillyTavern ? window.SillyTavern.getContext() : null;
        if (context && typeof context.addOneMessage === 'function') {
            context.addOneMessage({ name: 'Нарратор', is_user: false, is_system: true, mes: full });
            markLastNarratorMessage(type);
            return;
        }

        // Фолбэк
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

    <div class="lw-header" id="lw_header_toggle" style="cursor:pointer;">
        <span>🌍</span>
        <b>Living World</b>
        <small>живой мир · нпс · энкаунтеры</small>
        <span id="lw_collapse_arrow" class="lw-arrow">▲</span>
        <label class="lw-toggle" onclick="event.stopPropagation()">
            <input type="checkbox" id="lw_enabled" />
            <span class="lw-sw"></span>
        </label>
    </div>

    <div id="lw_body">

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
        <!-- Выбор лорбука -->
        <div id="lw_lorebook_row" class="lw-row" style="display:none;">
            <span class="lw-lbl">Лорбук:</span>
            <select id="lw_lorebook_sel" class="lw-sel"></select>
            <button id="lw_reload_lb" class="lw-btn" title="Обновить список">🔄</button>
        </div>
        <div id="lw_lorebook_manual_row" class="lw-row" style="display:none;">
            <span class="lw-lbl">или введи вручную:</span>
            <input type="text" id="lw_lorebook_txt" class="lw-txt" placeholder="Имя лорбука…"/>
        </div>
        <!-- Кнопка: ждать НПС при следующем триггере -->
        <div class="lw-row" style="margin-top:6px;">
            <button id="lw_trigger_now" class="lw-btn lw-btn-accent">⚡ Вызвать НПС при следующем ответе</button>
        </div>
        <div id="lw_trigger_status" class="lw-hint" style="display:none;color:var(--SmartThemeQuoteColor,#7c8cf8);">
            ✓ Ожидаем следующего ответа ИИ…
        </div>
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

    </div><!-- /lw_body -->
</div>`;
    }

    async function populateLorebookDropdown() {
        const sel = $('#lw_lorebook_sel').empty();
        sel.append('<option value="">— выбрать —</option>');
        try {
            const books = await getAvailableLorebooks();
            books.forEach(function(name) {
                sel.append('<option value="' + name + '">' + name + '</option>');
            });
            const s = getSettings();
            if (s.targetLorebook) sel.val(s.targetLorebook);
        } catch(e) {}
    }

    function bindUI() {
        const s = getSettings();

        // Сворачивание
        var collapsed = false;
        $('#lw_header_toggle').on('click', function() {
            collapsed = !collapsed;
            $('#lw_body').toggle(!collapsed);
            $('#lw_collapse_arrow').text(collapsed ? '▼' : '▲');
        });

        $('#lw_enabled').prop('checked', s.enabled).on('change', function() { getSettings().enabled = this.checked; saveSettings(); });

        $('input[name="lw_namestyle"][value="' + s.nameStyle + '"]').prop('checked', true);
        $('input[name="lw_namestyle"]').on('change', function() { getSettings().nameStyle = this.value; saveSettings(); });

        $('input[name="lw_gender"][value="' + s.nameGender + '"]').prop('checked', true);
        $('input[name="lw_gender"]').on('change', function() { getSettings().nameGender = this.value; saveSettings(); });

        $('#lw_enc_on').prop('checked', s.encounterEnabled).on('change', function() { getSettings().encounterEnabled = this.checked; saveSettings(); });
        $('#lw_enc_every').val(s.encounterEveryN).on('input', function() { getSettings().encounterEveryN = parseInt(this.value)||5; saveSettings(); });
        $('#lw_enc_chance').val(s.encounterChance).on('input', function() {
            getSettings().encounterChance = parseInt(this.value)||25;
            $('#lw_chance_val').text(this.value);
            saveSettings();
        });
        $('#lw_chance_val').text(s.encounterChance);

        $('#lw_w_pass').val(s.wPasserby).on('input', function() { getSettings().wPasserby = parseInt(this.value)||60; saveSettings(); });
        $('#lw_w_hook').val(s.wHook).on('input', function() { getSettings().wHook = parseInt(this.value)||30; saveSettings(); });
        $('#lw_w_imp').val(s.wImportant).on('input', function() { getSettings().wImportant = parseInt(this.value)||10; saveSettings(); });

        $('#lw_auto_loc').prop('checked', s.autoDetectLocation).on('change', function() { getSettings().autoDetectLocation = this.checked; saveSettings(); });
        $('#lw_manual_loc').val(s.manualLocation).on('input', function() { getSettings().manualLocation = this.value; saveSettings(); });

        // Лорбук
        var showLorebookRow = function(show) {
            $('#lw_lorebook_row, #lw_lorebook_manual_row').toggle(show);
            if (show) populateLorebookDropdown();
        };
        $('#lw_save_lore').prop('checked', s.saveNpcToLorebook).on('change', function() {
            getSettings().saveNpcToLorebook = this.checked;
            showLorebookRow(this.checked);
            saveSettings();
        });
        showLorebookRow(s.saveNpcToLorebook);

        $('#lw_reload_lb').on('click', function() { populateLorebookDropdown(); });

        $('#lw_lorebook_sel').on('change', function() {
            getSettings().targetLorebook = this.value;
            $('#lw_lorebook_txt').val('');
            saveSettings();
        });

        $('#lw_lorebook_txt').val(s.targetLorebook).on('input', function() {
            getSettings().targetLorebook = this.value;
            $('#lw_lorebook_sel').val('');
            saveSettings();
        });

        // Автономия
        $('#lw_auto_on').prop('checked', s.autonomyEnabled).on('change', function() { getSettings().autonomyEnabled = this.checked; saveSettings(); });
        $('#lw_auto_every').val(s.autonomyEveryN).on('input', function() { getSettings().autonomyEveryN = parseInt(this.value)||8; saveSettings(); });
        $('#lw_know_sep').prop('checked', s.knowledgeSeparation).on('change', function() { getSettings().knowledgeSeparation = this.checked; saveSettings(); });
        $('#lw_timeline').prop('checked', s.timelineEnabled).on('change', function() { getSettings().timelineEnabled = this.checked; saveSettings(); });

        // Эндпоинт
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

        // Ручной энкаунтер — не генерируем сразу, ставим флаг
        $('#lw_trigger_now').on('click', function() {
            const st = getSettings();
            st._pendingManualEncounter = true;
            saveSettings();
            $('#lw_trigger_status').show();
            $('#lw_trigger_now').prop('disabled', true).text('⏳ Ожидание…');
            // Автоматически убираем статус через 60 секунд если не сработало
            setTimeout(function() {
                if (getSettings()._pendingManualEncounter) {
                    getSettings()._pendingManualEncounter = false;
                    saveSettings();
                }
                $('#lw_trigger_status').hide();
                $('#lw_trigger_now').prop('disabled', false).text('⚡ Вызвать НПС при следующем ответе');
            }, 60000);
        });

        // Сбрасываем кнопку когда флаг сработал
        var triggerWatcher = setInterval(function() {
            if (!getSettings()._pendingManualEncounter) {
                $('#lw_trigger_status').hide();
                $('#lw_trigger_now').prop('disabled', false).text('⚡ Вызвать НПС при следующем ответе');
                clearInterval(triggerWatcher);
            }
        }, 500);
    }

    // ============================================================
    //  Инициализация
    // ============================================================

    jQuery(async function() {
        const settingsContainer = document.getElementById('extensions_settings');
        if (settingsContainer) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = buildSettingsHTML();
            settingsContainer.appendChild(wrapper.firstElementChild);
            bindUI();
        }

        if (window.eventSource && window.event_types) {
            window.eventSource.on(window.event_types.MESSAGE_RECEIVED, onMessageReceived);
            window.eventSource.on(window.event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        }

        console.log('[LivingWorld] ✓ v2 Загружено');
    });

})();
